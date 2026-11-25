// server/routes/background.ts（P07.2 第三批）：后台设置/任务/运行路由组。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序（外层 est 认证+mutating Origin 门已过）/
// 响应与错误码逐字保持（A23 同一领域服务面：BackgroundTaskService/BackgroundSettings/调度器）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import { keepwarmSleepState } from '../../runtime/keepwarm-sleep.ts';
import { MORNING_WAKE_OCCURRENCE_PREFIX } from '../../runtime/wake-activity.ts';
import { storedToolset } from '../../runtime/tool-discovery.ts';
import { MODEL_BACKGROUND_CONTROLS } from '../../runtime/background-policy.ts';
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
  const nowMs = d.scheduler?.currentNowMs() ?? Date.now();
  const sleep = keepwarmSleepState(es.keepwarm.sleep_window, nowMs);
  const activityRow = d.activity?.get('primary') ?? null;
  const resting = activityRow?.resting === 1;
  const activeWindow = d.windows.activeWindow('primary');
  const frozenTools = activeWindow ? storedToolset(d.db, activeWindow.id) : null;
  const wakeToolAvailable = frozenTools ? frozenTools.catalog.some((tool) => tool.function.name === 'wake_manage') : null;
  // The page may only show a time the scheduler can actually keep. A due point
  // inside the sleep window, a resting owner or a closed switch pause the heartbeat,
  // except that an enabled morning wake outside the sleep window remains scheduled across night/rest.
  let blockedReason: string | null = sleep.blocked ? sleep.code
    : !es.keepwarm.enabled ? 'KEEPWARM_DISABLED' : resting ? 'KEEPWARM_RESTING' : null;
  let keepwarmStatus: Record<string, unknown> = { scheduled: false };
  if (d.activity && d.scheduler) {
    const win = d.db.prepare("SELECT id FROM windows WHERE conversation_id = 'primary' AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (win) {
      const target = d.activity.nextKeepwarmTarget({ conversationId: 'primary', windowId: win.id });
      const morning = es.keepwarm.enabled
        ? d.activity.morningWakeTarget({ conversationId: 'primary', windowId: win.id, sleepWindow: es.keepwarm.sleep_window, nowMs })
        : null;
      const ev = (d.db.prepare(
        `SELECT u.cache_read_input_tokens AS rt, u.cache_creation_input_tokens AS wt, pr.dispatch_started_at AS started
         FROM usage_observations u JOIN provider_requests pr ON pr.id = u.request_id
         WHERE pr.window_id = ? AND u.completeness = 'complete' AND pr.outcome = 'completed'
           AND ((u.cache_read_input_tokens IS NOT NULL AND u.cache_read_input_tokens > 0) OR (u.cache_creation_input_tokens IS NOT NULL AND u.cache_creation_input_tokens > 0))
         ORDER BY COALESCE(pr.dispatch_started_at, pr.sent_at, u.observed_at) DESC LIMIT 1`,
      ).get(win.id) as { rt: number | null; wt: number | null; started: string | null } | undefined);
      const cacheStatus = !ev ? 'unknown' : (ev.started && nowMs - Date.parse(ev.started) >= 3_600_000) ? 'estimated_cold' : (ev.rt ?? 0) > 0 ? 'observed_hit' : 'observed_write';
      const ordinaryBlocked = blockedReason !== null || (target.scheduled && keepwarmSleepState(es.keepwarm.sleep_window, target.dueAtMs).blocked);
      if (blockedReason === null && target.scheduled && keepwarmSleepState(es.keepwarm.sleep_window, target.dueAtMs).blocked) {
        blockedReason = 'KEEPWARM_SLEEP_WINDOW';
      }
      const cacheWarm = cacheStatus === 'observed_hit' || cacheStatus === 'observed_write';
      const useMorning = morning?.scheduled === true && (
        ordinaryBlocked || !target.scheduled || !cacheWarm || morning.dueAtMs <= target.dueAtMs
      );
      if (useMorning && morning?.scheduled) {
        blockedReason = null;
        const morningAt = new Date(morning.dueAtMs).toISOString();
        const postponedBy = morning.postponedByAtMs !== null ? new Date(morning.postponedByAtMs).toISOString() : null;
        keepwarmStatus = {
          scheduled: true,
          next_keepwarm_at: morningAt,
          next_keepwarm_basis: morning.basis,
          morning_postponed_by_at: postponedBy,
          morning_wake: { scheduled: true, target_at: morningAt, basis: morning.basis, postponed_by_at: postponedBy },
          last_real_activity_at: activityRow?.last_real_activity_at ?? null,
          cache_status: cacheStatus,
        };
      } else {
        const scheduled = target.scheduled && blockedReason === null;
        keepwarmStatus = {
          scheduled,
          ...(scheduled ? { next_keepwarm_at: new Date(target.dueAtMs).toISOString(), next_keepwarm_basis: target.basis } : {}),
          ...(morning ? {
            morning_wake: morning.scheduled
              ? {
                  scheduled: true,
                  target_at: new Date(morning.dueAtMs).toISOString(),
                  basis: morning.basis,
                  postponed_by_at: morning.postponedByAtMs !== null ? new Date(morning.postponedByAtMs).toISOString() : null,
                }
              : {
                  scheduled: false,
                  reason: morning.reason,
                  ...(morning.dueAtMs !== undefined ? { target_at: new Date(morning.dueAtMs).toISOString() } : {}),
                  ...(morning.basis ? { basis: morning.basis } : {}),
                  postponed_by_at: morning.postponedByAtMs !== undefined && morning.postponedByAtMs !== null ? new Date(morning.postponedByAtMs).toISOString() : null,
                },
          } : {}),
          last_real_activity_at: activityRow?.last_real_activity_at ?? null,
          cache_status: cacheStatus,
        };
      }
    }
  }
  return json(res, 200, {
    revision: es.revision,
    free_activity:{enabled:es.free_activity.enabled,daily_cost_cap_usd:es.free_activity.daily_cost_cap_usd},
    autonomous: { enabled: es.autonomous.enabled, daily_cost_cap_usd: es.autonomous.daily_cost_cap_usd },
    keepwarm: { enabled: es.keepwarm.enabled, include_living_room: es.keepwarm.include_living_room, daily_cost_cap_usd: es.keepwarm.daily_cost_cap_usd, sleep_window: es.keepwarm.sleep_window },
    reminders: { enabled: es.reminders.enabled },
    executor_ready:{...(d.bgExecutorReady ?? {autonomous:false,keepwarm:false}),free_activity:d.bgExecutorReady?.autonomous ?? false},
    current_window: { id: activeWindow?.id ?? null, wake_manage_available: wakeToolAvailable, requires_normal_rotation: activeWindow !== null && wakeToolAvailable === false },
    keepwarm_status: { ...keepwarmStatus, sleep_window_active: sleep.blocked, blocked_reason: blockedReason, local_time: sleep.local_time,
      resting, rest_decided_at: activityRow?.rest_decided_at ?? null, rest_source: activityRow?.rest_source ?? null },
    notice: '预约唤醒、心跳保温、额外自由活动分别控制。关闭只停止对应来源的新执行及后续步骤，已完成动作与费用保留。',
  });
}
// An explicit resume from the management page. It clears the owner's standing rest
// decision only: no chat message is created, the 50-minute anchor and the heartbeat
// switch stay as they are, and the same operation key replays its first result.
if (route === 'POST /api/v1/background/heartbeat/resume') {
  if (!d.activity) return json(res, 503, { error: { code: 'background_unavailable', message: '心跳服务未装配' } });
  const opKey = String(req.headers['idempotency-key'] ?? '');
  if (!opKey || opKey.length > 200) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少或过长的 Idempotency-Key' } });
  const result = d.activity.resumeRest('primary', { actorId: 'qiaosheng', operationId: opKey });
  return json(res, 200, { resting: result.resting, changed: result.changed, duplicate: result.duplicate });
}
if (route === 'PUT /api/v1/background/settings') {
  if (!d.bgSettings) return json(res, 503, { error: { code: 'background_unavailable', message: '后台服务未装配' } });
  const ifMatch = String(req.headers['if-match'] ?? '').replace(/"/g, '');
  if (!ifMatch || !/^\d+$/.test(ifMatch)) return json(res, 428, { error: { code: 'precondition_required', message: '必须带 If-Match: "<revision>"' } });
  const opKey = String(req.headers['idempotency-key'] ?? '');
  if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
  const body = (await readJson(req, d)) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const section of [...MODEL_BACKGROUND_CONTROLS,'reminders'] as const) {
    if (body[section] === undefined) continue;
    const sv = body[section];
    if (!sv || typeof sv !== 'object' || Array.isArray(sv)) return json(res, 422, { error: { code: 'invalid_background_settings', message: `${section} 必须是对象` } });
    const values = sv as Record<string, unknown>;
    if (section === 'keepwarm' && 'include_living_room' in values) {
      if (typeof values.include_living_room !== 'boolean') return json(res, 422, { error: { code: 'invalid_background_settings', message: 'keepwarm.include_living_room 必须为布尔值' } });
      patch.keepwarm_include_living_room = values.include_living_room;
    }
    if ('enabled' in values) {
      if (typeof values.enabled !== 'boolean') return json(res, 422, { error: { code: 'invalid_background_settings', message: `${section}.enabled 必须为布尔值` } });
      patch[`${section}_enabled`] = values.enabled;
    }
    if (section !== 'reminders' && 'daily_cost_cap_usd' in values) {
      const cap = values.daily_cost_cap_usd;
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
    if (msg.startsWith('BACKGROUND_BUDGET_NOT_CONFIGURED')) return json(res, 422, { error: { code: 'background_budget_not_configured', message: '该用途日预算未配置；请填写正数上限或明确选择无日上限后开启（null 不是无限）' } });
    if (msg.startsWith('BACKGROUND_EXECUTOR_NOT_READY')) return json(res, 422, { error: { code: 'background_executor_not_ready', message: '该用途的模型执行器未就绪，本次设置未保存；执行器就绪后可重试' } });
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
// —— P6（四仓审计 20261106，T17 后半）：自由活动显式入口——
//    用现有 background task/run 机制开**一次**明确有界活动窗口：kind=autonomous、
//    origin=free_activity、once、立即到期；执行/预算/让位沿既有调度器与
//    backgroundControl('free_activity') 门；合理多步后 background_complete/noop/
//    取消/超时均收口。不新增随机自醒或固定催促；下次活动必须再次显式安排。
if (route === 'POST /api/v1/background/free-activity') {
  if (!d.taskService) return json(res, 503, { error: { code: 'background_unavailable', message: '预约服务未装配' } });
  const opKey = String(req.headers['idempotency-key'] ?? '');
  if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
  const body = (await readJson(req, d)) as Record<string, unknown>;
  const note = typeof body.note === 'string' && body.note.trim().length > 0 ? body.note.trim().slice(0, 2000) : '自由活动窗口';
  const conversationId = typeof body.conversation_id === 'string' && body.conversation_id ? body.conversation_id : 'primary';
  const prior = d.db.prepare('SELECT id, payload_json FROM background_tasks WHERE conversation_id = ? AND client_operation_key = ?').get(conversationId, opKey) as { id: string; payload_json: string } | undefined;
  if (prior) {
    let same = false;
    try { same = JSON.stringify(JSON.parse(prior.payload_json)) === JSON.stringify({ note, source: 'free_activity' }); } catch { same = false; }
    if (!same) return json(res, 409, { error: { code: 'idempotency_conflict', message: '同幂等键对应不同请求' } });
    return json(res, 200, { task_id: prior.id, duplicate: true });
  }
  const id = genId('bgt');
  const nowIso = new Date().toISOString();
  // RB05（复审 20261106）：接通正式分派后暴露并修正 INSERT 占位/参数错位（旧 404 不可达未被执行）
  d.db.prepare(
    `INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, client_operation_key, created_at, updated_at)
     VALUES (?,?,'jiaming','autonomous',1,1,'once',?,?,?,?,NULL,?,'qiaosheng','free_activity',?,?,?)`,
  ).run(id, conversationId, nowIso, nowIso, 'Asia/Shanghai', null, JSON.stringify({ note, source: 'free_activity' }), opKey, nowIso, nowIso);
  return json(res, 201, { task_id: id, origin: 'free_activity', next_due_at: nowIso, note: `已安排一次有界自由活动：${note}` });
}
if (route === 'POST /api/v1/background/tasks') {
  const opKey = String(req.headers['idempotency-key'] ?? '');
  if (!opKey) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
  const body = (await readJson(req, d)) as Record<string, unknown>;
  if (body.kind === 'reminder') {
    // 普通提醒（无模型投递）保留直建；ID 由服务端生成（不再拼 Date.now，B14）
    const scheduleKind = body.schedule_kind ?? 'once';
    if (scheduleKind !== 'once' && scheduleKind !== 'daily') return json(res, 400, { error: { code: 'bad_schedule', message: 'reminder 的 schedule_kind 必须是 once|daily' } });
    if (typeof body.scheduled_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(body.scheduled_at) || Number.isNaN(Date.parse(body.scheduled_at))) {
      return json(res, 400, { error: { code: 'bad_scheduled_at', message: 'scheduled_at 必填且为带 Z/offset 的 RFC3339 时间（不暗补当前时间）' } });
    }
    const prior = d.db.prepare('SELECT id, scheduled_at, payload_json FROM background_tasks WHERE conversation_id = ? AND client_operation_key = ?').get(String(body.conversation_id ?? 'primary'), opKey) as { id: string; scheduled_at: string; payload_json: string } | undefined;
    if (prior) {
      // P5（四仓审计 20261106）：同 key 异参=冲突，不把另一请求的结果误当本请求完成
      const wantedPayload = JSON.stringify(body.payload && typeof body.payload === 'object' ? body.payload : { text: String(body.text ?? '') });
      let samePayload = false;
      try { samePayload = JSON.stringify(JSON.parse(prior.payload_json)) === JSON.stringify(JSON.parse(wantedPayload)); } catch { samePayload = prior.payload_json === wantedPayload; }
      if (prior.scheduled_at !== body.scheduled_at || !samePayload) return json(res, 409, { error: { code: 'idempotency_conflict', message: '同幂等键对应不同请求' } });
      return json(res, 200, { task_id: prior.id, duplicate: true });
    }
    const id = genId('bgt');
    const nowIso = new Date().toISOString();
    d.db.prepare(
      `INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, origin, client_operation_key, created_at, updated_at)
       VALUES (?,?,'jiaming','reminder',1,1,?,?,?,'Asia/Shanghai',NULL,NULL,?,'qiaosheng','legacy_unknown',?,?,?)`,
    ).run(id, String(body.conversation_id ?? 'primary'), scheduleKind, body.scheduled_at as string, body.scheduled_at as string, JSON.stringify(body.payload && typeof body.payload === 'object' ? body.payload : { text: String(body.text ?? '') }), opKey, nowIso, nowIso);
    return json(res, 201, { task_id: id, next_due_at: body.scheduled_at });
  }
  // 自主预约只能由char通过 wake_manage 建立。用户的话在心跳页预留，
  // 不转换成他自己的预约；保留上述普通提醒和独立自由活动入口。
  return json(res, 403, { error: { code: 'self_wake_owner_only', message: '自主预约只能由char自己安排。要留话请前往心跳页面。' } });
}
const bgTaskPut = /^PUT \/api\/v1\/background\/tasks\/([^/]+)$/.exec(route);
if (bgTaskPut) {
  if (!d.taskService) return json(res, 503, { error: { code: 'background_unavailable', message: '预约服务未装配' } });
  const ifMatch = String(req.headers['if-match'] ?? '').replace(/"/g, '');
  if (!ifMatch || !/^\d+$/.test(ifMatch)) return json(res, 428, { error: { code: 'precondition_required', message: '必须带 If-Match' } });
  if (!String(req.headers['idempotency-key'] ?? '')) return json(res, 400, { error: { code: 'missing_idempotency', message: '缺少 Idempotency-Key' } });
  const body = (await readJson(req, d)) as Record<string, unknown>;
  const r = d.taskService.update({
    actorId: 'jiaming', updatedBy: 'qiaosheng', conversationId: String(body.conversation_id ?? 'primary'), operationId: String(req.headers['idempotency-key']),
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
  const params: Array<string | number> = [`${MORNING_WAKE_OCCURRENCE_PREFIX}%`, conversationId];
  const after = cursorParts ? ' AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))' : '';
  if (cursorParts) params.push(cursorParts[0]!, cursorParts[0]!, cursorParts[1]!);
  params.push(limit + 1);
  // 08 瘦返回：来源（trigger_origin 从 task origin 派生）/状态/实际派发时间/动作与
  // 发布计数/成本/阻断原因——不含原 payload、工具 JSON、reasoning 或聊天正文。
  const rows = d.db.prepare(
    `SELECT r.id, r.task_id, r.kind, r.state, r.result_code, r.cancel_reason, t.created_by_actor_id AS created_by,
            CASE WHEN r.kind='heartbeat_memory' THEN 'heartbeat_memory' WHEN t.origin = 'self_schedule' THEN 'self_wake' WHEN r.kind = 'keepwarm' THEN 'keepwarm' WHEN r.kind='autonomous' THEN 'free_activity' ELSE 'reminder' END AS trigger_origin,
            CASE WHEN r.kind = 'keepwarm' THEN CASE WHEN r.occurrence_key LIKE ? THEN 'morning_wake' ELSE 'cache_idle' END END AS keepwarm_source,
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
