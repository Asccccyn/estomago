import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const WORKER = fileURLToPath(new URL('./static-svg-worker.mjs', import.meta.url));
export const SVG_INPUT_LIMIT = 256 * 1024;

/**
 * Classification and rendering are deliberately separate. An unsupported static feature
 * must not turn an image into a code creation merely because no safe PNG can be produced.
 */
export function classifySvg(bytes: Uint8Array): 'image' | 'code' | 'unknown' {
  try {
    const xml = new TextDecoder('utf8', { fatal: true }).decode(bytes)
      .replace(/^\uFEFF?\s*(?:<\?xml\s+[^?]*\?>)?\s*/u, '');
    if (!xml.startsWith('<svg') || /<\?|<!DOCTYPE|<!ENTITY/iu.test(xml) || XMLValidator.validate(xml) !== true) return 'unknown';
    const tree = new XMLParser({
      preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false,
      parseAttributeValue: false, trimValues: false, processEntities: false,
    }).parse(xml) as Array<Record<string, unknown>>;
    if (tree.length !== 1 || !Array.isArray(tree[0]?.svg)) return 'unknown';
    const queue = [...tree];
    while (queue.length) {
      const node = queue.pop()!;
      const tag = Object.keys(node).find(key => key !== ':@');
      if (!tag) continue;
      const localName = tag.split(':').pop()!;
      if (['script', 'animate', 'animateMotion', 'animateTransform', 'set', 'discard', 'foreignObject', 'a'].includes(localName)) return 'code';
      const attrs = node[':@'] as Record<string, unknown> | undefined;
      if (Object.entries(attrs ?? {}).some(([name, value]) =>
        /^on/i.test(name) || (name === 'style' && /(?:^|;)\s*(?:-\w+-)?(?:animation|transition)(?:-[\w-]+)?\s*:/i.test(String(value))))) return 'code';
      if (localName === 'style' && /@(?:-\w+-)?keyframes\b|(?:animation|transition)(?:-[\w-]+)?\s*:/i.test(JSON.stringify(node[tag]))) return 'code';
      const children = node[tag];
      if (Array.isArray(children)) queue.push(...children);
    }
    return 'image';
  } catch { return 'unknown'; }
}

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
