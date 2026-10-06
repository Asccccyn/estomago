// Turn Supervisor v0.2.2（AUD-03/05/10/25 修复版）：
//  - 会话级路由 gate：任一 pending 票据冻结整个房间的模型执行（输入仍可持久化排队）。
//  - route signal 到达：一个控制序列内完成 持久票据→generation fence→标记 attempt→abort→
//    reasoning interrupted；fence 之后旧代增量一律丢弃，绝不发布。
//  - 会话连续性：window.sdk_session_id 持久化；同窗后续轮 resume；首轮/新窗创建新 session；
//    重启后从 DB 恢复（AUD-03）。
//  - 确定性终态：runner throw / error result / 无 result / abort 都落定 turn+attempt+reasoning
//    的确定状态；无 success result 不得 completed（AUD-25）。
//  - 启动 recovery pass：扫描孤儿 running/streaming，标记 RECOVERY_HOST_RESTART，不重跑模型。
//  - 日志只记稳定错误码/ID/计数（AUD-28）。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import type { Config } from '../config/schema.ts';
import type { MessageService } from '../messages/service.ts';
import type { EventService } from '../events/service.ts';
import type { IdentityService } from '../identity/service.ts';
import type { CapabilityMatrix } from './capabilities.ts';
import { buildSdkOptions } from './build-options.ts';
import type { RunnerSelection } from './runner.ts';
import type { ReasoningService } from '../reasoning/service.ts';
import type { UsageCollector } from '../usage/collector.ts';
import type { RoutingService } from '../routing/service.ts';
import type { WindowManager } from '../windows/manager.ts';
import type { Logger } from '../observability/logging.ts';
import { buildTimeContext } from '../time/context.ts';
import { contextFingerprint } from '../identity/service.ts';
import { assembleContext } from '../context/assembler.ts';
import { FIXED_RUNTIME_FRAGMENT, HOST_BOUNDARY_RULES } from '../context/fixed-runtime.ts';
import { buildPreRotateReviewMessage } from '../context/review-prompts.ts';
import { rotationPlan, selectReviewRange, rawKey, type ManifestEntry } from '../context/review-policy.ts';
import type { RotationReviewService } from '../context/rotation-review.ts';
import type { HoldCheckpointService } from '../memory/hold-checkpoint.ts';
import { orSessionId } from './runner-openrouter.ts';
import { dsSessionId, buildDeepSeekPayload } from './runner-deepseek.ts';
import { buildOrPayload, type OrMessage } from './or-payload.ts';
import { planBoundaries, tailBoundaryOf } from './cache-plan.ts';
import type { WindowTrajectoryService } from './window-trajectory.ts';
import { HOST_TOOLS, hostToolNames, type HostToolExecutor, type ToolExecContext } from './host-tools.ts';
import type { OrRequestEnvelope, RunnerPurpose } from './runner.ts';
import type { MatchedCompleteBlock } from '../../../../packages/contracts/src/sdk-events.ts';
import { TextSegmenter } from '../output/segments.ts';
import { sha256Hex } from '../util/id.ts';
import { buildPaths, resolveStateRoot } from '../config/paths.ts';

export type SupervisorDeps = {
  db: Db;
  config: Config;
  messages: MessageService;
  events: EventService;
  identity: IdentityService;
  capabilities: CapabilityMatrix;
  runnerSelection: RunnerSelection;
  reasoning: ReasoningService;
  usage: UsageCollector;
  routing: RoutingService;
  windows: WindowManager;
  logger: Logger;
  archiveSync?: { drainOnce(): Promise<unknown> }; // 助手消息正式发布后触发原文同步（未启用时不注入）
  tools?: HostToolExecutor; // OR 工具执行（memory_hold / context_review_complete；未注入则工具循环不可用）
  reviews?: RotationReviewService;
  checkpoint?: HoldCheckpointService;
  trajectory?: WindowTrajectoryService; // §2.2/§7：每窗 append-only 协议轨迹（缓存断点 G 与跨轮断言依据）
};

const RUNNER_GRACE_MS = 5000; // §11：不合作 runner 的强制终态宽限
const MAX_TOOL_ROUNDS = 8; // §8.2：工具续请求有界（防循环收费；超限按错误收口，允许恢复）
// §3.3 有界恢复（2026-10-05 审计 P2-1）：同窗评审失败达上限后不再自动付费评审——
// 恢复路径=评审成功换新窗（新窗计数重置）或人工处理后手动换窗；防"模型永不调用 complete"时每条消息都付费评审。
const MAX_WINDOW_REVIEW_ATTEMPTS = 3;

/** 信封驱动（OR / DS 直连共用消息轨迹与工具循环管线；SDK/mock 走 prompt 路径） */
export const isEnvelopeDriverKind = (kind: string): kind is 'openrouter' | 'deepseek' =>
  kind === 'openrouter' || kind === 'deepseek';

type ActiveRun = {
  token: { cancelled: boolean };
  controller: AbortController;
  generation: number;
};

export class TurnSupervisor {
  private d: SupervisorDeps;
  private chains = new Map<string, Promise<void>>();
  private active = new Map<string, ActiveRun>(); // key = turnId

  constructor(d: SupervisorDeps) {
    this.d = d;
  }

  enqueue(turnId: string): void {
    const conv = this.d.db.prepare('SELECT conversation_id FROM turns WHERE id = ?').get(turnId) as { conversation_id: string } | undefined;
    if (!conv) return;
    this.runSerialized(conv.conversation_id, async () => {
      try {
        await this.runTurn(turnId);
      } catch (err) {
        // AUD-10：链条内崩溃不留悬挂——该 turn 落 failed 终态
        this.d.logger.error('turn_crashed', { turn_id: turnId, code: stableCode(err) });
        this.failTurnQuietly(turnId, 'RUNNER_CRASHED');
      }
    });
  }

  /** 审计 F05：房间唯一串行链的通用入口——turn、自动评审、手动换窗共用同一互斥；
   *  前序任务失败不阻断后续（fn 总被执行），返回值/异常原样传给调用方。 */
  private runSerialized<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(conversationId) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const next = result.catch(() => {}).finally(() => {
      if (this.chains.get(conversationId) === next) this.chains.delete(conversationId);
    });
    this.chains.set(conversationId, next);
    return result;
  }

  async waitIdle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  stop(turnId: string): { stopped: boolean; generation: number | null } {
    const run = this.active.get(turnId);
    if (!run) return { stopped: false, generation: null };
    run.token.cancelled = true; // generation fence：迟到 chunk 一律丢弃
    run.controller.abort(); // 同时触发 await 处的 grace 计时（§11：不合作 runner 的有界终止）
    return { stopped: true, generation: run.generation };
  }

  async stopAll(timeoutMs = 8000): Promise<void> {
    for (const run of this.active.values()) {
      run.token.cancelled = true;
      run.controller.abort();
    }
    const start = Date.now();
    while (this.active.size > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  createAttempt(turnId: string, inputRevision: number | null): string {
    const attemptId = `att_${turnId.slice(4)}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const row = this.d.db.prepare('SELECT MAX(attempt_no) AS m FROM attempts WHERE turn_id = ?').get(turnId) as { m: number | null };
    tx(this.d.db, () => {
      this.d.db.prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,?,?,'pending')").run(attemptId, turnId, (row.m ?? 0) + 1, inputRevision);
    });
    return attemptId;
  }

  // AUD-10/38（§10）：启动恢复——孤儿 running/streaming/PREPARING/无票据 waiting 全部落确定状态，不重跑模型
  static recoveryPass(db: Db, logger: { warn: (e: string, f: Record<string, unknown>) => void }): { turns: number; attempts: number; blocks: number; staleWindows: number; releasedWaiting: number; failedOwners: number } {
    const now = new Date().toISOString();
    const turns = tx(db, () => Number(db.prepare("UPDATE turns SET state = 'failed', completed_at = ? WHERE state IN ('running') AND completed_at IS NULL").run(now).changes));
    const attempts = tx(db, () => Number(db.prepare("UPDATE attempts SET state = 'failed', blocked_reason = 'RECOVERY_HOST_RESTART', completed_at = ? WHERE state IN ('running')").run(now).changes));
    const blocks = tx(db, () => Number(db.prepare("UPDATE reasoning_blocks SET state = 'failed', updated_at = ? WHERE state = 'streaming'").run(now).changes));
    // 孤儿 candidate 窗口（AUD-38）：PREPARING 悬挂 → 终态 BLOCKED
    const staleWindows = tx(db, () => Number(db.prepare("UPDATE windows SET status = 'BLOCKED', blocked_reason = 'RECOVERY_ORPHAN_CANDIDATE', updated_at = ? WHERE status = 'PREPARING'").run(now).changes));
    // waiting_route_gate 但房间已无 pending 票据 → 释放回 pending（可被调度恢复接管）
    const releasedWaiting = tx(db, () => Number(db.prepare(
      `UPDATE attempts SET state = 'pending', blocked_reason = NULL
       WHERE state = 'waiting_route_gate'
         AND turn_id IN (SELECT t.id FROM turns t WHERE NOT EXISTS (
           SELECT 1 FROM route_decisions rd WHERE rd.conversation_id = t.conversation_id AND rd.state = 'pending'))`,
    ).run().changes));
    // route_owner_pending 但票据已消失（被并发消费后崩溃等）→ failed（防悬挂 owner）
    const failedOwners = tx(db, () => Number(db.prepare(
      `UPDATE attempts SET state = 'failed', blocked_reason = 'RECOVERY_ORPHAN_ROUTE_OWNER', completed_at = ?
       WHERE state = 'route_owner_pending'
         AND NOT EXISTS (SELECT 1 FROM route_decisions rd WHERE rd.attempt_id = attempts.id AND rd.state = 'pending')`,
    ).run(now).changes));
    const total = turns + attempts + blocks + staleWindows + releasedWaiting + failedOwners;
    if (total > 0) logger.warn('recovery_pass', { turns, attempts, blocks, staleWindows, releasedWaiting, failedOwners, code: 'RECOVERY_HOST_RESTART' });
    return { turns, attempts, blocks, staleWindows, releasedWaiting, failedOwners };
  }

  // —— OR 工具循环（§8.2）：assistant tool_calls → 宿主完整验证后串行执行 → tool 结果续请求 →
  // 同样经 P2（previousPayload append-only 断言）。发布/记账语义由调用方 onEvent 决定。
  // 返回 finalMessages：成功回合的完整轨迹消息（含最终 assistant 文本），供轨迹持久化（§2.2）。
  private async runOrToolLoop(o: {
    envelope: OrRequestEnvelope;
    purpose: RunnerPurpose;
    activeReviewId: string | null;
    conversationId: string;
    windowId: string;
    turnId: string;
    attemptId: string;
    controller: AbortController;
    onEvent: (ev: import('../../../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent, reqCtx?: { requestId: string | null }) => void;
    seenSequence: number;
    onDispatch?: (info: { attemptIndex: number; generationId: string | null; payloadJson: string; prqId: string }) => void; // F17：每次真实发送逐笔留证
    previousEnvelope?: OrRequestEnvelope | null; // 跨轮 previousPayload（轨迹正本；首轮后由循环内部接管）
  }): Promise<{ result: import('./runner.ts').RunnerRunResult; finalMessages: OrMessage[] | null; lastSentMessages: OrMessage[] | null }> {
    const d = this.d;
    const runner = d.runnerSelection.runner;
    let envelope = o.envelope;
    let prevEnvelope: OrRequestEnvelope | null = o.previousEnvelope ?? null;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const captured: MatchedCompleteBlock[] = [];
      let lastText: string | null = null;
      const wrapped: typeof o.onEvent = (ev, reqCtx) => {
        void reqCtx;
        if (ev.kind === 'complete_message') {
          for (const b of ev.matched) if (b.block_type === 'tool_use') captured.push(b);
          const text = ev.matched.find((b) => b.block_type === 'text' && typeof b.text === 'string');
          if (text) lastText = text.text;
        }
        o.onEvent(ev, { requestId: prqId }); // 审计 F12：usage 按实际请求身份去重（不互覆）
      };
      const prqId = `prq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      // F17：发送前保存不可变协议投影（重放/对账依据；受保护字段，不进普通日志）
      d.db.prepare('INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(prqId, o.windowId, o.attemptId, o.turnId, o.purpose, JSON.stringify(envelope.messages.map((m) => ({ role: m.role }))), JSON.stringify(envelope), new Date().toISOString());
      // F03 尾：工具续请求每轮重算容量硬门（§4.2：连续工具回合每次重算，预留不是无限消费额度）
      const capacityNow = d.config.windows.model_context_capacity;
      if (capacityNow !== null) {
        const estNow = Math.ceil(JSON.stringify(envelope.messages).length / (this.drv()?.charsPerToken ?? 2.5));
        const planNow = rotationPlan({
          currentInput: estNow, nextInput: estNow, capacity: capacityNow,
          maxOutput: this.drv()?.maxTokens ?? d.config.openrouter.max_output_tokens,
          toolReserve: d.config.windows.tool_input_reserve_tokens, reviewReserve: d.config.windows.review_reserve_tokens,
          safety: d.config.windows.safety_reserve_tokens, soft: d.config.windows.soft_limit_tokens, warning: d.config.windows.warning_tokens,
        });
        if (planNow.action === 'blocked_hard') {
          d.db.prepare('UPDATE provider_requests SET outcome = ? WHERE id = ?').run('CAPACITY_BLOCKED_HARD', prqId);
          return { result: { outcome: 'error', errorClassified: null, errorCode: 'CAPACITY_BLOCKED_HARD_TOOL_ROUND', errorMessage: `工具续请求输入估计 ${estNow} 超过安全上界 ${planNow.safeInput}`, sessionId: null, requestId: null }, finalMessages: null };
        }
      }
      const payloadJson = JSON.stringify(envelope);
      const onDispatch = (info: { attemptIndex: number; generationId: string | null }): void => {
        // 审计 F17：重试的每次真实发送单独留证（首发放到本轮 planned 行，重试插新行）
        const nowIso = new Date().toISOString();
        if (info.attemptIndex === 0) {
          d.db.prepare('UPDATE provider_requests SET sent_at = ?, attempt_no = ?, generation_id = COALESCE(?, generation_id) WHERE id = ?')
            .run(nowIso, 0, info.generationId ?? null, prqId);
        } else {
          d.db.prepare('INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, payload_json, created_at, sent_at, attempt_no, generation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(`prq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, o.windowId, o.attemptId, o.turnId, o.purpose, JSON.stringify(envelope.messages.map((m) => ({ role: m.role }))), payloadJson, nowIso, nowIso, info.attemptIndex, info.generationId ?? null);
        }
      };
      const result = await Promise.race([
        runner.run({ driver: this.drv()?.kind ?? 'openrouter', purpose: o.purpose, envelope, previousPayload: prevEnvelope ? this.buildPayloadFrom(prevEnvelope) : null, abortController: o.controller, onEvent: wrapped, onDispatch }),
        new Promise<never>((_, reject) => {
          const arm = (): void => { setTimeout(() => reject(new Error('RUNNER_GRACE_TIMEOUT')), RUNNER_GRACE_MS).unref?.(); };
          if (o.controller.signal.aborted) arm();
          else o.controller.signal.addEventListener('abort', arm, { once: true });
        }),
      ]).catch((err): import('./runner.ts').RunnerRunResult => {
        const isGrace = String((err as Error)?.message ?? err).includes('GRACE');
        if (isGrace) o.controller.abort();
        return { outcome: isGrace ? 'interrupted' : 'error', errorClassified: null, errorCode: isGrace ? 'RUNNER_GRACE_TIMEOUT' : 'RUNNER_THREW', errorMessage: String((err as Error)?.message ?? err), sessionId: null, requestId: null };
      });
      d.db.prepare('UPDATE provider_requests SET generation_id = ?, outcome = ? WHERE id = ?').run(result.requestId, result.outcome, prqId);
      if (result.outcome !== 'completed') return { result, finalMessages: null, lastSentMessages: null };
      if (captured.length === 0) {
        // 最终回复：assistant 文本入轨迹（协议历史的正式组成，供后续轮次与缓存前缀）。
        // F18：lastSentMessages=本轮实际发送的消息（不含未发送的最终 assistant）——G 候选边界
        const finalMessages = lastText !== null && lastText.length > 0
          ? [...envelope.messages, { role: 'assistant', content: [{ type: 'text', text: lastText }] } as unknown as OrMessage]
          : envelope.messages;
        return { result, finalMessages, lastSentMessages: envelope.messages };
      }
      if (round === MAX_TOOL_ROUNDS) {
        return { result: { outcome: 'error', errorClassified: null, errorCode: 'TOOL_ROUNDS_EXCEEDED', errorMessage: `工具续请求超过 ${MAX_TOOL_ROUNDS} 轮（有界防循环）`, sessionId: null, requestId: result.requestId }, finalMessages: null, lastSentMessages: null };
      }
      prevEnvelope = envelope;
      // F13：已发布正文随 assistant 消息续传（原样保留，§2.2）；opaque reasoning 片段作为
      // 协议继续态原样携带（§10：不解释不重构；真实端点兼容性=WP6 实测项，此处不冒称已验证）
      const assistantContinue: Record<string, unknown> = {
        role: 'assistant',
        content: lastText ?? null,
        tool_calls: captured.map((t) => ({ id: t.tool_id, type: 'function', function: { name: t.tool_name ?? '', arguments: t.text ?? '{}' } })),
      };
      if (result.reasoningFrames && result.reasoningFrames.length > 0) {
        // 审计 F13：各帧 delta 的 reasoning_details 是一维数组——续传必须展平回一维 object[]，
        // 不得嵌套成 object[][]（batch2 旧断言锁定的就是错误形状，已同步修正）
        const flat = (result.reasoningFrames as unknown[]).flatMap((f) => (Array.isArray(f) ? f : [f]));
        assistantContinue.reasoning_details = flat;
      }
      envelope = { ...envelope, messages: [...envelope.messages, assistantContinue as unknown as OrMessage] };
      // §3.3：同一批里既有 hold 又有 complete → 先执行并核实全部写操作，最后才验证 complete（不并发抢先放行）。
      // 审计 F04：complete 按模型原始顺序排在 hold 前 was 错误签发路径；此处强制重排。
      const ordered = [
        ...captured.filter((t) => t.tool_name !== 'context_review_complete'),
        ...captured.filter((t) => t.tool_name === 'context_review_complete'),
      ];
      for (const t of ordered) {
        // 审计 F07：停止后不再分派同批后续工具（内容 fence 不足以拦新副作用——executor 真的会写 Mariposa）
        if (o.controller.signal.aborted) {
          return { result: { outcome: 'interrupted', errorClassified: null, errorCode: 'STOPPED_DURING_TOOLS', errorMessage: '停止：同批后续工具不再分派（已发起写单独保留待核）', sessionId: null, requestId: result.requestId }, finalMessages: null };
        }
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(t.text ?? '{}') as Record<string, unknown>;
        } catch {
          args = {}; // 参数非法：执行器会因缺必填字段拒绝（§8.2 输入完整校验后才执行）
        }
        args.__tool_call_id = t.tool_id;
        const exec = await d.tools!.execute(t.tool_name ?? '', args, {
          roomId: o.conversationId, windowId: o.windowId, turnId: o.turnId, purpose: o.purpose,
          activeReviewId: o.activeReviewId, seenSequence: o.seenSequence, requestId: result.requestId ?? `round_${round}`,
        });
        envelope = { ...envelope, messages: [...envelope.messages, { role: 'tool', tool_call_id: t.tool_id, content: JSON.stringify(exec.output) } as unknown as OrMessage] };
      }
      if (o.activeReviewId && d.reviews?.get(o.activeReviewId)?.status === 'completed') {
        return { result, finalMessages: null, lastSentMessages: null }; // §3.3：complete 最后验证；完成后收口，评审请求不进对话轨迹
      }
    }
    return { result: { outcome: 'error', errorClassified: null, errorCode: 'TOOL_ROUNDS_EXCEEDED', errorMessage: 'unreachable', sessionId: null, requestId: null }, finalMessages: null, lastSentMessages: null };
  }

  /** 当前信封驱动配置（身份映射隔离：OR/DS 各自的型号、预算上限、粗估系数与 session 派生——互不混用；
   *  非信封驱动（SDK/mock）返回 null。 */
  private drv(): { kind: 'openrouter' | 'deepseek'; model: string; maxTokens: number; reasoning: Record<string, unknown> | null; charsPerToken: number; sessionId: (roomId: string) => string } | null {
    const r = this.d.runnerSelection;
    if (r.status !== 'ok' || !isEnvelopeDriverKind(r.runner.kind)) return null;
    if (r.runner.kind === 'deepseek') {
      const ds = this.d.config.deepseek;
      return { kind: 'deepseek', model: ds.model!, maxTokens: ds.max_output_tokens, reasoning: null, charsPerToken: ds.estimate_chars_per_token, sessionId: (roomId) => dsSessionId(roomId, ds.model!) };
    }
    const or = this.d.config.openrouter;
    return { kind: 'openrouter', model: or.model!, maxTokens: or.max_output_tokens, reasoning: or.reasoning, charsPerToken: or.estimate_chars_per_token, sessionId: (roomId) => orSessionId(roomId, or.model!, null) };
  }

  private buildPayloadFrom(envelope: OrRequestEnvelope): Record<string, unknown> {
    if (this.drv()?.kind === 'deepseek') return buildDeepSeekPayload(envelope);
    const or = this.d.config.openrouter;
    return buildOrPayload({
      model: envelope.model, sessionId: envelope.sessionId, messages: envelope.messages, tools: envelope.tools,
      boundaries: envelope.boundaries, maxTokens: envelope.maxTokens, reasoning: envelope.reasoning,
      providerOnly: or.provider_only, allowFallbacks: or.allow_fallbacks, requireParameters: or.require_parameters,
    });
  }

  /** 审计 F27：为 manifest=NULL 的旧轨迹行重建已见清单——轨迹 user/assistant 文本逐条匹配
   *  库内当前修订（角色+正文精确等值，按序消费候选防重复正文误配）；任一条无匹配 → null（未知）。 */
  private rebuildTrajectoryManifest(conversationId: string, trajMessages: OrMessage[]): ManifestEntry[] | null {
    const dbRows = this.d.db.prepare(
      `SELECT m.id, m.sequence, m.current_revision, m.speaker, r.content FROM messages m
       JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
       WHERE m.conversation_id = ? ORDER BY m.sequence`,
    ).all(conversationId) as Array<{ id: string; sequence: number; current_revision: number; speaker: string; content: string }>;
    const out: ManifestEntry[] = [];
    let cursor = 0;
    for (const tm of trajMessages) {
      if (tm.role !== 'user' && tm.role !== 'assistant') continue;
      const text = typeof tm.content === 'string' ? tm.content : Array.isArray(tm.content) ? tm.content.map((b) => (b as { text?: string }).text ?? '').join('') : '';
      const speaker = tm.role === 'user' ? 'owner' : 'assistant';
      let matched: { id: string; sequence: number; current_revision: number } | null = null;
      for (let i = cursor; i < dbRows.length; i++) {
        const row = dbRows[i]!;
        // 轨迹 user 消息=时间上下文前缀+正文（§5.5 组合投影）→ 用包含匹配；按序消费候选防重复正文误配
        if (row.speaker === speaker && row.content.length > 0 && text.includes(row.content)) {
          matched = row;
          cursor = i + 1;
          break;
        }
      }
      if (!matched) return null; // 无法无歧义重建：范围未知
      out.push({ id: matched.id, revision: matched.current_revision, seq: matched.sequence, origin: 'dialogue', visible: true });
    }
    return out;
  }

  // 当前输入之前的双方原话（§3.2.2：范围=本窗实际携带的真实对话；不扩大到全库）
  private dialogueUpTo(conversationId: string, maxSequence: number): Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }> {
    const rows = this.d.db.prepare(
      'SELECT id, sequence, speaker, current_revision FROM messages WHERE conversation_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 200',
    ).all(conversationId, maxSequence) as Array<{ id: string; sequence: number; speaker: string; current_revision: number }>;
    const out: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }> = [];
    for (const r of rows) {
      const msg = this.d.messages.getMessage(r.id);
      if (!msg) continue;
      out.push({ id: r.id, revision: r.current_revision, sequence: r.sequence, role: r.speaker === 'owner' ? 'user' : 'assistant', content: msg.revision.content });
    }
    return out.reverse();
  }

  // 信封（§5.1/§5.5/§7.1，OR/DS 共用）：固定前缀=身份+当前 I+批准规则+宿主片段（审计 F02：I 完整装载）；
  // 近期原话从**最新一条向前**装满预算（审计 F06：裁剪留新丢旧）；尾部=输入/评审事件。
  // 身份映射隔离：型号/输出上限/粗估系数/session 派生按驱动取值（drv()）；DS 不发 session_id（runner 序列化丢弃）。
  private buildEnvelope(o: {
    conversationId: string;
    materials: { identityText: string; rulesText: string; iText: string | null } | null;
    dialogue: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }>;
    tailUserText: string;
  }): { envelope: OrRequestEnvelope; selected: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }> } {
    const dv = this.drv()!;
    const budgetChars = this.d.config.windows.recent_dialogue_budget_tokens * dv.charsPerToken; // 粗估（§11.1 估计口径，不冒充精确）
    const systemText = [o.materials?.identityText ?? '', o.materials?.iText ?? '', o.materials?.rulesText ?? '', FIXED_RUNTIME_FRAGMENT, HOST_BOUNDARY_RULES].filter((t) => t.length > 0).join('\n\n');
    const messages: OrMessage[] = [
      { role: 'system', content: [{ type: 'text', text: systemText }] },
    ];
    // F06：从最新向前装满预算再正序放入（预算外的旧消息被裁，新消息必进——不反向留旧丢新）
    const selected: typeof o.dialogue = [];
    let used = 0;
    for (let i = o.dialogue.length - 1; i >= 0; i--) {
      const m = o.dialogue[i]!;
      if (used + m.content.length > budgetChars) break;
      used += m.content.length;
      selected.unshift(m);
    }
    for (const m of selected) messages.push({ role: m.role, content: [{ type: 'text', text: m.content }] });
    messages.push({ role: 'user', content: [{ type: 'text', text: o.tailUserText }] });
    return {
      envelope: {
        model: dv.model,
        sessionId: dv.sessionId(o.conversationId),
        messages,
        tools: HOST_TOOLS as unknown as import('./or-payload.ts').OrTool[],
        boundaries: [], // 断点规划由调用方（cache-plan）负责；DS 直连自动缓存忽略断点
        maxTokens: dv.maxTokens,
        reasoning: dv.reasoning,
      },
      selected, // 审计 F06：manifest 必须从实际装载子集生成，不能按索引回映全量前缀
    };
  }

  // —— §4 换窗触发评估 + 换窗前一次提醒（同步执行于用户 turn 前；评审与凭证持久化）——
  private async rotateIfNeeded(o: {
    conversationId: string;
    window: import('../windows/manager.ts').WindowRow;
    gate: import('../identity/service.ts').GateResult;
    currentInputSequence: number;
    attemptId: string;
    turnId: string | null; // 自动换窗=当前 turn（评审请求可被 stop(turnId) 中断）；手动换窗=null（stopAll 兜底）
    materials: { identityText: string; rulesText: string; iText: string | null } | null;
    force?: boolean; // 手动换窗（F05：同一管线，不经评审直转的旁路已封）
  }): Promise<{ rotated: boolean; blocked: string | null }> {
    const d = this.d;
    const dv = this.drv();
    if (!d.tools || !d.reviews || !d.checkpoint) return { rotated: false, blocked: null }; // 能力未接线：不触发自动换窗（普通聊天不受影响）
    if (!dv) return { rotated: false, blocked: null };

    // F06：评审范围的实际已见清单优先取轨迹 manifest（真实发送证据）；无轨迹时退化为库投影。
    const dialogue = this.dialogueUpTo(o.conversationId, o.currentInputSequence - 1);
    const trajRow = d.trajectory?.forWindow(o.window.id) ?? null;
    let trajManifest: ManifestEntry[] | null = trajRow?.manifest ?? null;
    // 审计 F27：v11 前旧轨迹行的 manifest 为 NULL（未知），不得当作空清单签 skipped_empty——
    // 按轨迹正文的 user/assistant 消息逐条匹配库内消息重建；任一匹配失败 → 范围未知，如实阻断。
    if (trajRow !== null && trajManifest === null) {
      trajManifest = this.rebuildTrajectoryManifest(o.conversationId, trajRow.messages);
      if (trajManifest !== null) {
        d.trajectory!.replaceManifest(o.window.id, trajManifest);
      } else {
        return { rotated: false, blocked: 'ROTATION_RANGE_UNKNOWN:旧窗口轨迹缺少已见清单且无法按正文重建——不签发空范围凭证，需明确恢复' };
      }
    }
    const manifest: ManifestEntry[] = trajManifest ?? dialogue.map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true }));

    // §11.1 估计：本地粗估 + 上次实际 usage 校准；精度如实标注。
    // 当前输入是"下一输入"的一部分（§4.2：下一输入将达到软线也要触发）——其长度计入。
    const currentInputLen = (d.db.prepare(
      `SELECT LENGTH(r.content) AS len FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
       WHERE m.conversation_id = ? AND m.sequence = ?`,
    ).get(o.conversationId, o.currentInputSequence) as { len: number | null } | undefined)?.len ?? 0;
    // 审计 F25：估算只用实际发送集合——轨迹正本（无轨迹的新窗首轮回退库内近期，此时二者一致）。
    // 被拒/未发送的历史大消息不得污染当前工作集（否则短输入被持续 CAPACITY_BLOCKED_HARD）。
    const trajForEstimate = d.trajectory?.forWindow(o.window.id) ?? null;
    const sentChars = trajForEstimate
      ? trajForEstimate.messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0)
      : dialogue.reduce((s, m) => s + m.content.length, 0);
    const recentChars = sentChars + currentInputLen;
    const systemChars = (o.materials?.identityText.length ?? 0) + (o.materials?.rulesText.length ?? 0) + FIXED_RUNTIME_FRAGMENT.length + HOST_BOUNDARY_RULES.length;
    const estimate = Math.ceil((recentChars + systemChars) / dv.charsPerToken);
    const lastActual = (d.db.prepare(
      `SELECT u.input_tokens FROM usage_observations u JOIN attempts a ON a.id = u.attempt_id
       WHERE a.window_id = ? AND u.input_tokens IS NOT NULL AND u.completeness = 'complete' ORDER BY u.observed_at DESC LIMIT 1`,
    ).get(o.window.id) as { input_tokens: number } | undefined)?.input_tokens ?? null;
    const workingSet = Math.max(estimate, lastActual ?? 0);

    // §4.1：6h 比较=本条入站消息之前的 last_real_user_at（不先更新再相减）；occurred_at 在修订行上
    const lastUser = (d.db.prepare(
      `SELECT r.occurred_at FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
       WHERE m.conversation_id = ? AND m.speaker = 'owner' AND m.sequence < ? ORDER BY m.sequence DESC LIMIT 1`,
    ).get(o.conversationId, o.currentInputSequence) as { occurred_at: string | null } | undefined)?.occurred_at ?? null;
    const currentAt = (d.db.prepare(
      `SELECT r.occurred_at FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
       WHERE m.conversation_id = ? AND m.sequence = ?`,
    ).get(o.conversationId, o.currentInputSequence) as { occurred_at: string | null } | undefined)?.occurred_at ?? null;
    const idleMs = lastUser && currentAt ? Math.max(0, Date.parse(currentAt) - Date.parse(lastUser)) : 0;

    const capacity = d.config.windows.model_context_capacity ?? Number.MAX_SAFE_INTEGER; // 未测量：容量触发按上限禁用（不画假百分比），idle 触发照常
    let plan: ReturnType<typeof rotationPlan> | null = null;
    if (!o.force) {
      plan = rotationPlan({
        currentInput: workingSet,
        nextInput: workingSet,
        capacity,
        maxOutput: dv.maxTokens,
        toolReserve: d.config.windows.tool_input_reserve_tokens,
        reviewReserve: d.config.windows.review_reserve_tokens,
        safety: d.config.windows.safety_reserve_tokens,
        soft: d.config.windows.soft_limit_tokens,
        warning: d.config.windows.warning_tokens,
        idleMs,
      });
      if (plan.action === 'warn') {
        d.events.publish('context.warning', { conversationId: o.conversationId, entityRef: o.window.id, scope: 'private', payload: { estimate: workingSet, quality: lastActual !== null ? 'calibrated_rough' : 'rough', effective_warning: plan.effectiveWarning, effective_soft: plan.effectiveSoft } });
      }
      // 审计 F03：blocked_hard 是硬门——超安全输入上界不得继续发送；交调用方按待恢复收口，不静默放行
      if (plan.action === 'blocked_hard') {
        return { rotated: false, blocked: `CAPACITY_BLOCKED_HARD:当前输入估计 ${workingSet} 超过安全输入上界 ${plan.safeInput}（C-O-T-R-S），输入已保存待恢复` };
      }
      if (plan.action !== 'rotate') return { rotated: false, blocked: null };
    }
    const reason: 'idle' | 'capacity' | 'manual' = o.force ? 'manual' : plan!.reason === 'idle' ? 'idle' : 'capacity';

    // 审计 F05：评审互斥——同窗已有活跃评审（自动/手动）时不重复开评审，恢复走同 review_id 有界重试
    if (d.reviews.activeForWindow(o.window.id)) {
      return { rotated: false, blocked: o.force ? 'REVIEW_IN_PROGRESS（评审进行中，手动换窗被拒）' : 'ROTATION_ALREADY_IN_PROGRESS' };
    }
    // 审计 F08：评审前按原 operation_id 有界恢复 unknown 写；仍不可判定的如实阻断换窗
    await d.tools.recoverUnknownEffects(o.conversationId, o.window.id);
    const unresolvedBefore = d.reviews.unresolvedForWindow(o.window.id);
    if (unresolvedBefore.length > 0) {
      return { rotated: false, blocked: `WRITES_UNRESOLVED:${unresolvedBefore.length}（存在结果未知的写操作，换窗前须核实）` };
    }

    // —— §3.2 评审范围：书签之后、扣除已完成同范围凭证的真实原话 ——
    // §3.2.4 跨窗继承：旧窗成功书签之前的内容做"焦点豁免"（不标 reviewed，避免每次轮动强制补记早餐）；
    // 已完成/跳过的范围键按房间继承（新窗不重复检查旧窗已检查内容）。
    const checkpoint = d.checkpoint.forWindow(o.window.id);
    const priorBookmark = d.db.prepare('SELECT seen_sequence FROM hold_checkpoints WHERE room_id = ? ORDER BY updated_at DESC LIMIT 1').get(o.conversationId) as { seen_sequence: number } | undefined;
    const carriedExempt = priorBookmark && (!checkpoint || checkpoint.epochId !== o.window.id)
      ? manifest.filter((m) => m.seq <= priorBookmark.seen_sequence).map(rawKey)
      : [];
    let range;
    try {
      range = selectReviewRange({
        manifest,
        epochId: o.window.id,
        lastHold: checkpoint ? { epochId: checkpoint.epochId, seenSequence: checkpoint.seenSequence } : null,
        reviewedKeys: d.reviews.reviewedKeysForRoom(o.conversationId),
        carriedBeforeBookmarkKeys: carriedExempt,
      });
    } catch (err) {
      return { rotated: false, blocked: `ROTATION_RANGE_INVALID:${(err as { code?: string }).code ?? 'UNKNOWN'}` };
    }
    const rangeKeys = range.map(rawKey);
    if (d.reviews.completedForRange(o.conversationId, rangeKeys)) {
      return this.doRotate(o, reason, null); // 同范围有效凭证：直接换窗不再次收费检查（§4.3）
    }
    if (range.length === 0) {
      d.reviews.markSkippedEmpty(o.window.id, o.conversationId, o.window.revision, rangeKeys); // §3.2.5：空范围不叫模型
      return this.doRotate(o, reason, null);
    }
    // §3.3 有界恢复（审计 P2-1）：同窗评审失败达上限后不再自动发评审（每次评审都是真实付费请求）。
    // 恢复路径：评审成功换新窗（新窗计数自动重置）或人工处理（修提示/型号后手动换窗）。
    const failedReviews = (d.db.prepare("SELECT COUNT(*) n FROM rotation_reviews WHERE window_id = ? AND status = 'failed'").get(o.window.id) as { n: number }).n;
    if (failedReviews >= MAX_WINDOW_REVIEW_ATTEMPTS) {
      return { rotated: false, blocked: `ROTATION_REVIEW_RETRY_EXHAUSTED:本窗评审已失败 ${failedReviews} 次（上限 ${MAX_WINDOW_REVIEW_ATTEMPTS}），不再自动评审——请检查模型对提醒的响应或手动换窗；输入已保存待恢复` };
    }
    const review = d.reviews.create(o.window.id, o.conversationId, o.window.revision, range);
    d.events.publish('review.sent', { conversationId: o.conversationId, entityRef: review.id, scope: 'private', payload: { window_id: o.window.id, reason, focus_count: range.length } });

    // —— §8.1 一次提醒（synthetic user 尾部；宿主隐藏普通输出；purpose=pre_rotate_review）——
    // 轨迹正本优先（模型看见的就是它看过的协议历史）；无轨迹时退化为 system+近期原话投影。
    const traj = d.trajectory?.forWindow(o.window.id);
    const fallbackBase = this.buildEnvelope({ conversationId: o.conversationId, materials: o.materials, dialogue, tailUserText: ' ' }).envelope.messages.slice(0, -1);
    const reviewBaseMessages: OrMessage[] = traj ? traj.messages : fallbackBase;
    const reviewMessages: OrMessage[] = [...reviewBaseMessages, { role: 'user', content: [{ type: 'text', text: buildPreRotateReviewMessage({ reviewId: review.id, reason, messageRefs: rangeKeys.join(', ') }) }] }];
    const { boundaries: reviewBoundaries } = planBoundaries({ messages: reviewMessages, systemMessageCount: 1, prevBoundary: traj?.lastBoundary ?? null });
    const envelope: OrRequestEnvelope = {
      model: dv.model,
      sessionId: dv.sessionId(o.conversationId),
      messages: reviewMessages,
      tools: HOST_TOOLS as unknown as import('./or-payload.ts').OrTool[],
      boundaries: reviewBoundaries,
      maxTokens: dv.maxTokens,
      reasoning: dv.reasoning,
    };
    const controller = new AbortController();
    // 审计 P2-2（§9.2 停止=abort 上游）：评审请求登记进活动代——自动换窗评审可被 stop(turnId) 中断；
    // 手动换窗评审登记在合成键下（无所属 turn），进程级 stopAll 兜底。
    const reviewRun: ActiveRun = { token: { cancelled: false }, controller, generation: 0 };
    const stopKey = o.turnId ?? `review:${o.window.id}`;
    this.active.set(stopKey, reviewRun);
    const reviewTurnId = (d.db.prepare('SELECT turn_id FROM attempts WHERE id = ?').get(o.attemptId) as { turn_id: string } | undefined)?.turn_id ?? o.attemptId;
    const quietEvent = (ev: import('../../../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent, reqCtx?: { requestId: string | null }): void => {
      // 评审请求不发布正文/思考（§8.1）；只记账 usage 与终态（F12：真实 turn 归属 + 请求身份）
      if (ev.kind === 'usage') {
        d.usage.record({ turnId: reviewTurnId, attemptId: o.attemptId, requestId: reqCtx?.requestId ?? undefined, windowId: o.windowId, scope: ev.scope, usage: ev.usage, model: dv.model, source: ev.source, completeness: ev.completeness }); // F31：评审费用按窗口归属
      }
    };
    const seenHighWater = manifest.length > 0 ? Math.max(...manifest.map((m) => m.seq)) : 0;
    let result: import('./runner.ts').RunnerRunResult;
    try {
      ({ result } = await this.runOrToolLoop({
        envelope, purpose: 'pre_rotate_review', activeReviewId: review.id,
        conversationId: o.conversationId, windowId: o.window.id,
        turnId: null, attemptId: o.attemptId, controller, onEvent: quietEvent, seenSequence: seenHighWater,
      }));
    } finally {
      if (this.active.get(stopKey) === reviewRun) this.active.delete(stopKey);
    }
    const reviewRow = d.reviews.get(review.id);
    if (reviewRow?.status !== 'completed') {
      d.reviews.markFailed(review.id);
      d.events.publish('review.failed', { conversationId: o.conversationId, entityRef: review.id, scope: 'private', payload: { code: result.errorCode ?? 'MODEL_DID_NOT_COMPLETE' } });
      return { rotated: false, blocked: `ROTATION_REVIEW_FAILED:${result.errorCode ?? 'MODEL_DID_NOT_COMPLETE'}` };
    }
    return this.doRotate(o, reason, review.id);
  }

  private doRotate(o: { conversationId: string; window: import('../windows/manager.ts').WindowRow; gate: import('../identity/service.ts').GateResult; currentInputSequence: number }, reason: 'idle' | 'capacity' | 'manual', reviewId: string | null): { rotated: boolean; blocked: string | null } {
    // 审计 F05：评审期间可能已被并发换窗（手动/上一轮迟到返回）——只对评审针对的那个旧窗切换，
    // 活动指针已变则本轮评审作废（凭证留档），绝不叠加第二次轮转。
    const active = this.d.windows.activeWindow(o.conversationId);
    if (!active || active.id !== o.window.id) {
      return { rotated: false, blocked: 'ROTATION_SUPERSEDED:窗口已被并发切换，本次评审结果留档不重复换窗' };
    }
    const rotated = this.d.windows.rotate({ conversationId: o.conversationId, gate: o.gate, maxSequence: o.currentInputSequence - 1, assembledOptions: null });
    if (!rotated.ok) return { rotated: false, blocked: `ROTATE_PREPARE_FAILED:${rotated.reason.slice(0, 80)}` };
    this.d.events.publish('window.rotated', { conversationId: o.conversationId, entityRef: rotated.window.id, scope: 'private', payload: { reason, review_id: reviewId } });
    return { rotated: true, blocked: null };
  }

  /** 审计 F05：手动换窗入口——与自动换窗同一条评审管线（同互斥/恢复/未决检查/CAS），
   *  不再存在绕过评审的直转旁路。SDK 驱动（无评审线）保持 v0.2.2 行为（running/票据检查仍在 manager）。 */
  async manualRotate(conversationId: string): Promise<{ ok: true; windowId: string } | { ok: false; reason: string }> {
    // 审计 F05：手动换窗占用房间串行链——与 turn/自动评审/另一个手动调用互斥，
    // 评审等待期间新 chat 排队而非并发发送
    return this.runSerialized(conversationId, () => this.manualRotateInner(conversationId));
  }

  private async manualRotateInner(conversationId: string): Promise<{ ok: true; windowId: string } | { ok: false; reason: string }> {
    const d = this.d;
    const dv = this.drv();
    const gate = d.identity.evaluateGate(d.db, { driver: dv ? dv.kind : 'claude-agent-sdk' });
    const window = d.windows.activeWindow(conversationId);
    if (!window) return { ok: false, reason: '无当前活动窗口' };
    if (!dv || !d.tools || !d.reviews || !d.checkpoint) {
      const r = d.windows.rotate({ conversationId, gate, maxSequence: (d.db.prepare('SELECT COALESCE(MAX(sequence),0) AS m FROM messages WHERE conversation_id = ?').get(conversationId) as { m: number }).m, assembledOptions: null });
      return r.ok ? { ok: true, windowId: r.window.id } : { ok: false, reason: r.reason };
    }
    if (gate.state !== 'READY') return { ok: false, reason: `IDENTITY_BLOCKED：${gate.reasons.join('; ')}（旧窗保持 ACTIVE）` };
    const materials = gate.manifest ? d.identity.loadVerifiedMaterials(gate.manifest) : null;
    const nextSeq = (d.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM messages WHERE conversation_id = ?').get(conversationId) as { n: number }).n;
    const r = await this.rotateIfNeeded({
      conversationId, window, gate, currentInputSequence: nextSeq, attemptId: 'manual-rotate', turnId: null,
      materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null,
      force: true,
    });
    if (r.blocked) return { ok: false, reason: r.blocked };
    const active = d.windows.activeWindow(conversationId);
    return active ? { ok: true, windowId: active.id } : { ok: false, reason: '换窗后无活动窗口' };
  }

  private async runTurn(turnId: string): Promise<void> {
    const d = this.d;
    const turn = d.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as
      | { id: string; conversation_id: string; state: string; input_message_id: string | null; generation: number }
      | undefined;
    if (!turn) return;
    const attempt = d.db.prepare("SELECT * FROM attempts WHERE turn_id = ? AND state = 'pending' ORDER BY attempt_no DESC LIMIT 1").get(turnId) as
      | { id: string; attempt_no: number; input_revision: number | null; fresh_session?: number }
      | undefined;
    if (!attempt) return;

    // —— 会话级路由 gate（AUD-05/36/37 拆分）：挡住的是 waiting_route_gate，不是票据 owner ——
    const roomPending = d.routing.pendingForConversation(turn.conversation_id);
    if (roomPending && roomPending.attempt_id !== attempt.id) {
      // 普通排队输入：可持久化，但绝不启动模型执行；决议事务会批量释放回 pending
      tx(d.db, () => {
        d.db.prepare("UPDATE attempts SET state = 'waiting_route_gate', blocked_reason = ? WHERE id = ? AND state = 'pending'")
          .run(`WAITING_ROUTE_GATE:${roomPending.id}`, attempt.id);
      });
      d.events.publish('turn.status', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, entityRef: attempt.id, payload: { state: 'waiting_route_gate', reason: 'ROUTE_ROOM_PENDING' } });
      return;
    }

    // —— 每轮实际执行前刷新 Time Context（按当前输入 sequence 取前驱，AUD-21） ——
    const inputMessage = turn.input_message_id ? d.messages.getMessage(turn.input_message_id) : null;
    const timeCtx = buildTimeContext(d.db, {
      conversationId: turn.conversation_id,
      config: d.config,
      eventOccurredAt: inputMessage?.revision.occurred_at ?? null,
      currentInputSequence: inputMessage?.sequence ?? null,
    });
    d.db.prepare('UPDATE turns SET time_context_json = ?, started_at = COALESCE(started_at, ?) WHERE id = ?').run(JSON.stringify(timeCtx), new Date().toISOString(), turnId);

    // —— 运行时 gate ——
    // §2.1/§6.3：驱动判别（先行——gate 的驱动专属前提据此区分，审计 F01）；OR/DS 均为信封驱动，
    // 身份映射按驱动隔离（dv()），SDK 专属前提只约束 SDK 驱动。
    const dv = this.drv();
    const gate = d.identity.evaluateGate(d.db, { driver: dv ? dv.kind : 'claude-agent-sdk' });
    // F04：校验与装配用同一份已验证材料（含批准规则正文；I 留在开窗包通道，未批准策略不装载）
    const materials = gate.state === 'READY' && gate.manifest ? d.identity.loadVerifiedMaterials(gate.manifest) : null;
    const workspacesDir = buildPaths(resolveStateRoot(process.env.ESTOMAGO_HOME)).workspacesDir;
    const built = dv ? null : buildSdkOptions({ config: d.config, gate, identityText: materials?.identityText ?? null, approvedRulesText: materials?.rulesText ?? null, cwd: workspacesDir });
    if (d.runnerSelection.status === 'blocked') {
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, `RUNTIME_NOT_READY:${d.runnerSelection.reasons.map(codeOf).join(';')}`, 'blocked');
      return;
    }
    if (built !== null && built.status === 'blocked') {
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, `IDENTITY_NOT_READY:${built.reasons.map(codeOf).join(';').slice(0, 120)}`, 'blocked');
      return;
    }
    if (dv !== null && (!materials?.identityText || !materials?.rulesText)) {
      // §2.1：信封驱动（OR/DS）首条生成前必须有批准身份/规则材料——与 SDK 同一 gate，不提供默认人格
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'IDENTITY_NOT_READY:ENVELOPE_DRIVER_MISSING_APPROVED_MATERIALS', 'blocked');
      return;
    }
    if (dv !== null && !materials?.iText) {
      // 审计 F02：当前 I 必须完整进入固定前缀（§5.1/§7.1）——缺必需 I 时阻断，不静默降级
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'IDENTITY_NOT_READY:ENVELOPE_DRIVER_MISSING_I', 'blocked');
      return;
    }

    // —— 窗口与 session（AUD-03）——
    let window = d.windows.activeWindow(turn.conversation_id);
    if (!window) {
      d.windows.createWindow({ conversationId: turn.conversation_id, gate, assembledOptions: built ? built.assembled : null });
      window = d.windows.activeWindow(turn.conversation_id);
      if (!window) {
        this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'NO_ACTIVE_WINDOW', 'blocked');
        return;
      }
    }
    // §7 AUD：人格/运行边界指纹变化 → 旧窗 CONTEXT_STALE，禁止 resume 旧 session
    const expectedFingerprint = contextFingerprint(d.config, gate.manifest);
    if (window.context_fingerprint && window.context_fingerprint !== expectedFingerprint) {
      d.windows.markContextStale(window.id, 'CONTEXT_FINGERPRINT_MISMATCH');
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'CONTEXT_ROTATION_REQUIRED: 身份/运行边界已变化，需受控换窗（旧 session 不再续用）', 'blocked');
      return;
    }
    // —— ESTOMAGO_OR_SELF_HOLD §2.2/§7：轨迹懒初始化（窗口创建/换窗后的首次信封驱动回合）——
    // 基底=system + 本输入之前的近期原话（首次规范化后固定，§7.1）；当前输入只作尾部追加一次。
    if (dv && d.trajectory) {
      const trajExists = d.trajectory.forWindow(window.id) !== null;
      if (!trajExists) {
        const baseDialogue = this.dialogueUpTo(turn.conversation_id, inputMessage ? inputMessage.sequence - 1 : Number.MAX_SAFE_INTEGER);
        const built0 = this.buildEnvelope({ conversationId: turn.conversation_id, materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null, dialogue: baseDialogue, tailUserText: ' ' });
        // F06（复审修正）：manifest 从 buildEnvelope 实际选中的子集生成——裁剪掉旧消息时
        // 不再按索引错配到历史前缀 ID（正文含 B、清单含 A 的错配源头）
        const baseManifest = built0.selected.map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true }));
        d.trajectory.init(window.id, built0.envelope.messages.slice(0, -1), baseManifest);
      }
    }
    // —— ESTOMAGO_OR_SELF_HOLD §4：换窗触发（64k 软线/6h 静默）→ 一次提醒 → CAS 换窗；
    // 评审失败如实阻断本 attempt（不绕过、不伪造完成凭证）。
    if (dv && inputMessage) {
      const rotation = await this.rotateIfNeeded({
        conversationId: turn.conversation_id, window, gate,
        currentInputSequence: inputMessage.sequence, attemptId: attempt.id, turnId,
        materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null,
      });
      if (rotation.blocked) {
        this.blockAttempt(attempt.id, turnId, turn.conversation_id, rotation.blocked, 'blocked');
        return;
      }
      if (rotation.rotated) {
        const next = d.windows.activeWindow(turn.conversation_id);
        if (next) window = next; // 新窗已 ACTIVE：本轮输入只进新窗一次（§4.2）
        if (d.trajectory) {
          const nextTraj = d.trajectory.forWindow(window.id);
          if (!nextTraj) {
            const baseDialogue = this.dialogueUpTo(turn.conversation_id, inputMessage.sequence - 1);
            const builtR = this.buildEnvelope({ conversationId: turn.conversation_id, materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null, dialogue: baseDialogue, tailUserText: ' ' });
            const baseManifest = builtR.selected.map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true }));
            d.trajectory.init(window.id, builtR.envelope.messages.slice(0, -1), baseManifest);
          }
        }
      }
    }
    // route-edit 的新 attempt（fresh_session=1）：不 resume 旧 session——修订输入全新开跑，
    // 旧 session 历史含被替代的旧触发，定点排除语义未实测前不得带旧触发重跑。
    // 信封驱动（OR/DS）无宿主可见 resume 语义（session_id 是内部关联标识，不存历史）→ 恒 null。
    const resumeSessionId = dv ? null : attempt.fresh_session ? null : window.sdk_session_id;

    // —— fence + running（claim 条件更新：双执行防护，AUD-37）——
    const generation = turn.generation + 1;
    const claimed = tx(d.db, () => {
      const c = d.db.prepare("UPDATE attempts SET state = 'running', window_id = ?, started_at = ? WHERE id = ? AND state = 'pending'")
        .run(window.id, new Date().toISOString(), attempt.id);
      if (Number(c.changes) === 1) {
        d.db.prepare('UPDATE turns SET generation = ?, state = ? WHERE id = ?').run(generation, 'running', turnId);
      }
      return Number(c.changes);
    });
    if (claimed !== 1) return; // 已被其他执行路径占有：跳过（数据库是真源）
    d.events.publish('turn.status', {
      conversationId: turn.conversation_id, turnId, attemptId: attempt.id, entityRef: attempt.id,
      payload: { state: 'running', attempt_no: attempt.attempt_no, generation, resume_session: Boolean(resumeSessionId) },
    });

    const runToken: ActiveRun = { token: { cancelled: false }, controller: new AbortController(), generation };
    this.active.set(turnId, runToken);

    // 有效输入投影（路由编辑后 attempt.input_revision 指定修订）
    const effective = (() => {
      if (!inputMessage) return { content: '', revision: 1, hash: '', sequence: null as number | null };
      if (attempt.input_revision && attempt.input_revision !== inputMessage.current_revision) {
        const row = d.db
          .prepare('SELECT revision, content, content_hash FROM message_revisions WHERE message_id = ? AND revision = ?')
          .get(inputMessage.id, attempt.input_revision) as { revision: number; content: string; content_hash: string } | undefined;
        if (row) return { ...row, sequence: inputMessage.sequence };
      }
      return { content: inputMessage.revision.content, revision: inputMessage.current_revision, hash: inputMessage.revision.content_hash, sequence: inputMessage.sequence };
    })();

    // §3：经 ContextAssembler 构造（allowlist builder；reasoning 无通道）
    const assembledContext = assembleContext(
      {
        conversationId: turn.conversation_id, windowId: window?.id ?? null, turnId,
        inputMessageId: inputMessage?.id ?? null,
        timeContextJson: JSON.stringify(timeCtx),
        userInput: { revision: effective.revision, content: effective.content },
      },
      {},
    );
    const prompt = assembledContext.segments
      .map((seg) => `[${seg.source}]${seg.source === 'time_context' ? '（宿主注入的程序事实，不是用户发言）' : ''}\n${seg.text}`)
      .join('\n\n');
    const inputHash = effective.hash || sha256Hex(effective.content);

    // 信封请求 v3（§5.5/§6.3/§7，OR/DS 共用管线）：消息=窗口轨迹正本 + 本轮输入尾部（append-only）；
    // 断点规划 A（system 末块）+ G（上次已发送边界，仍有效才标；B 待 bootstrap 接入）——DS 直连
    // 序列化时忽略断点（自动缓存，无参数）；previousPayload=轨迹正本构造的上一请求（跨轮 append-only 断言依据）。
    const dialogueForInput = dv && inputMessage ? this.dialogueUpTo(turn.conversation_id, inputMessage.sequence - 1) : [];
    const orTraj = dv ? d.trajectory?.forWindow(window.id) ?? null : null;
    const orBaseMessages: OrMessage[] = orTraj
      ? orTraj.messages
      : (dv ? this.buildEnvelope({ conversationId: turn.conversation_id, materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null, dialogue: dialogueForInput, tailUserText: prompt }).envelope.messages : []);
    const orMessages: OrMessage[] = orTraj
      ? [...orTraj.messages, { role: 'user', content: [{ type: 'text', text: prompt }] } as unknown as OrMessage]
      : orBaseMessages;
    const orEnvelope: OrRequestEnvelope | null = dv
      ? (() => {
          const { boundaries } = planBoundaries({ messages: orMessages, systemMessageCount: 1, prevBoundary: orTraj?.lastBoundary ?? null });
          return {
            model: dv.model,
            sessionId: dv.sessionId(turn.conversation_id),
            messages: orMessages,
            tools: HOST_TOOLS as unknown as import('./or-payload.ts').OrTool[],
            boundaries,
            maxTokens: dv.maxTokens,
            reasoning: dv.reasoning,
          };
        })()
      : null;
    const orPreviousPayloadEnvelope: OrRequestEnvelope | null = orTraj && orEnvelope !== null ? { ...orEnvelope, messages: orTraj.messages } : null;
    // F14：书签视野=发起请求实际看见的位置——本轮输入已进入 payload，序号=输入序号（不再减一）
    const orSeenHighWater = inputMessage ? inputMessage.sequence : 0;
    // 记账模型：信封驱动用各自明确型号（§9.3 不混淆口径）；SDK 沿配置模型，F10 观测实际值后覆盖
    const configuredModelForUsage = dv ? dv.model : d.config.runtime.model;

    const segmenter = new TextSegmenter();
    let sawReasoningBlock = false;
    // §16 + F11：正文按 (messageId, blockIndex) 跟踪——同一消息多个 text 块各自独立
    const publishedByKey = new Map<string, string>();
    // F11 第二道防线：归一化事件层的包幂等（runner 直发场景不经 normalizer；同 packet_uuid 只处理一次）
    const handledPacketUuids = new Set<string>();
    const publishText = (sdkMessageId: string, blockIndex: number, text: string): void => {
      const key = `${sdkMessageId}:${blockIndex}`;
      const prev = publishedByKey.get(key) ?? '';
      if (!text.startsWith(prev)) return; // 冲突：已发布气泡不可改写
      const tail = text.slice(prev.length);
      if (tail.length === 0) return;
      publishedByKey.set(key, text);
      publishSegments(segmenter.push(tail));
    };
    let routeSignalHandled = false;
    let fallbackSwitched = false; // F10：模型切换已发生（SDK 观测）——回合按 interrupted 收口并标注原因
    let actualModelForUsage: string | null = null; // F10：用量记账用实际模型，不用配置模型冒充
    // F06/F14：本回合正式发布的助手消息 → 轨迹 manifest 增量（实际已见证据）
    const turnManifestAdditions: ManifestEntry[] = [];
    const publishSegments = (segs: string[]): void => {
      for (const seg of segs) {
        if (runToken.token.cancelled) return;
        const msg = d.messages.publishAssistantMessage({ conversationId: turn.conversation_id, turnId, content: seg });
        turnManifestAdditions.push({ id: msg.id, revision: (msg as { current_revision?: number }).current_revision ?? 1, seq: msg.sequence, origin: 'dialogue', visible: true });
        d.events.publish('message.published', {
          conversationId: turn.conversation_id, turnId, entityRef: msg.id, entityRevision: msg.sequence,
          payload: { message: msg },
        });
      }
    };

    const handleRouteSignal = (): void => {
      if (routeSignalHandled) return;
      routeSignalHandled = true;
      runToken.token.cancelled = true; // fence 立即生效（AUD-05：迟到输出不得发布）
      // 控制序列：持久票据 + generation fence + attempt/turn 状态，同一事务（事件在提交后发布）
      let ticketId: string | null = null;
      try {
        tx(d.db, () => {
          const ticket = d.routing.createPendingInTx({
            conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
            inputHash, targetModel: null, evidenceCode: 'SDK_ROUTE_SIGNAL',
            messageId: inputMessage?.id ?? null, inputRevision: effective.revision,
          });
          ticketId = ticket.id;
          d.db.prepare('UPDATE turns SET generation = ? WHERE id = ?').run(generation + 1, turnId);
          d.db.prepare("UPDATE attempts SET state = 'route_owner_pending', completed_at = ? WHERE id = ?").run(new Date().toISOString(), attempt.id);
          d.db.prepare("UPDATE turns SET state = 'route_owner_pending' WHERE id = ?").run(turnId);
        });
      } catch (err) {
        d.logger.error('route_signal_tx_failed', { turn_id: turnId, code: stableCode(err) });
        return;
      }
      d.events.publish('route.pending', {
        conversationId: turn.conversation_id, turnId, attemptId: attempt.id, scope: 'private',
        payload: { decision_id: ticketId, current_model: null, target_model: null, evidence_code: 'SDK_ROUTE_SIGNAL', already_switched: false, affects_future_sessions: null },
      });
      runToken.controller.abort(); // 通知 runner 停止
      d.reasoning.markAttemptFinal({ attemptId: attempt.id, final: 'interrupted', generation });
    };

    // §6.3：驱动判别请求——同一 handleEvent（发布/记账/route 语义对两驱动一致，不复制两套处理）
    const handleEvent = (ev: import('../../../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent, reqCtx?: { requestId: string | null }): void => {
          // generation fence（AUD-05/03 迟到 chunk）：只挡内容类事件（正文/思考/工具投影）；
          // usage 与路由事实是记账观测，不是发布——fence 后仍须入账（F10：实际模型不能丢）
          if (runToken.token.cancelled && ev.kind !== 'usage' && ev.kind !== 'system_notice' && ev.kind !== 'packet_conflict') return;
          switch (ev.kind) {
            case 'content_block_start':
              if (ev.channel === 'subagent') break; // 子代理不投影进主私聊（AUD-12）
              if (ev.block_type === 'thinking') {
                sawReasoningBlock = true;
                d.reasoning.startBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, sdkMessageId: ev.sdk_message_id, blockIndex: ev.block_index, generation });
              } else if (ev.block_type === 'redacted_thinking') {
                sawReasoningBlock = true;
                d.reasoning.markRedactedOrOmitted({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, sdkMessageId: ev.sdk_message_id, blockIndex: ev.block_index, visibility: 'redacted', generation });
              }
              break;
            case 'thinking_delta':
              if (ev.channel === 'subagent') break;
              d.reasoning.appendDelta({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, sdkMessageId: ev.sdk_message_id, blockIndex: ev.block_index, text: ev.text, generation });
              break;
            case 'text_delta':
              if (ev.channel === 'subagent') break;
              publishText(ev.sdk_message_id, ev.block_index, (publishedByKey.get(`${ev.sdk_message_id}:${ev.block_index}`) ?? '') + ev.text);
              break;
            case 'content_block_stop':
              if (ev.channel === 'subagent') break;
              d.reasoning.markStreamBlockComplete({ attemptId: attempt.id, sdkMessageId: ev.sdk_message_id, blockIndex: ev.block_index, generation });
              break;
            case 'complete_message':
              if (ev.channel === 'subagent') break;
              if (ev.packet_uuid) {
                // F11：同包重投（归一化层）只处理首次；后续重放不再发布正文
                if (handledPacketUuids.has(ev.packet_uuid)) break;
                handledPacketUuids.add(ev.packet_uuid);
              }
              if (ev.matched.some((b) => b.block_type === 'thinking') || ev.matched.some((b) => b.block_type === 'redacted_thinking')) sawReasoningBlock = true;
              for (const b of ev.matched) {
                if (b.block_type === 'text' && typeof b.text === 'string') publishText(ev.sdk_message_id, b.block_index, b.text); // §16+F11
              }
              for (const u of ev.unmatched) {
                // §16+F11：只有无开放块对应的完整 text 才安全发布；ambiguous 不猜归属（reasoning 侧仍核对）。
                // 发布键绑定包 uuid（无则退化为 message id）——不同包同文字不误判，同包重投已被上层拦截
                if (u.reason !== 'no_open_block' || u.block_type !== 'text' || typeof u.text !== 'string' || u.text.length === 0) continue;
                publishText(`${ev.packet_uuid ?? ev.sdk_message_id}`, u.seq, u.text);
              }
              d.reasoning.reconcileCompleteMessage({
                conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
                sdkMessageId: ev.sdk_message_id, matched: ev.matched, unmatched: ev.unmatched, generation,
              });
              break;
            case 'tool_input_delta':
              d.events.publish('tool.status', {
                conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
                entityRef: `${ev.sdk_message_id}:${ev.block_index}`,
                payload: { phase: 'input_streaming', tool: null, channel: ev.channel },
              });
              break;
            case 'usage':
              d.usage.record({
                turnId, attemptId: attempt.id, scope: ev.scope, usage: ev.usage,
                requestId: reqCtx?.requestId ?? undefined, // F12：同 turn 多请求按请求身份分行保留
                windowId: window.id, // F31：直接归属窗口（不再只靠 attempt JOIN）
                model: actualModelForUsage ?? configuredModelForUsage, // F10：观测到实际模型后按实际值；OR 用明确型号
                source: ev.source, completeness: ev.completeness,
              });
              d.events.publish('usage.updated', {
                conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
                payload: { scope: ev.scope, usage: ev.usage, attempt_id: attempt.id },
              });
              break;
            case 'turn_end':
              if (ev.outcome === 'error' && ev.error_classified === 'route_signal') handleRouteSignal();
              break;
            case 'packet_conflict':
              // F11：同包标识不同载荷——不发布正文，留观测（不落 content 正文——隐私纪律）
              d.logger.warn('sdk_packet_conflict', { turn_id: turnId, code: 'PACKET_PAYLOAD_CONFLICT' });
              break;
            case 'system_notice':
              // F10：结构化 system 事件（只记 subtype/模型，不落 content 正文——隐私纪律）
              d.logger.info('sdk_system_notice', { turn_id: turnId, subtype: ev.subtype, original_model: ev.original_model, fallback_model: ev.fallback_model });
              if (ev.subtype === 'model_refusal_fallback' || ev.subtype === 'model_refusal_no_fallback') {
                const actualModel = ev.subtype === 'model_refusal_fallback' ? (ev.fallback_model ?? null) : null;
                try {
                  d.routing.recordSdkRouteEvent({
                    conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
                    subtype: ev.subtype, originalModel: ev.original_model, actualModel,
                  });
                } catch (err) {
                  d.logger.error('route_event_tx_failed', { turn_id: turnId, code: stableCode(err) });
                }
                if (actualModel) {
                  // 切换已发生：后续生成/工具动作按规格暂停——fence + abort，回合按 interrupted 收口
                  actualModelForUsage = actualModel;
                  fallbackSwitched = true;
                  runToken.token.cancelled = true;
                  runToken.controller.abort();
                }
              }
              break;
            default:
              break;
          }
    };
    const runner = d.runnerSelection.runner;
    let result: import('./runner.ts').RunnerRunResult;
    let orFinalMessages: OrMessage[] | null = null;
    let orLastSentMessages: OrMessage[] | null = null; // F18：实际发送末态（G 边界依据）
    if (orEnvelope !== null) {
      // OR：工具循环（§8.2）——含 grace fence、跨轮 append-only 断言；错误已由循环收口为终态
      const loop = await this.runOrToolLoop({
        envelope: orEnvelope, purpose: 'chat', activeReviewId: null,
        conversationId: turn.conversation_id, windowId: window.id,
        turnId, attemptId: attempt.id, controller: runToken.controller,
        onEvent: handleEvent, seenSequence: orSeenHighWater,
        previousEnvelope: orPreviousPayloadEnvelope,
      });
      result = loop.result;
      orFinalMessages = loop.finalMessages;
      orLastSentMessages = loop.lastSentMessages;
    } else {
      // SDK 分支：既有单请求路径（§11：不合作 runner 的有界终止——宽限只在 abort 之后才计时）
      try {
        result = await Promise.race([
          runner.run({ prompt, options: built!.assembled, resumeSessionId, abortController: runToken.controller, onEvent: handleEvent }),
          new Promise<never>((_, reject) => {
            const arm = (): void => {
              setTimeout(() => reject(new Error('RUNNER_GRACE_TIMEOUT')), RUNNER_GRACE_MS).unref?.();
            };
            if (runToken.controller.signal.aborted) arm();
            else runToken.controller.signal.addEventListener('abort', arm, { once: true });
          }),
        ]);
      } catch (err) {
        const isGrace = String((err as Error)?.message ?? '').includes('RUNNER_GRACE_TIMEOUT');
        if (isGrace) {
          // 不变式：grace 超时离开 await 时 runner 可能仍活着——旧代一律 fence + abort（迟到回调不得再发布）
          runToken.token.cancelled = true;
          runToken.controller.abort();
        }
        d.logger.error(isGrace ? 'runner_grace_exceeded' : 'runner_threw', { turn_id: turnId, attempt_id: attempt.id, code: stableCode(err) });
        result = { outcome: isGrace ? 'interrupted' : 'error', errorClassified: null, errorCode: isGrace ? 'RUNNER_GRACE_TIMEOUT' : 'RUNNER_THREW', errorMessage: String((err as Error)?.message ?? err), sessionId: null, requestId: null };
      }
    }
    this.active.delete(turnId);

    // session 绑定（AUD-03）：首轮把观察到的 session 持久化到窗口；
    // fresh_session 重跑完成后改绑新 session（旧 session 因含被替代输入而弃用）
    if (result.sessionId && !resumeSessionId) {
      if (attempt.fresh_session) d.windows.rebindSession(window.id, window.sdk_session_id, result.sessionId);
      else d.windows.bindSession(window.id, result.sessionId);
    }

    const now = new Date().toISOString();
    // —— 确定性终态（AUD-10/25）——
    if (runToken.token.cancelled && routeSignalHandled) {
      segmenter.drop();
      if (!sawReasoningBlock) d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
      d.events.publish('turn.status', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, entityRef: attempt.id, payload: { state: 'route_owner_pending', generation } });
      return; // attempt/turn 已在 handleRouteSignal 的事务里置 route_owner_pending
    }
    if (runToken.token.cancelled || result.outcome === 'interrupted') {
      segmenter.drop();
      d.reasoning.markAttemptFinal({ attemptId: attempt.id, final: 'interrupted', generation });
      if (!sawReasoningBlock) d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
      tx(d.db, () => {
        // F10：SDK 观测到模型切换后的暂停——如实标注原因，与用户主动停止区分
        d.db.prepare("UPDATE attempts SET state = 'interrupted', blocked_reason = ?, completed_at = ? WHERE id = ?")
          .run(fallbackSwitched ? 'MODEL_FALLBACK_SWITCHED' : null, now, attempt.id);
        d.db.prepare("UPDATE turns SET state = 'interrupted', completed_at = ? WHERE id = ?").run(now, turnId);
      });
      d.events.publish('turn.interrupted', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, payload: { generation, ...(fallbackSwitched ? { reason: 'MODEL_FALLBACK_SWITCHED' } : {}) } });
      return;
    }
    if (result.outcome === 'error' || result.outcome === 'no_final_result') {
      segmenter.drop();
      d.reasoning.markAttemptFinal({ attemptId: attempt.id, final: 'failed', generation });
      if (!sawReasoningBlock) d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
      const reasonCode = result.outcome === 'no_final_result' ? 'NO_FINAL_RESULT' : (result.errorCode ?? 'RUNNER_ERROR');
      const blockedReason = `${reasonCode}:${result.errorClassified ?? 'unknown'}`;
      tx(d.db, () => {
        d.db.prepare('UPDATE attempts SET state = ?, blocked_reason = ?, completed_at = ? WHERE id = ?').run('failed', blockedReason, now, attempt.id);
        d.db.prepare('UPDATE turns SET state = ?, completed_at = ? WHERE id = ?').run('failed', now, turnId);
      });
      d.events.publish('turn.status', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, entityRef: attempt.id, payload: { state: 'failed', reason: reasonCode } });
      d.logger.warn('attempt_failed', { turn_id: turnId, attempt_id: attempt.id, code: reasonCode });
      return;
    }

    // completed（仅当观察到 success result，runner 契约保证）
    publishSegments(([segmenter.flushTail()].filter(Boolean) as string[]));
    d.reasoning.markAttemptStreamEnded({ attemptId: attempt.id }); // 仍 streaming 的块 → complete/stream_only（无完整块核对，不伪装已核对）
    if (!sawReasoningBlock) d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
    tx(d.db, () => {
      d.db.prepare("UPDATE attempts SET state = 'completed', completed_at = ? WHERE id = ?").run(now, attempt.id);
      d.db.prepare('UPDATE turns SET state = ?, completed_at = ? WHERE id = ?').run('completed', now, turnId);
    });
    d.events.publish('turn.completed', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, payload: { generation, session_id: result.sessionId } });
    // §2.2/§7：成功回合才推进协议轨迹（append-only）+ 实际已见 manifest（F06：本轮输入与
    // 已发布助手消息入清单——下一轮范围/书签从这份证据出发）；新已发送边界=本轮末 text 块
    if (orFinalMessages !== null && d.trajectory) {
      const baseManifest = d.trajectory.forWindow(window.id)?.manifest ?? [];
      const inputEntry: ManifestEntry[] = inputMessage
        ? [{ id: inputMessage.id, revision: effective.revision, seq: inputMessage.sequence, origin: 'dialogue', visible: true }]
        : [];
      // F18：G 候选=本轮实际发送的最后一个 text 块（生成的最终 assistant 尚未随任何请求发出，
      // 不得作为"已发送边界"；它将在下一轮真实发送后才成为候选）
      const boundaryBase = orLastSentMessages ?? orFinalMessages;
      d.trajectory.replace(window.id, orFinalMessages, tailBoundaryOf(boundaryBase), [...baseManifest, ...inputEntry, ...turnManifestAdditions]);
    }
    // 原文线：助手气泡已正式发布 → 同步 drain（独立于模型结果；失败不影响 turn 终态）
    void d.archiveSync?.drainOnce().catch((err) => {
      d.logger.warn('archive_sync_after_turn_failed', { turn_id: turnId, code: stableCode(err) });
    });
  }

  // 决议后重新驱动房间（AUD-05/36/37）：waiting 已被决议事务释放为 pending；此处入队全部可跑 turn
  requeueConversationQueuedTurns(conversationId: string): void {
    const rows = this.d.db
      .prepare("SELECT t.id FROM turns t JOIN attempts a ON a.turn_id = t.id AND a.state IN ('pending','ready_after_route') WHERE t.conversation_id = ? AND t.state = 'pending'")
      .all(conversationId) as Array<{ id: string }>;
    for (const r of rows) this.enqueue(r.id);
  }

  // AUD-15/37（§9）：启动调度恢复——数据库是真源，committed-but-not-dispatched 一律重新入队
  static recoverSchedule(deps: SupervisorDeps): { redispatched: number } {
    const rows = deps.db
      .prepare("SELECT t.id FROM turns t JOIN attempts a ON a.turn_id = t.id WHERE t.state = 'pending' AND a.state IN ('pending','ready_after_route')")
      .all() as Array<{ id: string }>;
    for (const r of rows) deps.supervisor.enqueue(r.id);
    return { redispatched: rows.length };
  }

  private blockAttempt(attemptId: string, turnId: string, conversationId: string, reason: string, turnState: 'blocked' | 'route_owner_pending'): void {
    const now = new Date().toISOString();
    tx(this.d.db, () => {
      this.d.db.prepare("UPDATE attempts SET state = ?, blocked_reason = ?, completed_at = ? WHERE id = ?").run(turnState === 'route_owner_pending' ? 'route_owner_pending' : 'blocked', reason, now, attemptId);
      this.d.db.prepare('UPDATE turns SET state = ?, completed_at = ? WHERE id = ?').run(turnState, now, turnId);
    });
    this.d.events.publish('turn.status', { conversationId, turnId, attemptId, entityRef: attemptId, payload: { state: turnState, reason } });
    this.d.logger.warn('attempt_blocked', { turn_id: turnId, attempt_id: attemptId, code: reason.split(':')[0] });
  }

  private failTurnQuietly(turnId: string, code: string): void {
    const now = new Date().toISOString();
    try {
      tx(this.d.db, () => {
        const att = this.d.db.prepare("SELECT id FROM attempts WHERE turn_id = ? AND state IN ('running')").get(turnId) as { id: string } | undefined;
        this.d.db.prepare("UPDATE turns SET state = 'failed', completed_at = ? WHERE id = ? AND state IN ('running')").run(now, turnId);
        if (att) {
          this.d.db.prepare("UPDATE attempts SET state = 'failed', blocked_reason = ?, completed_at = ? WHERE id = ?").run(code, now, att.id);
          this.d.db.prepare("UPDATE reasoning_blocks SET state = 'failed', updated_at = ? WHERE attempt_id = ? AND state = 'streaming'").run(now, att.id);
        }
      });
    } catch {
      // 尽力收尾
    }
  }
}

function stableCode(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  if (/SQLITE|constraint|UNIQUE/i.test(msg)) return 'DB_ERROR';
  if (/ENOSPC|disk/i.test(msg)) return 'DISK_ERROR';
  return 'INTERNAL_ERROR';
}

function codeOf(reason: string): string {
  const m = /^([A-Z_]+)[:：]/.exec(reason);
  return m ? m[1]! : reason.split(/[：:;（(]/)[0]!.slice(0, 30);
}
