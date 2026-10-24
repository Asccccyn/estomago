// modules/conversation/projection.ts（P04.1）：conversation_read 的模型投影（owner 拥有）。
// 从 runtime/model-results.ts modelResult 的 conversation_read 分支逐字搬迁；语义不变：
// entries 白名单 + 三个 cursor 原样保留（D19：下一步需要的 cursor 不删）。
type Obj = Record<string, any>;
const list = (v: any): any[] => Array.isArray(v) ? v : [];
const objOf = (v: any): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const select = (v: any, keys: string[]): Obj => {
  const out: Obj = {};
  for (const k of keys) if (objOf(v)[k] !== undefined && v[k] !== null && v[k] !== '') out[k] = structuredClone(v[k]);
  return out;
};

/** conversation_read 模型投影（原 modelResult 分支逐字）。 */
export function projectConversationRead(value: unknown): Obj {
  const v = objOf(value);
  const out: Obj = { entries: list(v.entries).map((x: Obj) => select(x, ['seq', 'speaker', 'at', 'text', 'fragment'])) };
  for (const k of ['next_cursor', 'older_cursor', 'newer_cursor']) if (v[k]) out[k] = structuredClone(v[k]);
  return out;
}
