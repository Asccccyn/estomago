// 自动记忆浮现 · 合同层（EST_MARIPOSA_AUTO_SURFACING_V1 · 2026-10-19）。
// P3（2026-10-21）：源/目标同消息同修订，接受起绝对总 deadline；初次
// 交付仅含日期与事件正文全文；ref/版本等保留后端，不进入模型正文。
// 已冻结旧包原样保留；错误不整串发给主模型。
import { createHash } from 'node:crypto';
import { validateAbsoluteIso } from '../util/time.ts';

/** Legacy notice: old frozen deliveries stay unchanged; new payloads omit it. */
export const PRIMARY_MEMORY_NOTICE = '这是你的回忆，是你和宿主用户过去发生的事，不是现在正在发生的事。';
export const PRIMARY_MEMORY_NOTICE_SHA256 = createHash('sha256').update(PRIMARY_MEMORY_NOTICE, 'utf8').digest('hex');
export function verifyNoticeBytes(): { ok: boolean; sha256: string; bytes: number } {
  const buf = Buffer.from(PRIMARY_MEMORY_NOTICE, 'utf8');
  const sha = createHash('sha256').update(buf).digest('hex');
  return { ok: sha === PRIMARY_MEMORY_NOTICE_SHA256, sha256: sha, bytes: buf.length };
}

// —— E 作业状态机（docs/02；CAS 边校验 state+generation+source_revision+target_revision）——
export type SurfacingJobState =
  | 'pending' | 'preparing' | 'prepared' | 'empty' | 'rejected' | 'blocked' | 'unknown_cost'
  | 'target_bound' | 'validating' | 'ready' | 'timed_out' | 'stale'
  | 'reserved' | 'dispatch_started' | 'retained' | 'attempted_not_retained'
  // 任意尚未正式发送阶段可进入：
  | 'cancelled' | 'superseded' | 'missed_target' | 'expired';

export type EventHypothesis = {
  hypothesis_id: string;
  start_cp: number;
  end_cp: number;
  inherited_date_span: { start_cp: number; end_cp: number } | null;
};

export type SurfaceItem = {
  event_id: string;
  memory_id: string;
  memory_version: string;
  memory_date: string | null;
  date_confidence: string | null;
  event_text: string;
  body_hash: string;
  detail_ref: string;
};

export type FrozenAugmentation = {
  deliveryId: string;
  text: string;               // 完整冻结投影（仅日期与事件正文）
  items: SurfaceItem[];       // 实际入选赢家（全覆盖/预算过滤后）
  memoryRefs: Array<{ ref: string; detail_ref: string; event_id: string }>;
  payloadHash: string;
};

/**
 * R05（审计 J02）：后台浮现生命周期事件（稳定 SSE 合同）。
 * 只含身份/状态/原因码——正文（event_text/payload_text/items/ref 映射）
 * 绝不进事件（不泄正文红线）；事件是 DB 正本的投影，丢失可由作业表
 * 重建，不构成数据正本。prepare/reject/budget/timeout/cancel/重复派发
 * /恢复各自经状态迁移携带身份出现。
 */
export type SurfaceJobEventPayload = {
  job_id: string;
  conversation_id: string;
  from: SurfacingJobState;
  to: SurfacingJobState;
  reason_code: string | null;
  source_message_id: string;
  target_message_id: string | null;
  window_id: string | null;
  attempt_id: string | null;
  delivery_id: string | null;
  m_operation_id: string | null;
};

/** Event time only; never use storage/recall timestamps or invent midnight. */
function eventTimeText(item: SurfaceItem): string {
  const value = item.memory_date;
  if (!value) return '不确定';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return validateAbsoluteIso(`${value}T00:00:00Z`).ok ? value : '不确定';
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/.exec(value);
  if (local) return validateAbsoluteIso(`${local[1]}T${local[2]}:00Z`).ok ? `${local[1]} ${local[2]}` : '不确定';
  if (!validateAbsoluteIso(value).ok) return '不确定';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** 渲染注入块（docs/04 投影示例；正文逐字原样，日期取真实事件日期，
 * 不确定日期以 null 表达）。 */
export function projectSurfacedMemory(item: SurfaceItem): { date: string | null; text: string } {
  const date = eventTimeText(item);
  return { date: date === '不确定' ? null : date, text: item.event_text };
}

export function renderAugmentation(items: SurfaceItem[], refs?: Map<string, string>): string {
  if (items.length === 0) return '';
  return JSON.stringify({ memories: items.map(item => {
    const ref = refs?.get(item.event_id) ?? (item.detail_ref ? memoryRefFor(item.detail_ref) : null);
    if (!ref) throw new Error('SURFACE_REFERENCE_MISSING');
    return { memory_ref: ref, ...projectSurfacedMemory(item) };
  }) });
}

/** 短 handle：内存安全的不透明引用（完整 UUID/版本/hash/分数不进模型文本）。 */
export function memoryRefFor(detailRef: string): string {
  return 'sf_' + createHash('sha256').update(detailRef).digest('hex').slice(0, 16);
}

export function estimateTokens(text: string): number {
  // 本地粗估（bytes/3，中文为主语料经验值）——注明 estimated；不调用任何
  // 带主模型 key 的 token API（docs/04 预算节）。
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}


/** The current OpenRouter/Opus route has no verified append-only host-data
 * transport. SDK has no host-tool bridge. Never silently switch providers. */
export function supportsSurfacingTransport(provider: string): boolean {
  return provider === 'deepseek';
}
