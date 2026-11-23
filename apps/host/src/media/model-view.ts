import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./model-view-worker.mjs', import.meta.url));

/** The largest raster sent to the model as it is. Above it the model receives a downscaled view.
 *  Image tokens follow pixel area (about 750 pixels per token), so this keeps an image near 1,000 tokens. */
export const MODEL_IMAGE_MAX_PIXELS = 750_000;
const CACHE_BYTES = 64 * 1024 * 1024;

export type Raster = { bytes: Buffer; mime: string };

// Insertion order is least recently used first.
const cache = new Map<string, Raster>();
let cachedBytes = 0;

export function clearModelViewCache(): void {
  cache.clear();
  cachedBytes = 0;
}

function remember(assetId: string, view: Raster): Raster {
  cache.set(assetId, view);
  cachedBytes += view.bytes.byteLength;
  while (cachedBytes > CACHE_BYTES && cache.size > 1) {
    const [oldest, dropped] = cache.entries().next().value as [string, Raster];
    cache.delete(oldest);
    cachedBytes -= dropped.bytes.byteLength;
  }
  return view;
}

function renderView(source: Raster): Promise<Raster> {
  if (source.mime !== 'image/jpeg' && source.mime !== 'image/png' && source.mime !== 'image/webp') return Promise.resolve(source);
  return new Promise(resolve => {
    const child = execFile(process.execPath, [WORKER, source.mime, String(MODEL_IMAGE_MAX_PIXELS)], {
      encoding: 'buffer', timeout: 10_000, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL',
      env: { DISABLE_SYSTEM_FONTS_LOAD: '1' },
    }, (error, stdout) => {
      // A view only saves tokens. Any failure sends the original rather than dropping or stalling the image.
      const header = error ? null : /^image\/[a-z]+\n\d+x\d+\n/.exec(stdout.subarray(0, 64).toString('latin1'));
      if (!header || stdout.length <= header[0].length) return resolve(source);
      resolve({ mime: header[0].split('\n')[0]!, bytes: Buffer.from(stdout.subarray(header[0].length)) });
    });
    child.stdin?.on('error', () => { /* an early exit is reported through the callback */ });
    child.stdin?.end(source.bytes);
  });
}

/** An asset keeps one view for the life of the process, so every request in a window
 *  materializes its history identically and the sent prefix stays append-only. */
export async function modelImageView(assetId: string, source: Raster): Promise<Raster> {
  const hit = cache.get(assetId);
  if (hit) {
    cache.delete(assetId);
    cache.set(assetId, hit);
    return hit;
  }
  return remember(assetId, await renderView(source));
}
