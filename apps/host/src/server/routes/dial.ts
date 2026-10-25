// server/routes/dial.ts（P07.2 第六批a）：前端建呼代理与她→他通话请求/来电邀请组。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序/响应与错误码逐字保持（Siren 内部凭据不进前端）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import type { RequestDeps } from '../http.ts';

/** 建呼/通话请求/邀请组：dial、dial/current、dial cancel、calls 建立与收口、invites、invite accept/decline。 */
export async function handleDialRoutes(req: IncomingMessage, res: ServerResponse, d: RequestDeps, route: string): Promise<void> {
// —— B2/RE-04（2026-10-24）：正式前端建呼代理（owner 面）——est 后端持 Siren 内部地址，
//    短 call token 只回给本次通话的页面（Siren 内部凭据不进前端）；同键立册 voice_calls
//    （memory_only 生效）。挂断：DELETE /api/v1/calls/:callId（est 收口；WS 1000 由面板关闭）。
// —— 她→他通话请求（2026-10-24 她要的功能：她发起，char可接可拒）——
//     pending → accepted（他接：est 建 Siren 通话，连接信息挂请求上供前端取）
//            | declined（他拒：他的话=拒绝轮正文自然落会话）
//            | cancelled（她关面板/挂断等待）| expired（惰性判定，轮询时收口）
const DIAL_DEFAULT_TTL_MS = 45_000;
const dialExpireLazy = (now: number): void => {
  d.db.prepare("UPDATE dial_requests SET state='expired', updated_at=? WHERE state='pending' AND CAST(strftime('%s',created_at) AS INTEGER)*1000 + ttl_ms < ?")
    .run(new Date().toISOString(), now);
};
const dialCurrent = (): Record<string, unknown> | null => {
  dialExpireLazy(Date.now());
  const row = d.db.prepare("SELECT * FROM dial_requests WHERE conversation_id='primary' AND state IN ('pending','accepted','declined','expired') ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    request_id: row['id'], state: row['state'],
    ...(row['state'] === 'accepted' ? { ws_url: row['ws_url'], token: row['call_token'], call_id: row['call_id'] } : {}),
  };
};
if (route === 'POST /api/v1/calls/dial') {
  // 已有待处理请求：幂等返回（重复点击不重建）
  const cur = dialCurrent();
  if (cur && (cur['state'] === 'pending' || cur['state'] === 'accepted')) return json(res, 200, cur);
  const id = `dial_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const nowIso = new Date().toISOString();
  d.db.prepare("INSERT INTO dial_requests(id,conversation_id,state,ttl_ms,created_at,updated_at) VALUES (?,'primary','pending',?,?,?)").run(id, DIAL_DEFAULT_TTL_MS, nowIso, nowIso);
  // 告诉char（程序事实轮，同串行链；他闲着就立刻收到）
  try {
    d.supervisor.submitProgramFactTurn('primary', 'incoming_dial',
      `她刚刚发起语音通话请求（等你接听，约 45 秒内有效）。接听：调用 call_control，action=accept_call。拒绝：调用 call_control，action=decline_call，并在同一回复里自然地对她说一句为什么不方便或改约——她会看到你的话，通话不开始。超时不选即过期。`,
      `dial:${id}`);
  } catch { /* 事实轮失败=请求保持 pending 到期（如实降级） */ }
  return json(res, 200, { request_id: id, state: 'pending', note: '正在等char接听' });
}
if (route === 'GET /api/v1/calls/dial/current') {
  return json(res, 200, dialCurrent() ?? { state: 'idle' });
}
const dialCancel = /^DELETE \/api\/v1\/calls\/dial\/([^/]+)$/.exec(route);
if (dialCancel) {
  d.db.prepare("UPDATE dial_requests SET state='cancelled', updated_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(), dialCancel[1]!);
  return json(res, 200, { request_id: dialCancel[1]!, state: 'cancelled' });
}

if (route === 'POST /api/v1/calls') {
  const rawBody = (await readJson(req, d, 16 * 1024)) as { conversation_id?: unknown } | null;
  if (typeof rawBody?.conversation_id !== 'string' || !rawBody.conversation_id) return json(res, 400, { error: { code: 'bad_conversation', message: 'conversation_id 必填' } });
  if (!d.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(rawBody.conversation_id)) return json(res, 404, { error: { code: 'not_found', message: '会话不存在' } });
  const sirenBase = process.env.ESTOMAGO_SIREN_BASE_URL;
  if (!sirenBase) return json(res, 503, { error: { code: 'siren_unconfigured', message: 'Siren 通话服务未配置（能力缺口，如实拒绝）' } });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const sirenToken = process.env.ESTOMAGO_SIREN_INTERNAL_TOKEN;
  if (sirenToken) headers.Authorization = `Bearer ${sirenToken}`;
  let sirenRes: Response;
  try {
    sirenRes = await fetch(`${sirenBase.replace(/\/$/, '')}/v1/calls`, { method: 'POST', headers, body: JSON.stringify({ conversation_id: rawBody.conversation_id }), signal: AbortSignal.timeout(5000) });
  } catch {
    return json(res, 502, { error: { code: 'siren_unreachable', message: 'Siren 通话服务不可达（文字聊天不受影响）' } });
  }
  if (!sirenRes.ok) {
    const body = await sirenRes.text().catch(() => '');
    return json(res, 502, { error: { code: 'siren_call_failed', message: `Siren 建呼失败（${sirenRes.status}）：${body.slice(0, 120)}` } });
  }
  const created = await sirenRes.json() as { call_id?: string; ws_url?: string; token?: string; expires_at?: string };
  if (typeof created.call_id !== 'string' || typeof created.ws_url !== 'string' || typeof created.token !== 'string') {
    return json(res, 502, { error: { code: 'siren_contract_invalid', message: 'Siren 建呼回执合同不符' } });
  }
  d.db.prepare("INSERT OR REPLACE INTO voice_calls(call_id,conversation_id,state,started_at) VALUES (?,?,'active',?)")
    .run(created.call_id, rawBody.conversation_id, new Date().toISOString());
  return json(res, 200, { call_id: created.call_id, ws_url: created.ws_url, token: created.token, ...(typeof created.expires_at === 'string' ? { expires_at: created.expires_at } : {}), memory_only: true });
}
const estCallEnd = /^DELETE \/api\/v1\/calls\/([^/]+)$/.exec(route);
if (estCallEnd) {
  const callId = decodeURIComponent(estCallEnd[1]!);
  const row = d.db.prepare('SELECT state FROM voice_calls WHERE call_id=?').get(callId) as { state: string } | undefined;
  if (!row) return json(res, 404, { error: { code: 'not_found', message: '通话不存在' } });
  if (row.state === 'active') d.db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE call_id=?").run(new Date().toISOString(), callId);
  return json(res, 200, { call_id: callId, state: 'ended' });
}

// —— 协议①（2026-10-24）：来电邀请前端面（owner）——est 代理 Siren（内部凭据不进前端）。
//    来电横幅/未接卡片的数据源；接听→前端再走既有 /api/v1/calls 建通话；拒接直接落终态。
if (route === 'GET /api/v1/calls/invites') {
  if (!d.sirenCall) return json(res, 503, { error: { code: 'siren_unconfigured', message: 'Siren 通话服务未配置' } });
  try {
    const list = await d.sirenCall.listInvites('primary');
    return json(res, 200, list ?? { active: null, recent: [] });
  } catch (err) {
    return json(res, 502, { error: { code: 'siren_invite_query_failed', message: String((err as Error).message ?? err).slice(0, 120) } });
  }
}
const inviteAction = /^POST \/api\/v1\/calls\/invites\/([^/]+)\/(accept|decline)$/.exec(route);
if (inviteAction) {
  if (!d.sirenCall) return json(res, 503, { error: { code: 'siren_unconfigured', message: 'Siren 通话服务未配置' } });
  try {
    const out = await d.sirenCall.transitionInvite(decodeURIComponent(inviteAction[1]!), inviteAction[2] === 'accept' ? 'accept' : 'decline');
    // 拒接留言调度①（2026-10-24）：她拒接 → char反应轮（他说一两句落本会话；
    // 程序事实注入，不伪造她的话；幂等——重复拒接/重试不重建）
    if (inviteAction[2] === 'decline' && (out?.['state'] as string | undefined) === 'declined') {
      try {
        const hm = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        d.supervisor.submitProgramFactTurn('primary', 'invite_declined',
          `她于 ${hm} 拒接了你发起的来电（这是她自己的选择，不是故障）。`,
          `invite:${inviteAction[1]}:declined`);
      } catch { /* 反应轮失败不拖垮拒接响应（如实降级：他不说这句） */ }
    }
    return json(res, 200, out ?? {});
  } catch (err) {
    return json(res, 502, { error: { code: 'siren_invite_transition_failed', message: String((err as Error).message ?? err).slice(0, 120) } });
  }
}
}
