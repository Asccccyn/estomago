// 触发假设提取（docs/03 §1）：分句是检索假设不是判定事实。
// 程序只做有限分句/日期解析；事件粒度确认归 judge。短句不按长度
// 一刀切（R09）；thinking/工具输出/旧浮现包不可作为查询原话（R46）。
import type { EventHypothesis } from './contracts.ts';

/** Hypotheses are spans, never event verdicts. The Judge must confirm identity
 * and grouping; punctuation alone cannot authorize a memory. */
export function extractHypotheses(text: string, maxHypotheses = 24): EventHypothesis[] {
  const points = [...(text ?? '')];
  if (points.join('').trim().length === 0) return [];
  const out: EventHypothesis[] = [];
  let start = 0;
  let inherited: EventHypothesis['inherited_date_span'] = null;
  const push = (end: number) => {
    const clause = points.slice(start, end).join('');
    if (clause.trim()) {
      const date = /(?:\d{4}[-/.年])?\d{1,2}[-/.月]\d{1,2}[日号]?/.exec(clause);
      const explicit = date ? { start_cp: start + [...clause.slice(0, date.index)].length,
        end_cp: start + [...clause.slice(0, date.index + date[0].length)].length } : null;
      out.push({ hypothesis_id: `h${out.length + 1}`, start_cp: start, end_cp: end,
        inherited_date_span: explicit ? null : inherited });
      if (explicit) inherited = explicit;
    }
    start = end;
  };
  for (let i = 0; i < points.length; i++) {
    if (/[，,。！？!?\n；;]/.test(points[i])) {
      push(i + 1);
      // Preserve the overflow signal. The server rejects the entire request;
      // silently truncating would misrepresent event coverage.
      if (out.length > maxHypotheses) return out;
    }
  }
  if (start < points.length) push(points.length);
  return out;
}

/** 源语境：该用户消息 + 必要近邻真实原话（不读 thinking/工具历史，
 * 不把旧 surfacing 包回传检索；不跨房间）。 */
export function buildRecentDialogue(
  messages: Array<{ message_id: string; revision: number; role: 'owner' | 'assistant'; text: string; sequence: number }>,
  limit = 6,
): Array<{ message_id: string; revision: number; role: 'owner' | 'assistant'; text: string; sequence: number }> {
  return messages
    .filter((x) => x.role === 'owner' || x.role === 'assistant')
    .slice(-limit);
}

// ———————————————————————————————————————————————————————————————————————
// P1 回忆意图门（她 2026-10-20 裁定）：纯函数、零 I/O。普通聊天在这里直接
// 放行（skip），不登记浮现作业、不触发 Mariposa 检索/Dense/JEV；归档 outbox
// 是另一条路径不受影响。只有明确回忆才进入既有 surfacing 流程。
//
// 两段式：先以 recentState=null 调用——绝大多数消息在此得到 skip/lookup，
// 零数据库读取；只有省略表达（"后来呢"）返回 needs_context，服务层才去读
// 有界近期状态并二次调用。
//
// 规则 = 审计 B 基线（整句口径原样移植，保证不倒退）∪ 一条独立强信号
// （按分句）：明确历史问句 := 过去指代 ∧ 疑问标记 ∧ (回忆动词 ∨ 过去事件
// 谓词) ∧ ¬未来领句 ∧ ¬否定/玩笑/写入守卫。强信号是**组合结构**（体标记
// +疑问），不是事件名词表——4 条漏句（那件事 / 去海边…的事 / 做成了什么）
// 正是名词表覆盖不到的。
//
// 门只判"要不要查"，不判记忆真伪；可不可以交付由 Mariposa 合同决定。

export type RecallGateAction = 'skip' | 'lookup' | 'needs_context';

export type RecallGateReason =
  | 'empty' | 'guard_negation' | 'no_recall_signal'
  | 'baseline_rule' | 'explicit_history_question'
  | 'followup_needs_context' | 'followup_bound' | 'followup_unbound';

/** 服务层只在 needs_context 时装配；只含用户自己消息的身份信息，不含模型猜测。 */
export type RecentRecallState = {
  /** 最近 ≤2 个已接受 owner 轮里，已确定回忆对象（prepared）的作业；无则 null。 */
  boundLookup: { sourceMessageId: string; sourceRevision: number; sourceSequence: number } | null;
};

export type ExplicitDate = { year: number | null; month: number; day: number };

export type RecallGateResult = {
  action: RecallGateAction;
  reason: RecallGateReason;
  /** 原话里的显式日期（不补年份、不解析相对日期） */
  explicitDates: ExplicitDate[];
  /** 命中的过去指代/事件锚点词（诊断用，不持久化） */
  eventAnchors: string[];
  boundContext: RecentRecallState['boundLookup'];
};

const CN_NUM = '〇零一二两三四五六七八九十';
const CN_DIGIT: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnInt(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (s.includes('十')) {
    const [head, tail] = s.split('十');
    if ((head && !(head in CN_DIGIT)) || (tail && !(tail in CN_DIGIT))) return null;
    return (head ? CN_DIGIT[head] : 1) * 10 + (tail ? CN_DIGIT[tail] : 0);
  }
  let total = 0;
  for (const ch of s) {
    if (!(ch in CN_DIGIT)) return null;
    total = total * 10 + CN_DIGIT[ch];
  }
  return total;
}

const FULL_CN = new RegExp(`(\\d{4}|[${CN_NUM}]{4})\\s*年\\s*(\\d{1,2}|[${CN_NUM}]{1,3})\\s*月\\s*(\\d{1,2}|[${CN_NUM}]{1,3})\\s*[日号]?`, 'g');
const FULL_NUM = /(?<![\dA-Za-z])(\d{4})[-/.．](\d{1,2})[-/.．](\d{1,2})(?![\dA-Za-z])/g;
const MD_CN = new RegExp(`(?<![\\d${CN_NUM}])(\\d{1,2}|[${CN_NUM}]{1,3})\\s*月\\s*(\\d{1,2}|[${CN_NUM}]{1,3})\\s*[日号]?`, 'g');
const MD_NUM = /(?<![\dA-Za-z.．/-])(\d{1,2})[.．/](\d{1,2})(?![\dA-Za-z.．/-])/g;

const plausible = (y: number | null, m: number | null, d: number | null): boolean =>
  m !== null && d !== null && m >= 1 && m <= 12 && d >= 1 && d <= 31 && (y === null || (y >= 1900 && y <= 2200));

/** 与 Mariposa facts.extract_dates 同族口径（点分形式按 月.日；字母前后缀不作日期）。 */
export function extractExplicitDates(text: string): ExplicitDate[] {
  const out: ExplicitDate[] = [];
  const taken: Array<[number, number]> = [];
  const free = (s: number, e: number) => taken.every(([a, b]) => e <= a || s >= b);
  const scan = (re: RegExp, withYear: boolean) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const s = m.index; const e = s + m[0].length;
      const y = withYear ? cnInt(m[1]) : null;
      const mo = cnInt(withYear ? m[2] : m[1]);
      const d = cnInt(withYear ? m[3] : m[2]);
      if (plausible(y, mo, d) && free(s, e)) {
        taken.push([s, e]);
        out.push({ year: y, month: mo as number, day: d as number });
      }
    }
  };
  scan(FULL_CN, true); scan(FULL_NUM, true); scan(MD_CN, false); scan(MD_NUM, false);
  const seen = new Set<string>();
  return out.filter((c) => { const k = `${c.year}-${c.month}-${c.day}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// —— 审计 B 基线（整句口径，原样移植；不改词表以保证不倒退）——
const GUARD_NEGATION = /不用回忆|算了|忘掉过去|编的故事|记忆大师/;
const B_HISTORY = /去年|前年|以前|上次|第一次|当时|那次|那天|那场|那件|那两|那两件|那两次/;
const B_EVENT = /旅行|搬家|见面|项目|婚礼|吵架|礼物|约会|结婚|记忆库|纪念日|聚会|生日|看海/;
const B_QUESTION = /吗|什么|谁|哪|怎么|为什么|发生|记录|分别|来着|回想|查一下|查查/;
const B_DATE = /\d{1,4}[-/.年]\d{1,2}|\d{1,2}月\d{1,2}|七月九号/;
const B_WRITE = /记下|提醒我|别忘了/;
const B_WRITE_EXEMPT = /先查|上次.*[谁哪]/;
const B_FUTURE = /明天|下周|下次|明年/;

function baselineRule(t: string): boolean {
  const history = B_HISTORY.test(t);
  const event = B_EVENT.test(t);
  const question = B_QUESTION.test(t);
  const date = B_DATE.test(t);
  if (B_WRITE.test(t) && !B_WRITE_EXEMPT.test(t)) return false;
  if (B_FUTURE.test(t) && !question) return false;
  return (history && event && question) || (date && event && question) || (/还记得|回想/.test(t) && history && event);
}

// —— 强信号：明确历史问句（按分句）——
const PAST_REF = /去年|前年|以前|上次|第一次|当时|那时候|那阵子|那段|那次|那天|那场|那件|那回|那两/g;
const INTERROGATIVE = /吗|什么|啥|谁|哪|怎么|为什么|几|呢|多少/;
const RECALL_VERB = /还记得|记得|记不记得|想起|回想|回忆|有没有印象|印象/;
const PAST_EVENT_PREDICATE = /[了过]\s*(什么|啥|谁|哪|几|多少)|怎么.{0,8}的|发生|经过|来着/;
const FUTURE_LEAD = /^(?:你|我|我们|咱们|请|帮我|麻烦)?\s*(?:明天|后天|下周|下个月|明年|下次|以后|待会|等会|过会)/;
const CLAUSE_SPLIT = /[。！？!?\n；;，,、]/;

function isPastDate(d: ExplicitDate, now: Date): boolean {
  if (d.year === null) return false;                       // 无年份：过去/未来不可判，不作强信号
  const ny = now.getFullYear(); const nm = now.getMonth() + 1; const nd = now.getDate();
  if (d.year !== ny) return d.year < ny;
  return d.month < nm || (d.month === nm && d.day < nd);
}

function explicitHistoryQuestion(clause: string, now: Date): { hit: boolean; anchors: string[] } {
  const c = clause.trim();
  if (!c) return { hit: false, anchors: [] };
  if (B_WRITE.test(c) && !B_WRITE_EXEMPT.test(c)) return { hit: false, anchors: [] };
  if (FUTURE_LEAD.test(c)) return { hit: false, anchors: [] };
  const anchors = c.match(PAST_REF) ?? [];
  const pastDates = extractExplicitDates(c).filter((d) => isPastDate(d, now));
  const pastRef = anchors.length > 0 || pastDates.length > 0;
  if (!pastRef) return { hit: false, anchors: [] };
  if (!INTERROGATIVE.test(c)) return { hit: false, anchors };
  if (!(RECALL_VERB.test(c) || PAST_EVENT_PREDICATE.test(c))) return { hit: false, anchors };
  return { hit: true, anchors: [...anchors, ...pastDates.map((d) => `${d.year}-${d.month}-${d.day}`)] };
}

// —— 省略表达：只能靠近期状态解析 ——
const FOLLOWUP = /^(?:后来呢|然后呢|那次呢|那天呢|那件事呢|还有呢|为什么|在哪里|在哪|他当时怎么说|你当时怎么说|是什么时候|什么时候的事)[？?。]?$/;

/**
 * 纯函数门。recentState=null 为第一段：普通聊天与明确回忆都在此定夺，只有
 * 省略表达返回 needs_context。第二段传入有界近期状态：有已确定回忆对象的
 * prepared 作业才延续（lookup），否则 skip——之前没命中、多候选悬置、换题
 * 都不自动延续。
 */
export function detectRecallNeed(text: string, recentState: RecentRecallState | null, now: Date): RecallGateResult {
  const t = (text ?? '').trim();
  const none = (reason: RecallGateReason): RecallGateResult =>
    ({ action: 'skip', reason, explicitDates: [], eventAnchors: [], boundContext: null });
  if (!t) return none('empty');
  if (GUARD_NEGATION.test(t)) return none('guard_negation');

  if (FOLLOWUP.test(t)) {
    if (recentState === null) {
      return { action: 'needs_context', reason: 'followup_needs_context', explicitDates: [], eventAnchors: [], boundContext: null };
    }
    if (recentState.boundLookup) {
      return { action: 'lookup', reason: 'followup_bound', explicitDates: [], eventAnchors: [], boundContext: recentState.boundLookup };
    }
    return none('followup_unbound');
  }

  const dates = extractExplicitDates(t);
  if (baselineRule(t)) {
    return { action: 'lookup', reason: 'baseline_rule', explicitDates: dates, eventAnchors: t.match(PAST_REF) ?? [], boundContext: null };
  }
  for (const clause of t.split(CLAUSE_SPLIT)) {
    const r = explicitHistoryQuestion(clause, now);
    if (r.hit) {
      return { action: 'lookup', reason: 'explicit_history_question', explicitDates: dates, eventAnchors: r.anchors, boundContext: null };
    }
  }
  return none('no_recall_signal');
}
