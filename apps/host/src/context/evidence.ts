// §33：Reasoning Context Leakage Canary 支持——递归扫描任意 DTO/JSON 中是否出现 canary。
export function deepScanCanary(value: unknown, canary: string): number {
  let hits = 0;
  const visit = (v: unknown, depth: number): void => {
    if (depth > 12) return;
    if (typeof v === 'string') {
      let idx = v.indexOf(canary);
      while (idx >= 0) { hits += 1; idx = v.indexOf(canary, idx + canary.length); }
      return;
    }
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (v && typeof v === 'object') { for (const x of Object.values(v as Record<string, unknown>)) visit(x, depth + 1); }
  };
  visit(value, 0);
  return hits;
}
