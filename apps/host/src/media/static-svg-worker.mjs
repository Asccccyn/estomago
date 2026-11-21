import { XMLParser, XMLValidator } from 'fast-xml-parser';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_SIDE = 1024;
const STATIC_TAGS = new Set([
  'svg', 'g', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'title', 'desc', 'text', 'tspan',
]);
const PRESENTATION = new Set([
  'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity',
  'clip-path', 'clip-rule', 'display', 'visibility', 'stop-color', 'stop-opacity', 'color',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'text-anchor',
  'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'word-spacing', 'text-decoration',
]);
const STATIC_ATTRIBUTES = new Set([
  ...PRESENTATION, 'id', 'version', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'd', 'points', 'pathLength', 'transform',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'clipPathUnits', 'preserveAspectRatio', 'vector-effect',
  'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'xml:space',
]);
const parser = new XMLParser({
  preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false,
  parseAttributeValue: false, trimValues: false, processEntities: true,
});

function safeValue(value) {
  if (typeof value !== 'string' || value.length > 32768 || /[<>&\\@\u0000-\u0008\u000b\u000c\u000e-\u001f]|\/\*|\*\//u.test(value)) return false;
  return !/url\s*\(/i.test(value) || /^url\(\s*#[A-Za-z_][\w.-]*\s*\)$/.test(value);
}

function safeStyle(value) {
  return typeof value === 'string' && value.length <= 2048 && value.split(';').every(declaration => {
    if (declaration.trim() === '') return true;
    const [name, property, extra] = declaration.split(':');
    return extra === undefined && PRESENTATION.has(name.trim()) && safeValue(property?.trim());
  });
}

function extent(value) {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(value)) return null;
  const n = Number.parseFloat(value);
  return n > 0 && n <= 1e6 ? n : null;
}

function staticDocument(source) {
  const xml = source.replace(/^\uFEFF?\s*(?:<\?xml\s+[^?]*\?>)?\s*/u, '');
  // Input to the native decoder has no processing instructions, declarations, or entities from a DTD.
  if (!xml.startsWith('<svg') || /<\?|<!/u.test(xml) || XMLValidator.validate(xml) !== true) return null;
  const tree = parser.parse(xml);
  if (tree.length !== 1 || !Array.isArray(tree[0].svg)) return null;
  let count = 0;
  function verify(node, depth, parentTag) {
    const tag = Object.keys(node).find(key => key !== ':@');
    if (tag === '#text') {
      return typeof node[tag] === 'string' && node[tag].length <= 32768
        && (node[tag].trim() === '' || ['title', 'desc', 'text', 'tspan'].includes(parentTag));
    }
    if (!STATIC_TAGS.has(tag) || (depth > 0 && tag === 'svg') || depth > 24 || ++count > 1600) return false;
    for (const [name, value] of Object.entries(node[':@'] ?? {})) {
      if (depth === 0 && name === 'xmlns' && value === SVG_NS) continue;
      if (name === 'style' ? !safeStyle(value) : !STATIC_ATTRIBUTES.has(name) || !safeValue(value)) return false;
    }
    return Array.isArray(node[tag]) && node[tag].every(child => verify(child, depth + 1, tag));
  }
  const original = tree[0][':@'];
  if (original?.xmlns !== SVG_NS || !verify(tree[0], 0, '')) return null;
  const box = typeof original.viewBox === 'string' ? original.viewBox.trim().split(/[\s,]+/u).map(Number) : null;
  if (box && (box.length !== 4 || box.some(value => !Number.isFinite(value) || Math.abs(value) > 1e6) || box[2] <= 0 || box[3] <= 0)) return null;
  const width = extent(original.width) ?? box?.[2];
  const height = extent(original.height) ?? box?.[3];
  if (!width || !height) return null;
  const scale = Math.min(1, MAX_SIDE / width, MAX_SIDE / height);
  const frame = {
    ...original, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)),
    viewBox: box ? box.join(' ') : `0 0 ${width} ${height}`,
  };
  const root = /^<svg(?=[\s/>])(?:[^"'>]|"[^"]*"|'[^']*')*>/u.exec(xml)?.[0];
  if (!root) return null;
  const attrs = Object.entries(frame).map(([name, value]) => `${name}="${String(value).replaceAll('"', '&quot;')}"`).join(' ');
  return `<svg ${attrs}${root.endsWith('/>') ? '/>' : '>'}${xml.slice(root.length)}`;
}

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const svg = staticDocument(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (svg === null) {
    process.exitCode = 65;
  } else {
    // Only vetted static SVG bytes go to the native renderer.
    const { createCanvas, loadImage, GlobalFonts } = await import('@napi-rs/canvas');
    // Only a vetted text document needs font discovery. Load OS fonts, never a
    // document-provided file or web font; the worker still runs under its input/time limits.
    if (/<(?:text|tspan)\b/u.test(svg)) GlobalFonts.loadSystemFonts();
    const image = await loadImage(Buffer.from(svg));
    if (!image.width || !image.height || image.width > MAX_SIDE || image.height > MAX_SIDE) throw new Error('invalid SVG viewport');
    const canvas = createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);
    process.stdout.write(canvas.toBuffer('image/png'));
  }
} catch {
  process.exitCode = 1;
}
