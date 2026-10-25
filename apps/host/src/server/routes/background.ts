// server/routes/background.ts（P07.2 第三批）：后台设置/任务/运行路由组。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序（外层 est 认证+mutating Origin 门已过）/
// 响应与错误码逐字保持（A23 同一领域服务面：BackgroundTaskService/BackgroundSettings/调度器）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import { keepwarmSleepState } from '../../runtime/keepwarm-sleep.ts';
import { storedToolset } from '../../runtime/tool-discovery.ts';
import { genId } from '../../util/id.ts';
import type { RequestDeps } from '../http.ts';

/** 后台管理面（EXEC_V1 §04.11 + WAKE_KEEPWARM_V1 §08）：settings/tasks/runs 全组。 */
export async function handleBackgroundRoutes(req: IncomingMessage, res: ServerResponse, d: RequestDeps, route: string, url: URL): Promise<void> {
// —— EXEC_V1 §04.11（WP4）+ WAKE_KEEPWARM_V1 §08（2026-10-22）：后台设置/任务/运行 ——
// 任务管理全部经 BackgroundTaskService（与模型 wake_manage 共用幂等/CAS/鉴权；
// HTTP 不再直写表、不再拼 Date.now 伪幂等，B14/B15 修复）。
if (route === 'GET /api/v1/background/settings') {
  if (!d.bgSettings) return json(res, 503, { error: { code: 'background_unavailable', message: '后台服务未装配' } });
  const es = d.bgSettings.effective();
  // 08 精简返回：两个开关、revision、就绪、预算摘要 + 保温权威派生状态
  const sleep = keepwarmSleepState(es.keepwarm.sleep_window, Date.now());
  const activityRow = d.activity?.get('primary') ?? null;
  const activeWindow = d.windows.activeWindow('primary');
  const frozenTools = activeWindow ? storedToolset(d.db, activeWindow.id) : null;
  const wakeToolAvailable = frozenTools ? frozenTools.catalog.some((tool) => tool.function.name === 'wake_manage') : null;
  let keepwarmStatus: Record<string, unknown> = { scheduled: false };
  if (d.activity && d.scheduler) {
    const win = d.db.prepare("SELECT id FROM windows WHERE conversation_id = 'primary' AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (win) {
      const target = d.activity.nextKeepwarmTarget({ conversationId: 'primary', windowId: win.id });
      const ev = (d.db.prepare(
        `SELECT u.cache_read_input_tokens AS rt, u.cache_creation_input_tokens AS wt, pr.dispatch_started_at AS started
         FROM usage_observations u JOIN provider_requests pr ON pr.id = u.request_id
         WHERE pr.window_id = ? AND u.completeness = 'complete' AND pr.outcome = 'completed'
           AND ((u.cache_read_input_tokens IS NOT NULL AND u.cache_read_input_tokens > 0) OR (u.cache_creation_input_tokens IS NOT NULL AND u.cache_creation_input_tokens > 0))
         ORDER BY COALESCE(pr.dispatch_started_at, pr.sent_at, u.observed_at) DESC LIMIT 1`,
      ).get(win.id) as { rt: number | null; wt: number | null; started: string | null } | undefined);
      const cacheStatus = !ev ? 'unknown' : (ev.started && Date.now() - Date.parse(ev.started) >= 3_600_000) ? 'estimated_cold' : (ev.rt ?? 0) > 0 ? 'observed_hit' : 'observed_write';
      keepwarmStatus = {
        scheduled: target.scheduled && es.keepwarm.enabled && !sleep.blocked,
        ...(target.scheduled && !sleep.blocked ? { next_keepwarm_at: new Date(target.dueAtMs).toISOString(), next_keepwarm_basis: target.basis } : {}),
        last_real_activity_at: activityRow?.last_real_activity_at ?? null,
        cache_status: cacheStatus,
      };
    }
  }
  return json(res, 200, {
    revision: es.revision,
    autonomous: { enabled: es.autonomous.enabled, daily_cost_cap_usd: es.autonomous.daily_cost_cap_usd },
    keepwarm: { enabled: es.keepwarm.enabled, daily_cost_cap_usd: es.keepwarm.daily_cost_cap_usd, sleep_window: es.keepwarm.sleep_window },
    reminders: { enabled: es.reminders.enabled },
    executor_ready: d.bgExecutorReady ?? { autonomous: false, keepwarm: false },
    current_window: { id: activeWindow?.id ?? null, wake_manage_available: wakeToolAvailable, requires_normal_rotation: activeWindow !== null && wakeToolAvailable === false },
    keepwarm_status: { ...keepwarmStatus, sleep_window_active: sleep.blocked, blocked_reason: sleep.code, local_time: sleep.local_time },
    notice: '关闭后不再开始自主预约唤醒/心跳保温，正在进行的后续步骤会停止；已产生的费用和已完成的动作保留。两项开关独立。',
  });
}
if (route === 'PUT /api/v1/background/settings') {
  if (!d.bgSettings) return json(res, 503, { error: { code: 'background_unavailable', message: '后台服务未装配' } });
  const ifMatch = String(req.headers['if-match'] ?? '').replace(/"/g, '');
  if (!ifMatch || !/^\d+$/.test(ifMatch)) return json(res, 428, { error: { code: 'precondition_required', message: '必须带 If-Match: "<revision>"' } });
  const opKey = String(req.headers['idempotency-key'] ?? '');
  if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
  const body = (await readJson(req, d)) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const section of ['autonomous', 'keepwarm', 'reminders'] as const) {
    if (body[section] === undefined) continue;
    const sv = body[section];
    if (!sv || typeof sv !== 'object' || Array.isArray(sv)) return json(res, 422, { error: { code: 'invalid_background_settings', message: `${section} 必须是对象` } });
    const values = sv as Record<string, unknown>;
    if ('enabled' in values) {
      if (typeof values.enabled !== 'boolean') return json(res, 422, { error: { code: 'invalid_background_settings', message: `${section}.enabled 必须为布尔值` } });
      patch[`${section}_enabled`] = values.enabled;
    }
    if (section !== 'reminders' && 'daily_cost_cap_usd' in values) {
      const cap = values.daily_cost_cap_usd;
      if (cap !== null && (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0)) return json(res, 422, { error: { code: 'invalid_background_settings', message: `${section}.daily_cost_cap_usd 必须为正数或 null` } });
      patch[`${section}_daily_cost_cap_usd`] = cap;
    }
  }
  if (Object.values(patch).every((v) => v === undefined)) return json(res, 400, { error: { code: 'bad_patch', message: '无可识别的设置字段' } });
  try {
    const r = d.bgSettings.applyUpdate({ expectedRevision: Number(ifMatch), operationId: opKey, patch: patch as never, readiness: d.bgExecutorReady ? { autonomousExecutorReady: d.bgExecutorReady.autonomous, keepwarmExecutorReady: d.bgExecutorReady.keepwarm } : undefined });
    return json(res, 200, { revision: r.revision, applied: true, duplicate: r.duplicate ?? false });
  } catch (err) {
    const msg = String((err as Error).message ?? '');
    if (msg.startsWith('REVISION_CONFLICT')) return json(res, 409, { error: { code: 'revision_conflict', message: `设置版本已变化（当前 ${msg.split(':')[1] ?? '?'}），请刷新重试` } });
    if (msg.startsWith('IDEMPOTENCY_CONFLICT')) return json(res, 409, { error: { code: 'idempotency_conflict', message: '该操作键已用于不同的设置，请核对原操作' } });
    if (msg.startsWith('BACKGROUND_BUDGET_INVALID') || msg.startsWith('SETTINGS_OPERATION_ID_INVALID')) return json(res, 422, { error: { code: 'invalid_background_settings', message: '设置操作或费用上限无效' } });
    if (msg.startsWith('BACKGROUND_BUDGET_NOT_CONFIGURED')) return json(res, 422, { error: { code: 'background_budget_not_configured', message: '该用途日费用上限未配置（null 不是无限）——先填有效上限再开启' } });
    if (msg.startsWith('BACKGROUND_EXECUTOR_NOT_READY')) return json(res, 422, { error: { code: 'background_executor_not_ready', message: '自主/保温的模型执行器尚未接线（后续批次）——开关意图已保存语义见 422，不开启付费路径' } });
    throw err;
  }
}
if (route === 'GET /api/v1/background/tasks') {
  if (!d.taskService) return json(res, 503, { error: { code: 'background_unavailable', message: '预约服务未装配' } });
  const conversationId = url.searchParams.get('conversation_id') ?? 'primary';
  const r = d.taskService.list({ actorId: 'jiaming', conversationId, cursor: url.searchParams.get('cursor') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 20) });
  if (!r.ok) return json(res, r.httpStatus ?? 400, { error: { code: r.code.toLowerCase(), message: r.detail ?? null } });
  // 08 瘦返回：id/revision/kind/scheduled_at/status/短预览；全文 note 走详情
  return json(res, 200, { tasks: r.tasks, next_cursor: r.next_cursor });
}
const bgTaskDetail = /^GET \/api\/v1\/background\/tasks\/([^/]+)$/.exec(route);
if (bgTaskDetail) {
  if (!d.taskService) return json(res, 503, { error: { code: 'background_unavailable', message: '预约服务未装配' } });
  const r = d.taskService.detail({ actorId: 'jiaming', conversationId: url.searchParams.get('conversation_id') ?? 'primary', taskId: decodeURIComponent(bgTaskDetail[1]!) });
  if (!r.ok) return json(res, r.httpStatus ?? 400, { error: { code: r.code.toLowerCase(), message: r.detail ?? null } });
  return json(res, 200, { task: r.task });
}
if (route === 'POST /api/v1/background/tasks') {
  const opKey = String(req.headers['idempotency-key'] ?? '');
  if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
  const body = (await readJson(req, d)) as Record<string, unknown>;
  if (body.kind === 'reminder') {
    // 普通提醒（无模型投递）保留直建；ID 由服务端生成（不再拼 Date.now，B14）
    const scheduleKind = body.schedule_kind ?? 'once';
    if (scheduleKind !== 'once' && scheduleKind !== 'daily') return json(res, 400, { error: { code: 'bad_schedule', message: 'reminder 的 schedule_kind 必须是 once|daily' } });
    if (typeof body.scheduled_at !== 'string' || !body.scheduled_at) return json(res, 400, { error: { code: 'bad_scheduled_at', message: 'scheduled_at 必填（完整时间，不暗补当前时间）' } });
    const prior = d.db.prepare('SELECT id FROM background_tasks WHERE conversation_id = ? AND client_operation_key = ?').get(String(body.conversation_id ?? 'primary'), opKey) as { id: string } | undefined;
    if (prior) return json(res, 200, { task_id: prior.id, duplicate: true });
    const id = genId('bgt');
    const nowIso = new Date().toISOString();
    d.db.prepare(
      `INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, client_operation_key, created_at, updated_at)
       VALUES (?,?,'jiaming','reminder',1,1,?,?,?,'Asia/Shanghai',NULL,NULL,?,'qiaosheng','legacy_unknown',?,?,?)`,
    ).run(id, String(body.conversation_id ?? 'primary'), scheduleKind, body.scheduled_at as string, body.scheduled_at as string, JSON.stringify(body.payload && typeof body.payload === 'object' ? body.payload : { text: String(body.text ?? '') }), opKey, nowIso, nowIso);
    return json(res, 201, { task_id: id, next_due_at: body.scheduled_at });
  }
  // 自主预约（WAKE_KEEPWARM_V1）：统一经 taskService——服务端幂等/CAS/时间校验；
  // creator=用户（qiaosheng），审计保留操作者（04：用户可代设，操作者可查）。
  if (!d.taskService) return json(res, 503, { error: { code: 'background_unavailable', message: '预约服务未装配' } });
  const r = d.taskService.schedule({
    actorId: 'jiaming', conversationId: String(body.conversation_id ?? 'primary'), operationId: opKey,
    note: String(body.note ?? ''), at: body.at ?? undefined, delaySeconds: body.delay_seconds ?? undefined, createdBy: 'qiaosheng',
  });
  if (!r.ok) return json(res, r.httpStatus ?? 400, { error: { code: r.code.toLowerCase(), message: r.detail ?? null, ...(r.serverNowIso ? { server_now: r.serverNowIso } : {}), ...(r.currentRevision !== undefined ? { current_revision: r.currentRevision } : {}) } });
  return json(res, r.duplicate ? 200 : 201, { task_id: r.task.task_id, scheduled_at: r.task.scheduled_at, revision: r.task.revision, duplicate: r.duplicate });
}
const bgTaskPut = /^PUT \/api\/v1\/background\/tasks\/([^/]+)$/.exec(route);
if (bgTaskPut) {
  if (!d.taskService) return json(res, 503, { error: { code: 'background_unavailable', message: '预约服务未装配' } });
  const ifMatch = String(req.headers['if-match'] ?? '').replace(/"/g, '');
  if (!ifMatch || !/^\d+$/.test(ifMatch)) return json(res, 428, { error: { code: 'precondition_required', message: '必须带 If-Match' } });
  if (!String(req.headers['idempotency-key'] ?? '')) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
  const body = (await readJson(req, d)) as Record<string, unknown>;
  const r = d.taskService.update({
    actorId: 'jiaming', conversationId: String(body.conversation_id ?? 'primary'), operationId: String(req.headers['idempotency-key']),
    taskId: decodeURIComponent(bgTaskPut[1]!), expectedRevision: Number(ifMatch),
    note: body.note ?? undefined, at: body.at ?? undefined, delaySeconds: body.delay_seconds ?? undefined,
  });
  if (!r.ok) return json(res, r.httpStatus ?? 400, { error: { code: r.code.toLowerCase(), message: r.detail ?? null, ...(r.currentRevision !== undefined ? { current_revision: r.currentRevision } : {}) } });
  return json(res, 200, { task_id: r.task.task_id, revision: r.task.revision, duplicate: r.duplicate });
}
const bgTaskDelete = /^DELETE \/api\/v1\/background\/tasks\/([^/]+)$/.exec(route);
if (bgTaskDelete) {
  if (!d.taskService) return json(res, 503, { error: { code: 'background_unavailable', message: '预约服务未装配' } });
  const ifMatch = String(req.headers['if-match'] ?? '').replace(/"/g, '');
  if (!ifMatch || !/^\d+$/.test(ifMatch)) return json(res, 428, { error: { code: 'precondition_required', message: '必须带 If-Match' } });
  // A-03：取消递增 revision（不只是 enabled=0）；零派发排队 run 失效
  const r = d.taskService.cancel({
    actorId: 'jiaming', conversationId: url.searchParams.get('conversation_id') ?? 'primary', operationId: String(req.headers['idempotency-key']),
    taskId: decodeURIComponent(bgTaskDelete[1]!), expectedRevision: Number(ifMatch),
  });
  if (!r.ok) return json(res, r.httpStatus ?? 400, { error: { code: r.code.toLowerCase(), message: r.detail ?? null, ...(r.currentRevision !== undefined ? { current_revision: r.currentRevision } : {}) } });
  return json(res, 200, { task_id: r.task.task_id, revision: r.task.revision, cancelled: true });
}
if (route === 'GET /api/v1/background/runs') {
  const conversationId = url.searchParams.get('conversation_id') ?? 'primary';
  const limit = Number(url.searchParams.get('limit') ?? 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return json(res, 400, { error: { code: 'invalid_limit', message: 'limit 必须为 1..100 的整数' } });
  const cursor = url.searchParams.get('cursor');
  const cursorParts = cursor?.split('|');
  if (cursor && (cursorParts?.length !== 2 || !Number.isFinite(Date.parse(cursorParts[0]!)) || !cursorParts[1])) return json(res, 400, { error: { code: 'invalid_cursor', message: '运行分页位置无效' } });
  const params: Array<string | number> = [conversationId];
  const after = cursorParts ? ' AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))' : '';
  if (cursorParts) params.push(cursorParts[0]!, cursorParts[0]!, cursorParts[1]!);
  params.push(limit + 1);
  // 08 瘦返回：来源（trigger_origin 从 task origin 派生）/状态/实际派发时间/动作与
  // 发布计数/成本/阻断原因——不含原 payload、工具 JSON、reasoning 或聊天正文。
  const rows = d.db.prepare(
    `SELECT r.id, r.task_id, r.kind, r.state, r.result_code, r.cancel_reason,
            CASE WHEN t.origin = 'self_schedule' THEN 'self_wake' WHEN r.kind = 'keepwarm' THEN 'keepwarm' ELSE 'legacy' END AS trigger_origin,
            r.model_requests_started, r.tool_calls_started, r.tool_calls_observed, r.published_message_count,
            r.reserved_cost_micro_usd, r.known_cost_micro_usd, r.unknown_cost_count, r.retention,
            r.first_dispatch_started_at, r.claimed_at, r.finished_at, r.created_at
     FROM background_runs r JOIN background_tasks t ON t.id = r.task_id
     WHERE r.conversation_id = ?${after} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return json(res, 200, { runs: page, next_cursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null });
}
const bgRunStop = /^POST \/api\/v1\/background\/runs\/([^/]+)\/stop$/.exec(route);
if (bgRunStop) {
  if (!d.scheduler) return json(res, 503, { error: { code: 'background_unavailable', message: '调度器未装配' } });
  if (!String(req.headers['idempotency-key'] ?? '')) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
  const r = d.scheduler.stopRun(decodeURIComponent(bgRunStop[1]!));
  if (r === null) return json(res, 404, { error: { code: 'not_found', message: '执行不存在' } });
  // §7.3：区分已停止/正在取消/待核实/已结束——返回实际状态，不拿按钮变灰当证据
  return json(res, 200, { run_id: decodeURIComponent(bgRunStop[1]!), state: r.state, stopping: r.state === 'cancelling' });
}
}
