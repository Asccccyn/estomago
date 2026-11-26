// modules/voice/call-service.ts（P03.5/P03.6）：通话控制用例。
// 原 HostToolExecutor.callControl 逐字迁移；accept_call 的直接 fetch/环境变量读取
// JV-06（联合审计 2026-10-26）：建呼经注入的 SirenAdapter.createCall（与邀请族同源配置）。
import { tx, type Db } from '../../db/connection.ts';
import type { SirenAdapter } from '../../integrations/siren/adapter.ts';
import type { CapabilityOutcome, ToolExecContext } from '../../capabilities/contracts.ts';
import type { SurfacingService } from '../../memory-surfacing/service.ts';

export type CallControlInput = { action: 'invite' | 'status' | 'end' | 'cancel' | 'accept_call' | 'decline_call'; ttl_seconds?: number };

/** 生命周期重构（复核 20261104 R3）："是否真实建立过通话"的**统一证据解释器**。
 *  根因修正：connected_at 只证明"register 通知到达过"，为空不等于从未连接（通知可丢）。
 *  证据（任一成立即视为真实通话）：
 *  a) connected_at 非空——register 通知到达，或真实话轮到达时回填（voice-stream）；
 *  b) 该 call 有真实接纳的语音话轮（voice_stream_turns）——话轮经通话 WS 抵达，是硬证据；
 *  c) S 权威事实 started_at（对账/查询路径传入，来自 S call_sessions 持久行）；
 *  d) lifecycle end 回调携带的 had_session 正本事实（RV02 复审 20261106：onDestroyed=true、
 *     预留终止=started_at null——从未连接的预留取消不再被任何 end 通知冒充真实会话）。
 *  四皆无的收口（未连接预留到期）不产生结束事实（R2 语义保留）。 */
export type RealSessionEvidence = { sirenStartedAt?: number | null; lifecycleEnd?: boolean };
export function callHadRealSession(db: Db, callId: string, external?: RealSessionEvidence): boolean {
  const row = db.prepare('SELECT connected_at FROM voice_calls WHERE call_id=?').get(callId) as { connected_at: string | null } | undefined;
  if (!row) return false;
  if (row.connected_at !== null) return true;
  if (external?.lifecycleEnd === true) return true;
  if (external?.sirenStartedAt != null) return true;
  return Boolean(db.prepare('SELECT 1 FROM voice_stream_turns WHERE call_id=? LIMIT 1').get(callId));
}

/** F01（四仓审计 20261104）：通话**确认终态**的共同出口——更新投影 + 登记同 call 幂等的
 *  pending_program_facts 事实（随下一次正常文字轮附带，B4 合同）。
 *  调用方限定两类：Siren lifecycle end 回调（正本确认结束）与宿主对账（正本 ended/
 *  无此通话）。前端面板挂断与模型 end 工具**不走这里**——requestHangup 只是
 *  可取消的 linger 意图，S 仍可接受新输入，不能凭意图登记"通话已结束"（真假事实混用）。
 *  幂等：投影只在 active→ended 时更新；事实主键 call_end:{callId}，INSERT OR IGNORE。
 *  是否登记事实由 callHadRealSession 统一判定（证据见其注释）。 */
export function endCallConfirmed(db: Db, callId: string, external?: RealSessionEvidence): { ended: boolean; factRegistered: boolean } {
  const now = new Date().toISOString();
  const upd = db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE call_id=? AND state='active'").run(now, callId);
  const ended = Number(upd.changes) === 1;
  const conv = db.prepare("SELECT conversation_id FROM voice_calls WHERE call_id=? AND state='ended'").get(callId) as { conversation_id: string } | undefined;
  let factRegistered = false;
  if (conv && callHadRealSession(db, callId, external)) {
    db.prepare('INSERT OR IGNORE INTO pending_program_facts(id, conversation_id, kind, fact_text, created_at) VALUES (?,?,?,?,?)')
      .run(`call_end:${callId}`, conv.conversation_id, 'call_end', '语音通话已结束。本轮回到文字聊天。', now);
    factRegistered = true;
  }
  return { ended, factRegistered };
}

/** E02（四仓审计 20261104）：voice_calls active 判定的单一窄能力。
 *  model-bridge（工具可见性/执行门）、executor（memory_only 最后边界）与
 *  supervisor（B4 事实消费条件）共用同一判定；通用桥不再各自手写表结构 SQL。 */
export function isVoiceCallActive(db: Db, conversationId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM voice_calls WHERE conversation_id=? AND state='active' LIMIT 1").get(conversationId));
}

// 同一邀请的建呼执行位同时代表当前准备活动；跟随实际请求结束，不借用响铃 TTL。
const inviteHandoffs = new WeakMap<Db, Map<string, { conversationId: string; completion: Promise<boolean> }>>();

/** Sol 与后台忙时准入共用：未到期响铃、实际建呼准备、预留/已建立通话。 */
export function isCallActivityActive(db: Db, conversationId: string, nowMs: number = Date.now()): boolean {
  if (isVoiceCallActive(db, conversationId)) return true;
  for (const handoff of inviteHandoffs.get(db)?.values() ?? []) {
    if (handoff.conversationId === conversationId) return true;
  }
  if (Boolean(db.prepare(
    "SELECT 1 FROM dial_requests WHERE conversation_id=? AND state='pending' AND CAST(strftime('%s',created_at) AS INTEGER)*1000 + ttl_ms > ? LIMIT 1",
  ).get(conversationId, nowMs))) return true;
  return Boolean(db.prepare(
    "SELECT 1 FROM voice_invites WHERE conversation_id=? AND state='pending' AND expires_at > ? LIMIT 1",
  ).get(conversationId, nowMs));
}

export function ensureInviteHandoff(inviteId: string, conversationId: string, deps: {
  db: Db; sirenCall: SirenAdapter; surfacing?: SurfacingService | null;
}): Promise<boolean> {
  const { db, sirenCall, surfacing } = deps;
  if (db.prepare('SELECT 1 FROM invite_call_handoffs WHERE invite_id=?').get(inviteId)) return Promise.resolve(false);
  let gates = inviteHandoffs.get(db);
  if (!gates) { gates = new Map(); inviteHandoffs.set(db, gates); }
  const existing = gates.get(inviteId);
  if (existing) return existing.completion;

  // 先登记执行位再开始异步工作；初次与失败后的重试都有同一准备边界，其他接听者
  // 等待同一请求。成功提交后由 voice_calls 接管活动，失败则 finally 释放本次执行位。
  const completion = Promise.resolve().then(async () => {
    surfacing?.cancelForActiveCall(conversationId);
    const created = await sirenCall.createCall(conversationId);
    if (!created.ok) throw new Error(created.code);
    const now = new Date().toISOString();
    tx(db, () => {
      db.prepare('INSERT INTO invite_call_handoffs(invite_id,call_id,ws_url,call_token,expires_at,created_at) VALUES (?,?,?,?,?,?)')
        .run(inviteId, created.callId, created.wsUrl, created.token, created.expiresAt ?? null, now);
      db.prepare("INSERT OR REPLACE INTO voice_calls(call_id,conversation_id,state,started_at,reserved_until,analysis_mode) VALUES (?,?,'active',?,?,?)")
        .run(created.callId, conversationId, now, created.expiresAt ?? null, 'ordinary');
    });
    return true;
  }).finally(() => { gates.delete(inviteId); });
  gates.set(inviteId, { conversationId, completion });
  return completion;
}

export class VoiceCallService {
  private readonly db: Db;
  private readonly sirenCall: SirenAdapter | null;
  private readonly surfacing: import('../../memory-surfacing/service.ts').SurfacingService | null | undefined;

  constructor(deps: { db: Db; sirenCall: SirenAdapter | null; surfacing?: import('../../memory-surfacing/service.ts').SurfacingService | null }) {
    this.db = deps.db;
    this.sirenCall = deps.sirenCall;
    this.surfacing = deps.surfacing;
  }

  /** 协议①（2026-10-24）：通话控制。逐字迁移（含备注文案与错误码）。 */
  async control(args: CallControlInput, ctx: ToolExecContext): Promise<CapabilityOutcome<Record<string, unknown>>> {
    // 她→他的接/拒只动本地 dial_requests（decline）/或自带 Siren 不可达的如实分支（accept）——
    // 不设全局 Siren 门；他→她的 invite/status/cancel/end 仍需 Siren 邀请服务
    if (args.action !== 'accept_call' && args.action !== 'decline_call' && (!this.sirenCall || this.sirenCall.status !== 'available')) {
      return { ok: false, error: { error_code: 'INTEGRATION_UNCONFIGURED', detail: 'Siren 通话服务未接入（能力缺口，如实拒绝）' } };
    }
    try {
      if (args.action === 'invite') {
        const invite = await this.sirenCall!.createInvite(ctx.roomId, { ttlSeconds: args.ttl_seconds });
        if (!invite) return { ok: false, error: { error_code: 'SIREN_NOT_CONFIGURED' } };
        // RB2-01：S 为邀请正本；E 落忠实投影供同步准入（Sol 门/忙时判定按
        // expires_at 读时解释，不依赖前端轮询）。接听/拒接由路由收口 ended。
        this.db.prepare("INSERT OR REPLACE INTO voice_invites(invite_id, conversation_id, state, expires_at, created_at) VALUES (?,?,'pending',?,?)")
          .run(invite.inviteId, ctx.roomId, invite.expiresAt, new Date().toISOString());
        // 通话活动开始（他向她响铃）——统一触发在途 Sol 作业失效
        this.surfacing?.cancelForActiveCall(ctx.roomId);
        return { ok: true, value: { invite_id: invite.inviteId, state: 'pending', expires_at: invite.expiresAt, note: '邀请已发出：她的页面会显示来电；接听/拒接由她决定，过期由服务端回收，未接不等于拒接' } };
      }
      if (args.action === 'accept_call' || args.action === 'decline_call') {
        // RB2-01：accept/decline 共用同一到期规则——过期请求不再是"等待中"，
        // 不能因前端未轮询而把过期 dial 当可接听的活动事实
        const req = this.db.prepare("SELECT id, analysis_mode FROM dial_requests WHERE conversation_id=? AND state='pending' AND CAST(strftime('%s',created_at) AS INTEGER)*1000 + ttl_ms > ? ORDER BY created_at DESC LIMIT 1").get(ctx.roomId, Date.now()) as { id: string; analysis_mode: string | null } | undefined;
        if (!req) return { ok: false, error: { error_code: 'NO_PENDING_DIAL', detail: '没有等待中的通话请求（可能已过期或已处理）' } };
        if (args.action === 'decline_call') {
          this.db.prepare("UPDATE dial_requests SET state='declined', updated_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(), req.id);
          // B5：不强制说明——拒绝事实如实回执，说不说由他在原续轮自主决定
          return { ok: true, value: { request_id: req.id, state: 'declined', note: '已拒绝。她那边会显示你没接；回复里想说什么自己决定，不说也可以。' } };
        }
        // accept_call：est 建 Siren 通话，连接信息挂到请求上（前端轮询取走）
        // JV-06（联合审计 2026-10-26）：建呼走注入的 SirenAdapter（正式
        // config.integrations.siren 装配，与邀请族同一来源）——不再读
        // env-only 的第二套变量，否则正式 config 部署下 accept_call 误报未配置。
        if (!this.sirenCall) return { ok: false, error: { error_code: 'SIREN_UNCONFIGURED', detail: 'Siren 通话服务未配置（无法接听）' } };
        const created = await this.sirenCall.createCall(ctx.roomId);
        if (!created.ok) {
          if (created.code === 'SIREN_UNREACHABLE') return { ok: false, error: { error_code: 'SIREN_UNREACHABLE', detail: '通话服务不可达，稍后可再试 accept_call' } };
          if (created.code === 'SIREN_CALL_FAILED') return { ok: false, error: { error_code: 'SIREN_CALL_FAILED', detail: `建呼失败（${created.httpStatus ?? ''}）` } };
          return { ok: false, error: { error_code: 'SIREN_CONTRACT_INVALID' } };
        }
        const upd = this.db.prepare("UPDATE dial_requests SET state='accepted', ws_url=?, call_token=?, call_id=?, updated_at=? WHERE id=? AND state='pending'").run(created.wsUrl, created.token, created.callId, new Date().toISOString(), req.id);
        if (upd.changes === 0) return { ok: false, error: { error_code: 'DIAL_SUPERSEDED', detail: '她已取消或请求已过期' } };
        // P1：模式沿用她发起 dial 时的选择（NULL=历史未记录→ordinary）
        this.db.prepare("INSERT OR REPLACE INTO voice_calls(call_id,conversation_id,state,started_at,reserved_until,analysis_mode) VALUES (?,?,'active',?,?,?)").run(created.callId, ctx.roomId, new Date().toISOString(), created.expiresAt ?? null, req.analysis_mode === 'deep_listen' ? 'deep_listen' : 'ordinary');
        // RB01（复审 20261106）：接听建呼=通话活动事实写入——统一触发 Sol 浮现作业失效
        this.surfacing?.cancelForActiveCall(ctx.roomId);
        return { ok: true, value: { request_id: req.id, state: 'accepted', call_id: created.callId, note: '已接听；她那边的电话面板马上会接通，正常和她说话即可。' } };
      }
      if (args.action === 'cancel') {
        const st = await this.sirenCall!.listInvites(ctx.roomId);
        const active = st?.active as { invite_id?: string } | null | undefined;
        if (!st || !active || typeof active.invite_id !== 'string') return { ok: false, error: { error_code: 'NO_PENDING_INVITE', detail: '没有待取消的邀请（可能已过期或已被处理）' } };
        const out = await this.sirenCall!.cancelInvite(active.invite_id);
        if ((out?.['state'] as string | undefined) !== 'cancelled') return { ok: false, error: { error_code: 'SIREN_INVITE_TRANSITION_FAILED', detail: `终态=${String(out?.['state'] ?? 'unknown')}` } };
        // R3-B01：取消已由 S 正本确认——E 侧邀请投影同步收口（此前镜像保持 pending 到
        // TTL，取消后的新文字被误抑制 Sol）
        this.db.prepare("UPDATE voice_invites SET state='ended', ended_at=? WHERE invite_id=? AND state='pending'")
          .run(new Date().toISOString(), String(active.invite_id));
        // B5（联合审计 2026-10-27，A08 执行口径）：取消不再追加独立说明轮——本工具回执
        // 即事实，说不说由原续轮的模型自主决定，不强迫解释、不多付一轮。
        // （旧 invite_cancelled 程序事实轮删除：曾强制"说一两句——说明原因或改约"。）
        return { ok: true, value: { invite_id: active.invite_id, state: 'cancelled', note: '邀请已取消；本回复里想对她说什么自己决定（也可以用 chat_send_voice 留语音），不说也可以' } };
      }
      if (args.action === 'end') {
        // A11：模型提出挂断——找本会话 active 通话，转 Siren 柔性挂断（立即回执）。
        // est 的 voice_calls 终态由前端面板挂断/收口链处理（本动作不伪造已结束）
        const row = this.db.prepare("SELECT call_id FROM voice_calls WHERE conversation_id=? AND state='active' ORDER BY started_at DESC LIMIT 1").get(ctx.roomId) as { call_id: string } | undefined;
        if (!row) return { ok: false, error: { error_code: 'NO_ACTIVE_CALL', detail: '当前没有进行中的通话' } };
        const out = await this.sirenCall!.requestHangup(row.call_id);
        if (!out) return { ok: false, error: { error_code: 'SIREN_NOT_CONFIGURED' } };
        return { ok: true, value: { call_id: row.call_id, accepted: out.accepted, note: '结束意图已接受：等最后一段说完（约15秒窗口），她开口则取消；不是立即挂断' } };
      }
      const list = await this.sirenCall!.listInvites(ctx.roomId);
      if (!list) return { ok: false, error: { error_code: 'SIREN_NOT_CONFIGURED' } };
      return { ok: true, value: { active: list.active, recent: list.recent.slice(0, 3) } };
    } catch (err) {
      return { ok: false, error: { error_code: String((err as Error).message ?? err).slice(0, 40) || 'SIREN_CALL_FAILED' } };
    }
  }
}
