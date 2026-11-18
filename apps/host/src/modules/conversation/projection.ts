// modules/conversation/projection.ts（P04.1）：conversation_read 的模型投影（owner 拥有）。
// 从 runtime/model-results.ts modelResult 的 conversation_read 分支逐字搬迁；语义不变：
// entries 白名单 + 三个 cursor 原样保留（D19：下一步需要的 cursor 不删）。
// 包4 §6.2：宿主生成的 speaker 标签按身份配置投影为双方真实姓名（宿主用户/char），
// 与 conversation_archive 锚点合同同名；labels 缺席=原值直通（第三方/未知不在映射域）。
import { speakerLabelFor, type SpeakerLabels } from '../../identity/speaker-labels.ts';
type Obj = Record<string, any>;
const list = (v: any): any[] => Array.isArray(v) ? v : [];
const objOf = (v: any): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const select = (v: any, keys: string[]): Obj => {
  const out: Obj = {};
  for (const k of keys) if (objOf(v)[k] !== undefined && v[k] !== null && v[k] !== '') out[k] = structuredClone(v[k]);
  return out;
};

/** conversation_read 模型投影（原 modelResult 分支逐字；speaker 仅换双方姓名）。 */
export function projectConversationRead(value: unknown, labels?: SpeakerLabels): Obj {
  const v = objOf(value);
  const out: Obj = { entries: list(v.entries).map((entry: Obj) => {
    const projected = select(entry, ['seq', 'rev', 'speaker', 'at', 'text', 'fragment', 'unread_parts', 'already_in_window', 'included_in_this_request']);
    if (labels && typeof projected.speaker === 'string') projected.speaker = speakerLabelFor(projected.speaker, labels);
    return projected;
  }) };
  for (const k of ['next_cursor', 'older_cursor', 'newer_cursor']) if (v[k]) out[k] = structuredClone(v[k]);
  return out;
}
