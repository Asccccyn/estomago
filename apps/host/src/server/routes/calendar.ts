// server/routes/calendar.ts（P07.2 第四批c）：日历读聚合路由组。
// 自 server/http.ts 逐字搬迁；聚合正本已在 ./calendar-routes.ts（本组只做参数门+响应）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json } from '../http-leaf.ts';
import { POLICY_CONSTANTS } from '../../config/policy-constants.ts';
import { buildCalendarMonth, buildCalendarDayItems, shanghaiDayRange, type CalendarSource } from '../calendar-routes.ts';
import type { RequestDeps } from '../http.ts';

/** 日历组：GET /api/v1/calendar/month|day|day/items。 */
export function handleCalendarRoutes(req: IncomingMessage, res: ServerResponse, d: RequestDeps, route: string, url: URL): void {
// —— EXEC_V1 §06.7（WP6）：日历读聚合（月概要=计数/标记；日详情=分源分页）——
if (route === 'GET /api/v1/calendar/month') {
  const month = url.searchParams.get('month') ?? '';
  if (!/^\d{4}-\d{2}$/.test(month)) return json(res, 400, { error: { code: 'bad_month', message: 'month 必须是 YYYY-MM' } });
  const result = buildCalendarMonth({
    db: d.db, config: d.config,
    mariposaReady: false,
    superpositionReady: false,
    contentReady: d.contentClient !== null && d.contentClient !== undefined,
  }, month);
  if (!result) return json(res, 400, { error: { code: 'bad_month', message: '月份非法' } });
  return json(res, 200, result);
}
if (route === 'GET /api/v1/calendar/day') {
  const date = url.searchParams.get('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: { code: 'bad_date', message: 'date 必须是 YYYY-MM-DD' } });
  // 日概要：各来源状态+入口（不返回全部原文）
  const sources = ['chat', 'memory', 'plans', 'stars', 'reminders', 'future_notes', 'creations'] as const;
  const summary: Record<string, unknown> = {};
  for (const src of sources) {
    const r = buildCalendarDayItems({ db: d.db, config: d.config, mariposaReady: false, superpositionReady: false, contentReady: Boolean(d.contentClient), contentClient: d.contentClient ?? null }, date, src, null, 1);
    if (r) summary[src] = { status: r.status, has_items: r.items.length > 0 || r.has_more };
  }
  return json(res, 200, { date, timezone: 'Asia/Shanghai', sources: summary });
}
if (route === 'GET /api/v1/calendar/day/items') {
  const date = url.searchParams.get('date') ?? '';
  const source = url.searchParams.get('source') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: { code: 'bad_date', message: 'date 必须是 YYYY-MM-DD' } });
  const validSources = ['chat', 'memory', 'plans', 'stars', 'reminders', 'future_notes', 'creations'];
  if (!validSources.includes(source)) return json(res, 400, { error: { code: 'bad_source', message: `source 必须是 ${validSources.join('|')}` } });
  const limit = Number(url.searchParams.get('limit')) || POLICY_CONSTANTS.pagination.default_limit;
  if (limit < 1 || limit > POLICY_CONSTANTS.pagination.max_limit) return json(res, 400, { error: { code: 'limit_invalid', message: `limit 必须在 1..${POLICY_CONSTANTS.pagination.max_limit}` } });
  const cursor = url.searchParams.get('cursor');
  const result = buildCalendarDayItems({ db: d.db, config: d.config, mariposaReady: false, superpositionReady: false, contentReady: Boolean(d.contentClient), contentClient: d.contentClient ?? null }, date, source as CalendarSource, cursor, limit);
  if (!result) return json(res, 400, { error: { code: 'bad_date', message: '日期非法' } });
  return json(res, 200, result);
}
}
