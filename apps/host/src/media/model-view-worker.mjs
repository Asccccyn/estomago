// Downscales one raster image for the model. stdin carries the original bytes; argv[2] is
// its mime type and argv[3] the pixel budget. stdout is "<mime>\n<width>x<height>\n" followed
// by the encoded view. Any other exit sends the original: 65 when the image is within the
// budget, 66 when its declared size is too large to decode safely, 1 when it cannot be read.
const MAX_PIXELS = Number(process.argv[3]);
const JPEG_QUALITY = 82;
// A small file can claim billions of pixels, so the size in its header is checked before decoding.
const DECODE_LIMIT = 64_000_000;

/** Pixel size from the file header alone. */
function rasterSize(bytes, mime) {
  try {
    if (mime === 'image/png' && bytes.length >= 24) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    if (mime === 'image/webp' && bytes.length >= 30) {
      const chunk = bytes.toString('latin1', 12, 16);
      if (chunk === 'VP8X') return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
      if (chunk === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
      }
      if (chunk === 'VP8 ') return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
      return null;
    }
    if (mime === 'image/jpeg') {
      let offset = 2;
      while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1];
        // Start of image, restart markers and padding stand alone; every other segment carries a length.
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        // SOF0..SOF15 hold the frame size, except the Huffman and arithmetic tables that share the range.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          if (offset + 9 > bytes.length) return null;
          return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
        }
        offset += 2 + bytes.readUInt16BE(offset + 2);
      }
    }
  } catch { /* reported as unreadable below */ }
  return null;
}

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const size = rasterSize(bytes, process.argv[2]);
  if (!size) {
    process.exitCode = 1;
  } else if (size[0] * size[1] <= MAX_PIXELS) {
    process.exitCode = 65;
  } else if (size[0] * size[1] > DECODE_LIMIT) {
    process.exitCode = 66;
  } else {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    // A JPEG carrying an EXIF orientation loads already turned, so the view keeps the upright size.
    let image = await loadImage(bytes);
    const scale = Math.sqrt(MAX_PIXELS / (image.width * image.height));
    let width = Math.max(1, Math.round(image.width * scale));
    let height = Math.max(1, Math.round(image.height * scale));
    // Rounding both sides can overshoot the budget by a few pixels.
    if (width * height > MAX_PIXELS && width / height >= image.width / image.height) width -= 1;
    else if (width * height > MAX_PIXELS) height -= 1;
    // Halve while more than twice oversized: one large jump skips rows of pixels and leaves jagged edges.
    while (image.width >= width * 2 && image.height >= height * 2) {
      const half = createCanvas(Math.max(width, Math.round(image.width / 2)), Math.max(height, Math.round(image.height / 2)));
      const context = half.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, half.width, half.height);
      image = half;
    }
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);
    const mime = process.argv[2] === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    process.stdout.write(`${mime}\n${width}x${height}\n`);
    process.stdout.write(mime === 'image/jpeg' ? await canvas.encode('jpeg', JPEG_QUALITY) : await canvas.encode('png'));
  }
} catch {
  process.exitCode = 1;
}
