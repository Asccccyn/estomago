// server/routes/calendar.ts（P07.2 第四批c）：日历读聚合路由组。
// 自 server/http.ts 逐字搬迁；聚合正本已在 ./calendar-routes.ts（本组只做参数门+响应）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import { POLICY_CONSTANTS } from '../../config/policy-constants.ts';
import { buildCalendarMonth, buildCalendarDayItems, shanghaiDayRange, type CalendarSource } from '../calendar-routes.ts';
import type { MariposaCallResult } from '../../integrations/mariposa/client.ts';
import type { RequestDeps } from '../http.ts';

async function memoryPage(d: RequestDeps, period: string, cursor?: string, limit?: number): Promise<MariposaCallResult> {
  if (!d.calendarMariposa?.isConfigured()) return {ok:false,code:'MARIPOSA_NOT_CONFIGURED',httpStatus:503};
  try { return await d.calendarMariposa.withSignal(AbortSignal.timeout(10000)).memoryCalendar(period,cursor,limit); }
  catch { return {ok:false,code:'MARIPOSA_UNREACHABLE',httpStatus:503}; }
}

/** 日历组：GET /api/v1/calendar/month|day|day/items。 */
export async function handleCalendarRoutes(req: IncomingMessage, res: ServerResponse, d: RequestDeps, route: string, url: URL): Promise<void> {
// —— EXEC_V1 §06.7（WP6）：日历读聚合（月概要=计数/标记；日详情=分源分页）——
if (route === 'POST /api/v1/calendar/memory/recalculate') {
  const body = await readJson(req,d) as {memory_id?:unknown; revision?:unknown} | null;
  if (typeof body?.memory_id !== 'string' || !body.memory_id.trim() || body.memory_id.length>200
      || !(body.revision===null || (typeof body.revision==='number' && Number.isSafeInteger(body.revision) && body.revision>=0)))
    return json(res,400,{error:{code:'bad_request',message:'需要桶号和页面上的任务版本。'}});
  if (!d.sourceBinding) return json(res,503,{error:{code:'unavailable',message:'来源判断服务不可用。'}});
  const result=await d.sourceBinding.recalculate(body.memory_id,body.revision);
  return json(res,200,result);
}
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
  const mem = await memoryPage(d,month);
  if (mem.ok && Array.isArray(mem.result.days)) {
    const counts = new Map(mem.result.days.map(row => [row.date,row]));
    for (const day of result.days) {
      const row=counts.get(day.date);
      day.counts.memory=row?.total ?? 0;
      day.unbound_memories=row?.unbound ?? 0;
    }
    result.source_status.memory='ready';
  } else if (!mem.ok) result.memory_error=mem.code;
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
  if (!shanghaiDayRange(date)) return json(res,400,{error:{code:'bad_date',message:'日期非法'}});
  const mem=await memoryPage(d,date,undefined,1);
  summary.memory={status:mem.ok?'ready':(d.config.integrations.mariposa.base_url?'unavailable':'not_configured'),has_items:mem.ok && Array.isArray(mem.result.items) && mem.result.items.length>0};
  return json(res, 200, { date, timezone: 'Asia/Shanghai', sources: summary });
}
if (route === 'GET /api/v1/calendar/day/items') {
  const date = url.searchParams.get('date') ?? '';
  const source = url.searchParams.get('source') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: { code: 'bad_date', message: 'date 必须是 YYYY-MM-DD' } });
  const validSources = ['chat', 'memory', 'plans', 'stars', 'reminders', 'future_notes', 'creations'];
  if (!validSources.includes(source)) return json(res, 400, { error: { code: 'bad_source', message: `source 必须是 ${validSources.join('|')}` } });
  const limit = Number(url.searchParams.get('limit')) || POLICY_CONSTANTS.pagination.default_limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > POLICY_CONSTANTS.pagination.max_limit) return json(res, 400, { error: { code: 'limit_invalid', message: `limit 必须在 1..${POLICY_CONSTANTS.pagination.max_limit}` } });
  const cursor = url.searchParams.get('cursor');
  if (source==='memory') {
    if (!shanghaiDayRange(date)) return json(res,400,{error:{code:'bad_date',message:'日期非法'}});
    const mem=await memoryPage(d,date,cursor??undefined,limit);
    if (!mem.ok) return json(res,503,{error:{code:mem.code,message:'读取 Mariposa 记忆日历失败（'+mem.code+'）。'}});
    const items=(mem.result.items as {memory_id:string;title:string|null;source_count:number}[]).map(row=>{
      const job=d.sourceBinding?.job(row.memory_id);
      return {source_ref:{service:'mariposa',kind:'memory',id:row.memory_id},target:{kind:'bucket_detail',id:row.memory_id},
        title:row.title || row.memory_id,detail:null,source_count:row.source_count,
        status:job?.status??null,reason:job?.detail??null,revision:job?.revision??null};
    });
    return json(res,200,{date,source,status:'ready',items,next_cursor:mem.result.next_cursor,has_more:!!mem.result.next_cursor});
  }
  const result = buildCalendarDayItems({ db: d.db, config: d.config, mariposaReady: false, superpositionReady: false, contentReady: Boolean(d.contentClient), contentClient: d.contentClient ?? null }, date, source as CalendarSource, cursor, limit);
  if (!result) return json(res, 400, { error: { code: 'bad_date', message: '日期非法' } });
  return json(res, 200, result);
}
}
