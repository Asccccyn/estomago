// server/routes/dial.ts（P07.2 第六批a）：前端建呼代理与她→他通话请求/来电邀请组。
// 自 server/http.ts 逐字搬迁：路径/方法/认证顺序/响应与错误码逐字保持（Siren 内部凭据不进前端）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson } from '../http-leaf.ts';
import type { RequestDeps } from '../http.ts';
import { SirenTranscriptionError, type SirenCallAudioTurn } from '../../integrations/siren/adapter.ts';
import { serveAudioContent } from './assets.ts';

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
  // F-04（跨仓预审 2026-10-25）：accepted 只在通话仍 active 时算"当前"——
  // 通话已结束（owner 收口或 Siren 终态同步）的旧 dial 不再作为 current 返回，
  // 重拨创建新请求拿到新 call/token，不再复用已吊销的旧连接信息。
  const row = d.db.prepare(
    "SELECT dr.* FROM dial_requests dr LEFT JOIN voice_calls vc ON vc.call_id = dr.call_id"
    + " WHERE dr.conversation_id='primary' AND (dr.state IN ('pending','declined','expired')"
    + " OR (dr.state='accepted' AND vc.state='active')) ORDER BY dr.created_at DESC LIMIT 1",
  ).get() as Record<string, unknown> | undefined;
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
  const dialBody = (await readJson(req, d, 16 * 1024)) as { analysis_mode?: unknown } | null;
  const dialMode = dialBody?.analysis_mode === 'deep_listen' ? 'deep_listen' : 'ordinary';
  const id = `dial_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const nowIso = new Date().toISOString();
  d.db.prepare("INSERT INTO dial_requests(id,conversation_id,state,ttl_ms,analysis_mode,created_at,updated_at) VALUES (?,'primary','pending',?,?,?,?)").run(id, DIAL_DEFAULT_TTL_MS, dialMode, nowIso, nowIso);
  // 告诉char（程序事实轮，同串行链；他闲着就立刻收到）
  try {
    d.supervisor.submitProgramFactTurn('primary', 'incoming_dial',
      `她刚刚发起语音通话请求（等你接听，约 45 秒内有效）。接听：调用 call_control，action=accept_call。拒绝：调用 call_control，action=decline_call，并在同一回复里自然地对她说一句为什么不方便或改约——她会看到你的话，通话不开始。超时不选即过期。`,
      `dial:${id}`);
  } catch { /* 事实轮失败=请求保持 pending 到期（如实降级） */ }
  return json(res, 200, { request_id: id, state: 'pending', note: '正在等char接听' });
}
// 文字仍以 est 消息为正本；Siren 提供逐轮音频事实，缺音频不能挤掉一个轮次。
if (route === 'GET /api/v1/calls/records') {
  const calls = d.db.prepare("SELECT call_id, conversation_id, state, analysis_mode, started_at, ended_at FROM voice_calls WHERE conversation_id='primary' ORDER BY started_at DESC LIMIT 20").all() as Array<{ call_id: string; conversation_id: string; state: string; analysis_mode: string | null; started_at: string | null; ended_at: string | null }>;
  const records = await Promise.all(calls.map(async (c) => {
    let mediaTurns: SirenCallAudioTurn[] = [];
    let mediaError: string | undefined;
    try {
      const result = await d.sirenCall?.callTurnAudio(c.call_id);
      if (Array.isArray(result)) mediaTurns = result;
      else mediaError = result === 'not_found' ? 'siren_call_not_found' : 'siren_unconfigured';
    } catch (err) {
      mediaError = err instanceof SirenTranscriptionError ? err.code.toLowerCase() : 'siren_unavailable';
    }
    const admissions = d.db.prepare("SELECT turn_key, est_turn_id, state FROM voice_stream_turns WHERE call_id=? ORDER BY created_at").all(c.call_id) as Array<{ turn_key: string; est_turn_id: string | null; state: string }>;
    const messages = d.db.prepare(
      "SELECT vst.turn_key, m.id AS message_id, m.speaker, m.sequence, m.current_revision, r.content, r.kind" +
      " FROM voice_stream_turns vst JOIN turns t ON t.id=vst.est_turn_id" +
      " JOIN messages m ON (m.id=t.input_message_id OR m.turn_id=t.id)" +
      " JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision" +
      " WHERE vst.call_id=? AND m.conversation_id=? AND m.speaker IN ('owner','assistant') ORDER BY m.sequence",
    ).all(c.call_id, c.conversation_id) as Array<{ turn_key: string; message_id: string; speaker: string; sequence: number; current_revision: number; content: string; kind: string }>;
    const byId = new Map(mediaTurns.map((turn) => [turn.turn_id, turn]));
    const ids = [...byId.keys(), ...admissions.map((a) => a.turn_key).filter((id) => !byId.has(id))];
    const turns = ids.map((id) => {
      const media = byId.get(id);
      const admission = admissions.find((a) => a.turn_key === id);
      const audio: Record<string, unknown> = {};
      const text = messages.filter((m) => m.turn_key === id).map((m) => {
        const attachment = d.db.prepare("SELECT asset_id, derived_text FROM message_attachments WHERE message_id=? AND revision=? AND presentation='voice' ORDER BY position LIMIT 1")
          .get(m.message_id, m.current_revision) as { asset_id: string; derived_text: string | null } | undefined;
        if (m.speaker === 'owner' && attachment) {
          audio.user = { asset_ref: `est:${attachment.asset_id}`, content_url: `/api/v1/assets/${encodeURIComponent(attachment.asset_id)}/content` };
        }
        return { message_id: m.message_id, speaker: m.speaker, sequence: m.sequence, kind: m.kind,
          text: m.content.trim() ? m.content : attachment?.derived_text ?? null };
      });
      for (const direction of ['user', 'reply'] as const) {
        const asset = direction === 'user' ? media?.user_audio : media?.reply_audio;
        if (asset && !audio[direction]) audio[direction] = {
          asset_ref: `siren:${asset.asset_id}`,
          content_url: `/api/v1/calls/${encodeURIComponent(c.call_id)}/turns/${encodeURIComponent(id)}/audio/${direction}`,
          duration_ms: asset.duration_ms,
          ...(direction === 'reply' ? { completeness: media!.reply_audio!.completeness } : {}),
        };
      }
      return { turn_id: id, text_state: admission?.state ?? null, outcome: media?.outcome ?? null,
        messages: text, audio, sent_audio_ms: media?.sent_audio_ms ?? null, filler_audio_ms: media?.filler_audio_ms ?? null,
        playback: media?.playback ?? { basis: 'unknown' } };
    });
    return { call_id: c.call_id, mode: c.analysis_mode, state: c.state, started_at: c.started_at, ended_at: c.ended_at,
      ...(mediaError ? { media_error: mediaError } : {}), turns };
  }));
  return json(res, 200, { schema_version: 1, records });
}
// owner 认证由 HTTP 入口统一执行；只允许本会话已登记的通话和 Siren 实际属于该轮的资产。
const callAudio = /^GET \/api\/v1\/calls\/([^/]+)\/turns\/([^/]+)\/audio\/(user|reply)$/.exec(route);
if (callAudio) {
  const callId = decodeURIComponent(callAudio[1]!);
  const turnId = decodeURIComponent(callAudio[2]!);
  if (!d.db.prepare("SELECT 1 FROM voice_calls WHERE call_id=? AND conversation_id='primary'").get(callId)) {
    return json(res, 404, { error: { code: 'not_found', message: '通话不存在' } });
  }
  if (!d.sirenCall) return json(res, 503, { error: { code: 'siren_unconfigured', message: '语音服务未配置' } });
  try {
    const turns = await d.sirenCall.callTurnAudio(callId);
    if (turns === null) return json(res, 503, { error: { code: 'siren_unconfigured', message: '语音服务未配置' } });
    const turn = Array.isArray(turns) ? turns.find((t) => t.turn_id === turnId) : undefined;
    const asset = callAudio[3] === 'user' ? turn?.user_audio : turn?.reply_audio;
    if (!asset) return json(res, 404, { error: { code: 'audio_not_found', message: '此轮没有留存的音频' } });
    const content = await d.sirenCall.fetchVoiceAssetAudio(asset.asset_id);
    if (!content) return json(res, 404, { error: { code: 'audio_not_found', message: '音频已不可用' } });
    return serveAudioContent(req, res, content.bytes, content.mime);
  } catch (err) {
    const code = err instanceof SirenTranscriptionError ? err.code.toLowerCase() : 'siren_unavailable';
    return json(res, 503, { error: { code, message: '音频暂不可用，请稍后重试' } });
  }
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
  const rawBody = (await readJson(req, d, 16 * 1024)) as { conversation_id?: unknown; analysis_mode?: unknown } | null;
  if (typeof rawBody?.conversation_id !== 'string' || !rawBody.conversation_id) return json(res, 400, { error: { code: 'bad_conversation', message: 'conversation_id 必填' } });
  if (!d.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(rawBody.conversation_id)) return json(res, 404, { error: { code: 'not_found', message: '会话不存在' } });
  // JV-06（联合审计 2026-10-26）：建呼经注入的 SirenAdapter（正式 config 装配，
  // 与邀请族同源）——删除 route 内 env-only 的重复 fetch，两套配置来源收敛为一套。
  if (!d.sirenCall) return json(res, 503, { error: { code: 'siren_unconfigured', message: 'Siren 通话服务未配置（能力缺口，如实拒绝）' } });
  const created = await d.sirenCall.createCall(rawBody.conversation_id);
  if (!created.ok) {
    if (created.code === 'SIREN_UNREACHABLE') return json(res, 502, { error: { code: 'siren_unreachable', message: 'Siren 通话服务不可达（文字聊天不受影响）' } });
    if (created.code === 'SIREN_CALL_FAILED') return json(res, 502, { error: { code: 'siren_call_failed', message: `Siren 建呼失败（${created.httpStatus ?? ''}）` } });
    return json(res, 502, { error: { code: 'siren_contract_invalid', message: 'Siren 建呼回执合同不符' } });
  }
  // P1（GLM_VOICE_UNIFICATION）：模式由服务端记录——ordinary（默认）/deep_listen；
  // 普通电话 0 自动 oído 由 voice-stream 按此分流
  const mode = rawBody.analysis_mode === 'deep_listen' ? 'deep_listen' : 'ordinary';
  d.db.prepare("INSERT OR REPLACE INTO voice_calls(call_id,conversation_id,state,started_at,reserved_until,analysis_mode) VALUES (?,?,'active',?,?,?)")
    .run(created.callId, rawBody.conversation_id, new Date().toISOString(), created.expiresAt ?? null, mode);
  return json(res, 200, { call_id: created.callId, ws_url: created.wsUrl, token: created.token, ...(created.expiresAt ? { expires_at: created.expiresAt } : {}), memory_only: true });
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
    // F-02（2026-10-25）+R-03（复审 2026-10-26/二）：接听交接在这里收口——
    // 邀请落定 accepted 后由宿主建 Siren 通话（内部凭据不进前端），连接信息随本次
    // 响应交付；前端不再另起"她→他"反向 dial。归属合同（invite_call_handoffs）：
    // - 并发首次接听唯一建呼：同一邀请的首个建呼只有一个执行者，后来者（另一页面/
    //   设备的合法首次 accept，或响应丢失后的重试）等待并消费同一归属结果；
    // - 重试取回**同一**交接（同 call_id/token），不重复建呼；
    // - token 过期≠通话结束（token 只管 WS 握手）：已连接（connected_at 有值，来自
    //   Siren register 通知）的通话如实告知"连接信息无法重新交付"且不动 voice_calls；
    //   从未连接且 token 过期=该 call 永不可连，才收口（有事实依据的清孤儿）。
    if (inviteAction[2] === 'accept' && (out?.['state'] as string | undefined) === 'accepted') {
      const inviteId = decodeURIComponent(inviteAction[1]!);
      let createdNow = false;
      try {
        createdNow = await ensureInviteHandoff(inviteId, d);
      } catch { /* 首次建呼失败：无归属，走下方如实分支 */ }
      const prior = d.db.prepare('SELECT call_id, ws_url, call_token, expires_at FROM invite_call_handoffs WHERE invite_id=?').get(inviteId) as { call_id: string; ws_url: string; call_token: string; expires_at: string | null } | undefined;
      if (!prior) {
        return json(res, 502, { error: { code: 'siren_call_failed', message: '邀请已接听但建呼失败——邀请保持 accepted，可稍后重试' }, ...(out ?? {}) });
      }
      const vc = d.db.prepare('SELECT state, connected_at FROM voice_calls WHERE call_id=?').get(prior.call_id) as { state: string; connected_at: string | null } | undefined;
      const expired = prior.expires_at !== null && Date.parse(prior.expires_at) <= Date.now();
      const replayMark = createdNow ? {} : { handoff_replayed: true };
      if (vc?.state === 'active' && !expired) {
        return json(res, 200, { ...(out ?? {}), call_id: prior.call_id, ws_url: prior.ws_url, token: prior.call_token, ...(prior.expires_at ? { expires_at: prior.expires_at } : {}), ...replayMark });
      }
      if (vc?.state === 'active' && expired) {
        if (vc.connected_at) {
          // 通话已真实建立（Siren WS 注册过）：token 过期只影响重新握手，不结束通话
          return json(res, 200, { ...(out ?? {}), call_id: prior.call_id, state: 'accepted', note: '该邀请已接听且通话已建立；连接信息已过期、无法重新交付——通话仍在进行可直接继续，若已断开请让他重新发起邀请' });
        }
        // 从未连接 + token 过期：该 call 永不可连（收口有事实依据，不凭 token 时效
        // 推断在途通话）——S 生命周期回调只覆盖已建立 WS 的会话，这里补收孤儿
        d.db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE call_id=? AND state='active'").run(new Date().toISOString(), prior.call_id);
        return json(res, 200, { ...(out ?? {}), call_id: prior.call_id, state: 'accepted', note: '接听连接已过期且通话从未建立——需要通话请让他重新发起邀请' });
      }
      return json(res, 200, { ...(out ?? {}), call_id: prior.call_id, state: 'accepted', note: '该邀请已接听，但通话已结束——需要通话请让他重新发起邀请' });
    }
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

/** R-03（复审二问题A）：同一邀请的首次建呼唯一执行——宿主单进程内并发接听
 *  （双页面/双设备同刻各发首次 accept）由该 gate 串行化：第一个请求执行建呼并写
 *  归属，其余请求等待其完成后按既有归属消费。归属行主键唯一（INSERT 非 REPLACE，
 *  不覆盖），跨进程竞态下输家的 INSERT 抛错、如实走建呼失败分支，不产生第二归属。 */
const inviteHandoffGates = new Map<string, Promise<boolean>>();
async function ensureInviteHandoff(inviteId: string, d: RequestDeps): Promise<boolean> {
  const existing = d.db.prepare('SELECT 1 FROM invite_call_handoffs WHERE invite_id=?').get(inviteId);
  if (existing) return false;
  let gate = inviteHandoffGates.get(inviteId);
  if (!gate) {
    gate = (async () => {
      // 双检：进入 gate 前可能已被并发赢家写归属
      const again = d.db.prepare('SELECT 1 FROM invite_call_handoffs WHERE invite_id=?').get(inviteId);
      if (again) return false;
      const created = await d.sirenCall!.createCall('primary');
      if (!created.ok) throw new Error(created.code);
      d.db.prepare('INSERT INTO invite_call_handoffs(invite_id,call_id,ws_url,call_token,expires_at,created_at) VALUES (?,?,?,?,?,?)')
        .run(inviteId, created.callId, created.wsUrl, created.token, created.expiresAt ?? null, new Date().toISOString());
      d.db.prepare("INSERT OR REPLACE INTO voice_calls(call_id,conversation_id,state,started_at,reserved_until,analysis_mode) VALUES (?,?,'active',?,?,?)").run(created.callId, 'primary', new Date().toISOString(), created.expiresAt ?? null, 'ordinary');
      return true;
    })().finally(() => { if (inviteHandoffGates.get(inviteId) === gate) inviteHandoffGates.delete(inviteId); }) as Promise<boolean>;
    inviteHandoffGates.set(inviteId, gate);
  }
  return await gate;
}
