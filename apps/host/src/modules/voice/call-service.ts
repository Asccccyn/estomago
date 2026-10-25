// modules/voice/call-service.ts（P03.5/P03.6）：通话控制用例。
// 原 HostToolExecutor.callControl 逐字迁移；accept_call 的直接 fetch/环境变量读取
// 抽到 integrations/siren/adapter.ts createCallFromInternalEnv（URL/认证/超时/unknown 语义不变）。
// 拒接/取消留言调度改走窄 ProgramFactsPort（只提交事实请求，不取得 Supervisor、不等待后继轮）。
import type { Db } from '../../db/connection.ts';
import type { SirenAdapter } from '../../integrations/siren/adapter.ts';
import { createCallFromInternalEnv } from '../../integrations/siren/adapter.ts';
import type { CapabilityOutcome, ProgramFactsPort, ToolExecContext } from '../../capabilities/contracts.ts';

export type CallControlInput = { action: 'invite' | 'status' | 'end' | 'cancel' | 'accept_call' | 'decline_call'; ttl_seconds?: number };

export class VoiceCallService {
  private readonly db: Db;
  private readonly sirenCall: SirenAdapter | null;
  private readonly programFacts: ProgramFactsPort | null;

  constructor(deps: { db: Db; sirenCall: SirenAdapter | null; programFacts?: ProgramFactsPort | null }) {
    this.db = deps.db;
    this.sirenCall = deps.sirenCall;
    this.programFacts = deps.programFacts ?? null;
  }

  /** 通话激活（voice_calls active）——模型工具调用门与目录过滤的同一事实源。 */
  voiceCallActive(roomId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM voice_calls WHERE conversation_id=? AND state='active' LIMIT 1").get(roomId));
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
        const req = this.db.prepare("SELECT * FROM dial_requests WHERE conversation_id=? AND state='pending' ORDER BY created_at DESC LIMIT 1").get(ctx.roomId) as { id: string } | undefined;
        if (!req) return { ok: false, error: { error_code: 'NO_PENDING_DIAL', detail: '没有等待中的通话请求（可能已过期或已处理）' } };
        if (args.action === 'decline_call') {
          this.db.prepare("UPDATE dial_requests SET state='declined', updated_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(), req.id);
          return { ok: true, value: { request_id: req.id, state: 'declined', note: '已拒绝。她那边会显示你没接；你现在回复里说的话她会看到——说一句为什么或改约。' } };
        }
        // accept_call：est 建 Siren 通话，连接信息挂到请求上（前端轮询取走）
        const created = await createCallFromInternalEnv(ctx.roomId);
        if (!created.ok) {
          if (created.code === 'SIREN_UNCONFIGURED') return { ok: false, error: { error_code: 'SIREN_UNCONFIGURED', detail: 'Siren 通话服务未配置（无法接听）' } };
          if (created.code === 'SIREN_UNREACHABLE') return { ok: false, error: { error_code: 'SIREN_UNREACHABLE', detail: '通话服务不可达，稍后可再试 accept_call' } };
          if (created.code === 'SIREN_CALL_FAILED') return { ok: false, error: { error_code: 'SIREN_CALL_FAILED', detail: `建呼失败（${created.httpStatus}）` } };
          return { ok: false, error: { error_code: 'SIREN_CONTRACT_INVALID' } };
        }
        const upd = this.db.prepare("UPDATE dial_requests SET state='accepted', ws_url=?, call_token=?, call_id=?, updated_at=? WHERE id=? AND state='pending'").run(created.ws_url, created.token, created.call_id, new Date().toISOString(), req.id);
        if (upd.changes === 0) return { ok: false, error: { error_code: 'DIAL_SUPERSEDED', detail: '她已取消或请求已过期' } };
        this.db.prepare("INSERT OR REPLACE INTO voice_calls(call_id,conversation_id,state,started_at) VALUES (?,?,'active',?)").run(created.call_id, ctx.roomId, new Date().toISOString());
        return { ok: true, value: { request_id: req.id, state: 'accepted', call_id: created.call_id, note: '已接听；她那边的电话面板马上会接通，正常和她说话即可。' } };
      }
      if (args.action === 'cancel') {
        const st = await this.sirenCall!.listInvites(ctx.roomId);
        const active = st?.active as { invite_id?: string } | null | undefined;
        if (!st || !active || typeof active.invite_id !== 'string') return { ok: false, error: { error_code: 'NO_PENDING_INVITE', detail: '没有待取消的邀请（可能已过期或已被处理）' } };
        const out = await this.sirenCall!.cancelInvite(active.invite_id);
        if ((out?.['state'] as string | undefined) !== 'cancelled') return { ok: false, error: { error_code: 'SIREN_INVITE_TRANSITION_FAILED', detail: `终态=${String(out?.['state'] ?? 'unknown')}` } };
        // 拒接留言调度②（2026-10-24）：他取消 → 附带说话轮（说明/改约落本会话）
        this.programFacts?.submitProgramFactTurn(ctx.roomId, 'invite_cancelled',
          `你于刚刚取消了自己发起的来电（她还没接听）。自然地跟她说一两句——说明原因或改约时间，落在本会话。`,
          `invite:${active.invite_id}:cancelled`);
        return { ok: true, value: { invite_id: active.invite_id, state: 'cancelled', note: '邀请已取消；接下来你说的每句话都会正常发到会话里' } };
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
