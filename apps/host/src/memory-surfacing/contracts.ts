// 自动记忆浮现 · 合同层（EST_MARIPOSA_AUTO_SURFACING_V1 · 2026-10-19）。
// P3（2026-10-21）：源/目标同消息同修订，接受起绝对总 deadline；初次
// 交付只含日期+事件正文原样全文+技术短 ref；用户说明原句 UTF-8 字节
// 锁定；错误不整串发给主模型（空交付+私有运行状态）。
import { createHash } from 'node:crypto';

/** 唯一主模型说明（prompts/primary_memory_notice.txt，60 字节无 BOM 无
 * 尾换行；sha256=b56cadf7…f43d41b）。一个非空浮现包只出现一次。 */
export const PRIMARY_MEMORY_NOTICE = '这是你的记忆，是你和宿主用户之前发生的事。';

export const PRIMARY_MEMORY_NOTICE_SHA256 = 'b56cadf72a9270384d13d38903c6f777cf701bfb8d8ee19fe7d019599f43d41b';

export function verifyNoticeBytes(): { ok: boolean; sha256: string; bytes: number } {
  const buf = Buffer.from(PRIMARY_MEMORY_NOTICE, 'utf8');
  const sha = createHash('sha256').update(buf).digest('hex');
  return { ok: sha === PRIMARY_MEMORY_NOTICE_SHA256 && buf.length === 60, sha256: sha, bytes: buf.length };
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
  text: string;               // 完整注入块（[回忆浮现]…[/回忆浮现]）
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

/** 渲染注入块（docs/04 投影示例；正文逐字原样，日期取真实事件日期，
 * 不确定日期原样表达"不确定"）。 */
export function renderAugmentation(items: SurfaceItem[], refs: Map<string, string>): string {
  if (items.length === 0) return '';
  const lines: string[] = ['[回忆浮现]', PRIMARY_MEMORY_NOTICE];
  for (const it of items) {
    const ref = refs.get(it.event_id) ?? 'sf_unknown';
    lines.push('', `[记忆引用 ${ref}]`, `时间：${it.memory_date ?? '不确定'}`, `事件：${it.event_text}`);
  }
  lines.push('[/回忆浮现]');
  return lines.join('\n');
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
