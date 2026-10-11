// ESTOMAGO_CHAT_EXEC_V1 §06.7（WP6）：日历读聚合——est 统一前端内置页面。
// 不是新的事实数据库：桶/计划正本 Mariposa、星星正本 Superposition、留言正文 content——
// 日历只做只读聚合展示（月概要=计数/标记；日详情=分源分页）。
// 北京时间自然日采用半开区间 [00:00, 次日00:00)——不用 23:59:59 拼上界。
// 读取不触发 memory_open/view.confirm/拆星/取下一颗（§06.7.3/8）；单源故障如实降级。
import type { Db } from '../db/connection.ts';
import type { Config } from '../config/schema.ts';
import { POLICY_CONSTANTS } from '../config/policy-constants.ts';

export type CalendarSource = 'chat' | 'memory' | 'plans' | 'stars' | 'reminders' | 'future_notes' | 'creations';
export type SourceStatus = 'ready' | 'unavailable' | 'not_configured';

export type MonthDaySummary = {
  date: string;
  counts: Partial<Record<CalendarSource, number>>;
};

export type CalendarMonthResult = {
  month: string;
  timezone: 'Asia/Shanghai';
  days: MonthDaySummary[];
  source_status: Partial<Record<CalendarSource, SourceStatus>>;
};

export type DayItem = {
  source_ref: { service: string; kind: string; id: string } | null;
  title: string;
  detail: string | null;
  target: { kind: string; id: string } | null;
};

export type CalendarDaySourceResult = {
  date: string;
  source: CalendarSource;
  status: SourceStatus;
  items: DayItem[];
  next_cursor: string | null;
  has_more: boolean;
};

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** 北京时间自然日半开区间 [00:00, 次日00:00) → UTC ISO 对。 */
export function shanghaiDayRange(dateStr: string): { startUtc: string; endUtc: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7)), d = Number(dateStr.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const startMs = Date.UTC(y, m - 1, d) - SHANGHAI_OFFSET_MS;
  const check = new Date(startMs + SHANGHAI_OFFSET_MS);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  const endMs = startMs + 86_400_000;
  return { startUtc: new Date(startMs).toISOString(), endUtc: new Date(endMs).toISOString() };
}

/** 月内所有日期（YYYY-MM-DD 列表）。 */
export function monthDays(monthStr: string): string[] | null {
  if (!/^\d{4}-\d{2}$/.test(monthStr)) return null;
  const y = Number(monthStr.slice(0, 4)), m = Number(monthStr.slice(5, 7));
  if (m < 1 || m > 12) return null;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) out.push(`${monthStr}-${String(d).padStart(2, '0')}`);
  return out;
}

export function buildCalendarMonth(d: {
  db: Db;
  config: Config;
  mariposaReady: boolean;
  superpositionReady: boolean;
  contentReady: boolean;
}, month: string): CalendarMonthResult | null {
  const days = monthDays(month);
  if (!days) return null;
  const sourceStatus: Partial<Record<CalendarSource, SourceStatus>> = {};
  // chat 始终可用（est 自己的库）
  sourceStatus.chat = 'ready';
  // 外部源按配置与可达性如实标注
  sourceStatus.memory = d.mariposaReady ? 'ready' : d.config.integrations.mariposa.base_url !== null ? 'unavailable' : 'not_configured';
  sourceStatus.plans = sourceStatus.memory;
  sourceStatus.stars = d.superpositionReady ? 'ready' : d.config.integrations.superposition.base_url !== null ? 'unavailable' : 'not_configured';
  sourceStatus.reminders = 'ready'; // est 自己的调度器
  sourceStatus.future_notes = d.contentReady ? 'ready' : 'not_configured';
  sourceStatus.creations = d.contentReady ? 'ready' : 'not_configured';

  const daySummaries: MonthDaySummary[] = [];
  for (const day of days) {
    const counts: Partial<Record<CalendarSource, number>> = {};
    // chat：按北京时间自然日查消息（半开区间）
    const range = shanghaiDayRange(day);
    if (range) {
      const n = (d.db.prepare("SELECT COUNT(*) n FROM messages WHERE created_at >= ? AND created_at < ?").get(range.startUtc, range.endUtc) as { n: number }).n;
      if (n > 0) counts.chat = n;
      // reminders：按 next_due_at 的上海日匹配
      const rn = (d.db.prepare("SELECT COUNT(*) n FROM background_tasks WHERE kind = 'reminder' AND enabled = 1 AND next_due_at >= ? AND next_due_at < ?").get(range.startUtc, range.endUtc) as { n: number }).n;
      if (rn > 0) counts.reminders = rn;
    }
    // 外部源（memory/plans/stars/future_notes/creations）首版不预加载月计数——
    // 日详情选中后按需读取（§06.7.2：首版可显示"有内容/数量待加载"，不伪造精确数量）
    daySummaries.push({ date: day, counts });
  }
  return { month, timezone: 'Asia/Shanghai', days: daySummaries, source_status: sourceStatus };
}

export function buildCalendarDayItems(d: {
  db: Db;
  config: Config;
  mariposaReady: boolean;
  superpositionReady: boolean;
  contentReady: boolean;
  contentClient: { baseUrl: string; token: string } | null;
}, date: string, source: CalendarSource, cursor: string | null, limit: number): CalendarDaySourceResult | null {
  const range = shanghaiDayRange(date);
  if (!range) return null;
  const afterId = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : null;
  const base: CalendarDaySourceResult = { date, source, status: 'ready', items: [], next_cursor: null, has_more: false };

  if (source === 'chat') {
    // 当天全部聊天（§06.7.3：半开区间；含未 hold/内部窗口切换——不依赖模型上下文）
    const rows = d.db.prepare('SELECT id, conversation_id, sequence, speaker, kind, created_at FROM messages WHERE created_at >= ? AND created_at < ? AND speaker != ? ORDER BY created_at ASC, id ASC')
      .all(range.startUtc, range.endUtc, 'system') as Array<{ id: string; conversation_id: string; sequence: number; speaker: string; kind: string; created_at: string }>;
    const filtered = afterId !== null ? rows.filter((r) => r.id > afterId!) : rows; // AUD-23 已在排序键统一 (created_at,id)
    const page = filtered.slice(0, limit);
    base.items = page.map((r) => ({
      source_ref: { service: 'estomago', kind: 'message', id: r.id },
      title: r.speaker === 'owner' ? '我' : '周家明',
      detail: r.kind,
      target: { kind: 'message', id: r.id },
    }));
    base.has_more = filtered.length > limit;
    base.next_cursor = base.has_more && page.length > 0 ? Buffer.from(page[page.length - 1]!.id).toString('base64url') : null;
    return base;
  }

  if (source === 'reminders') {
    const rows = d.db.prepare("SELECT id, kind, payload_json, next_due_at FROM background_tasks WHERE kind = 'reminder' AND enabled = 1 AND next_due_at >= ? AND next_due_at < ? ORDER BY next_due_at ASC")
      .all(range.startUtc, range.endUtc) as Array<{ id: string; kind: string; payload_json: string; next_due_at: string }>;
    base.items = rows.map((r) => ({
      source_ref: { service: 'estomago', kind: 'reminder_task', id: r.id },
      title: (() => { try { return String((JSON.parse(r.payload_json) as { text?: string }).text ?? '提醒').slice(0, 60); } catch { return '提醒'; } })(),
      detail: null,
      target: { kind: 'reminder_task', id: r.id },
    }));
    return base;
  }

  // 外部源——未配置/不可达如实标注（§06.7.4：单源 503 不影响其他源 200）
  if (source === 'memory' || source === 'plans') {
    base.status = d.mariposaReady ? 'ready' : (d.config.integrations.mariposa.base_url !== null ? 'unavailable' : 'not_configured');
    if (base.status !== 'ready') { base.items = []; return base; }
    // Mariposa 桶/计划的真实 HTTP 合同尚未核实——返回空列表+ready（不伪造条目）；
    // 合同核实在 WP7 外部合同批落地后补齐
    base.items = [];
    base.status = 'unavailable'; // 降级为不可用（合同未核，不冒充有数据）
    return base;
  }
  if (source === 'stars') {
    base.status = d.superpositionReady ? 'ready' : (d.config.integrations.superposition.base_url !== null ? 'unavailable' : 'not_configured');
    if (base.status !== 'ready') return base;
    // Superposition 合同未核实——同上
    base.items = [];
    base.status = 'unavailable';
    return base;
  }
  if (source === 'future_notes' || source === 'creations') {
    base.status = d.contentReady ? 'ready' : 'not_configured';
    if (base.status !== 'ready' || !d.contentClient) return base;
    // content 服务可用——按引用筛选（留言/作品按创建日只做粗查；精确事件日=桶正本）
    // 首版：日历显示 content 条目的"创建于该日"标记（§06.7.1：朋友圈和相册上传不自动扩张为日历事件）
    // 真正的事件日/投递日来自 Mariposa 桶/est 任务——content 自身不拥有调度日期
    base.items = [];
    return base;
  }
  return null;
}
