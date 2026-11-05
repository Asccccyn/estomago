// modules/voice/call-service.ts（P03.5/P03.6）：通话控制用例。
// 原 HostToolExecutor.callControl 逐字迁移；accept_call 的直接 fetch/环境变量读取
// JV-06（联合审计 2026-10-26）：建呼经注入的 SirenAdapter.createCall（与邀请族同源配置）。
import type { Db } from '../../db/connection.ts';
import type { SirenAdapter } from '../../integrations/siren/adapter.ts';
import type { CapabilityOutcome, ToolExecContext } from '../../capabilities/contracts.ts';

export type CallControlInput = { action: 'invite' | 'status' | 'end' | 'cancel' | 'accept_call' | 'decline_call'; ttl_seconds?: number };

/** F01（四仓审计 20261104）：通话**确认终态**的共同出口——更新投影 + 登记同 call 幂等的
 *  pending_program_facts 事实（随下一次正常文字轮附带，B4 合同）。
 *  调用方限定两类：Siren lifecycle end 回调（正本确认结束）与宿主对账（正本 ended/
 *  无此通话）。前端面板挂断与模型 end 工具**不走这里**——requestHangup 只是
 *  可取消的 linger 意图，S 仍可接受新输入，不能凭意图登记"通话已结束"（真假事实混用）。
 *  幂等：投影只在 active→ended 时更新；事实主键 call_end:{callId}，INSERT OR IGNORE。
 *  R2（复核 20261104）：从未连接的建呼预留（connected_at IS NULL）收口**不登记**
 *  "通话已结束"事实——预留失效≠已建立通话的结束。仅真正连接过的通话产生该事实。 */
export function endCallConfirmed(db: Db, callId: string): { ended: boolean; factRegistered: boolean } {
  const now = new Date().toISOString();
  const upd = db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE call_id=? AND state='active'").run(now, callId);
  const ended = Number(upd.changes) === 1;
  const conv = db.prepare("SELECT conversation_id, connected_at FROM voice_calls WHERE call_id=? AND state='ended'").get(callId) as { conversation_id: string; connected_at: string | null } | undefined;
  let factRegistered = false;
  if (conv && conv.connected_at !== null) {
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

export class VoiceCallService {
  private readonly db: Db;
  private readonly sirenCall: SirenAdapter | null;

  constructor(deps: { db: Db; sirenCall: SirenAdapter | null }) {
    this.db = deps.db;
    this.sirenCall = deps.sirenCall;
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
        return { ok: true, value: { invite_id: invite.inviteId, state: 'pending', expires_at: invite.expiresAt, note: '邀请已发出：她的页面会显示来电；接听/拒接由她决定，过期由服务端回收，未接不等于拒接' } };
      }
      if (args.action === 'accept_call' || args.action === 'decline_call') {
        const req = this.db.prepare("SELECT id, analysis_mode FROM dial_requests WHERE conversation_id=? AND state='pending' ORDER BY created_at DESC LIMIT 1").get(ctx.roomId) as { id: string; analysis_mode: string | null } | undefined;
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
        return { ok: true, value: { request_id: req.id, state: 'accepted', call_id: created.callId, note: '已接听；她那边的电话面板马上会接通，正常和她说话即可。' } };
      }
      if (args.action === 'cancel') {
        const st = await this.sirenCall!.listInvites(ctx.roomId);
        const active = st?.active as { invite_id?: string } | null | undefined;
        if (!st || !active || typeof active.invite_id !== 'string') return { ok: false, error: { error_code: 'NO_PENDING_INVITE', detail: '没有待取消的邀请（可能已过期或已被处理）' } };
        const out = await this.sirenCall!.cancelInvite(active.invite_id);
        if ((out?.['state'] as string | undefined) !== 'cancelled') return { ok: false, error: { error_code: 'SIREN_INVITE_TRANSITION_FAILED', detail: `终态=${String(out?.['state'] ?? 'unknown')}` } };
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
