// server/routes/voice-call.ts（P07.1 第一批）：通话生命周期路由（专用 token 面）。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序/响应与错误码逐字保持（A23 同一领域服务面）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import type { RequestDeps } from '../http.ts';
import { endCallConfirmed } from '../../modules/voice/call-service.ts';

/** B2（2026-10-24）：通话生命周期（专用 token 面）——POST /v1/calls 立册 active（memory_only 生效），
 *  DELETE /v1/calls/:id 挂断收口（幂等）。Siren CallSession 建立即调；未显式调用时首个电话轮自动立册。 */
export async function handleVoiceCallLifecycle(req: IncomingMessage, res: ServerResponse, d: RequestDeps, route: string): Promise<void> {
  const ndjsonError = (status: number, message: string): void => {
    json(res, status, { error: { code: 'voice_call_error', message } });
  };
  const token = process.env.ESTOMAGO_VOICE_INGRESS_TOKEN;
  if (!token || !token.trim()) return ndjsonError(503, 'voice ingress not configured');
  const authz = String(req.headers.authorization ?? '');
  if (authz !== `Bearer ${token}`) return ndjsonError(401, 'unauthorized');
  const nowIso = new Date().toISOString();
  if (route === 'POST /v1/calls') {
    let body: { call_id?: unknown; conversation_id?: unknown };
    try { body = (await readJson(req, d, 64 * 1024)) as typeof body; } catch { return ndjsonError(400, 'invalid body'); }
    const idOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
    if (!idOk(body.call_id) || !idOk(body.conversation_id)) return ndjsonError(422, 'call_id and conversation_id required');
    if (!d.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(body.conversation_id)) return ndjsonError(404, 'conversation not found');
    const existing = d.db.prepare('SELECT state FROM voice_calls WHERE call_id=?').get(body.call_id) as { state: string } | undefined;
    if (existing?.state === 'active') {
      // 复审二 R-03B：Siren WS 会话注册=该通话真实建立连接的事实——记录 connected_at。
      // 连接 token 过期只影响新握手、不结束通话；接听重放的收口判定以此事实为据。
      d.db.prepare('UPDATE voice_calls SET connected_at=COALESCE(connected_at, ?) WHERE call_id=?').run(nowIso, body.call_id);
      // RB01（复审 20261106）：通话活动事实写入处统一触发 Sol 作业失效——
      // S register 建立的新通话也要中止在途 preparing 浮现（复审反例4）
      d.surfacing?.cancelForActiveCall?.(body.conversation_id);
      return json(res, 200, { call_id: body.call_id, state: 'active' });
    }
    if (existing?.state === 'ended') return ndjsonError(409, 'call already ended (new call needs a new call_id)');
    // 调用方=Siren lifecycle register（WS 会话注册）：立册即已连接
    d.db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at,connected_at) VALUES (?,?,\'active\',?,?)".replace("\\'", "'")).run(body.call_id, body.conversation_id, nowIso, nowIso);
    // RB01（复审 20261106）：同上——活动事实写入处触发 Sol 作业失效
    d.surfacing?.cancelForActiveCall?.(body.conversation_id);
    return json(res, 200, { call_id: body.call_id, state: 'active', memory_only: true });
  }
  const m = /^DELETE \/v1\/calls\/([^/]+)$/.exec(route);
  const callId = decodeURIComponent(m?.[1] ?? '');
  const row = d.db.prepare('SELECT state FROM voice_calls WHERE call_id=?').get(callId) as { state: string } | undefined;
  if (!row) return ndjsonError(404, 'call not found');
  // RV02（复审 20261106）：end 通知体携带 S 正本 had_session 事实（onDestroyed=真实会话；
  // 预留终止=started_at 为 null）。缺席（旧形态/无 body）按 false——真实通话的证据仍由
  // connected_at/voice_stream_turns/对账 started_at 提供，不靠任何 end 通知冒充。
  let endBody: { had_session?: unknown } = {};
  try { endBody = (await readJson(req, d, 64 * 1024)) as typeof endBody; } catch { /* 无 body=旧形态，按 false */ }
  const hadSession = endBody.had_session === true;
  // F01（四仓审计 20261104）：Siren lifecycle end = 确认终态——统一走共同出口，包括投影
  // 已被前端命令先收口的场景（早退分支不补登记=旧缺口，审计 S-first 复现已覆盖）。
  // 幂等：投影 UPDATE 只在 active 生效；事实 INSERT OR IGNORE（恰一条）。
  endCallConfirmed(d.db, callId, { lifecycleEnd: hadSession }); // 终态收口照常；事实登记按正本会话事实
  return json(res, 200, { call_id: callId, state: 'ended' });
}