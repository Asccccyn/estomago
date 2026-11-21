import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./static-svg-worker.mjs', import.meta.url));
export const SVG_INPUT_LIMIT = 256 * 1024;

/** null means the document is outside the renderer's verified static subset. */
export async function renderStaticSvg(bytes: Uint8Array): Promise<Buffer | null> {
  if (bytes.byteLength > SVG_INPUT_LIMIT) return null;
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [WORKER], {
      encoding: 'buffer', timeout: 3000, maxBuffer: 5 * 1024 * 1024, killSignal: 'SIGKILL',
      env: { DISABLE_SYSTEM_FONTS_LOAD: '1' },
    }, (error, stdout) => {
      if (!error) resolve(stdout);
      else if (error.code === 65) resolve(null);
      else reject(new Error('静态 SVG 的 PNG 派生暂不可用'));
    });
    child.stdin?.on('error', () => { /* 子进程提前结束时由回执分支报告。 */ });
    child.stdin?.end(bytes);
  });
}
