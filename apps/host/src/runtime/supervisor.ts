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
import { buildHostTools, hostToolNames, type HostToolExecutor, type ToolExecContext } from './host-tools.ts';
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
  supervisor?: TurnSupervisor; // 启动恢复重派用（recoverSchedule 静态方法无 this；实例注入后才可 enqueue）
  digest?: { yesterdaySection(signal?: AbortSignal): Promise<string | null>; ensureYesterday(signal?: AbortSignal): Promise<{ day: string; summary: string } | null> }; // 昨天日结（她裁定 2026-10-07；未注入则无日结段）
  selections?: import('../context/manual-selection.ts').ManualSelectionService; // WP3（2026-10-08）：人工历史选集——新窗历史携带的唯一来源
};

const RUNNER_GRACE_MS = 5000; // §11：不合作 runner 的强制终态宽限
const MAX_TOOL_ROUNDS = 8; // §8.2：工具续请求有界（防循环收费；超限按错误收口，允许恢复）
// §3.3 有界恢复（2026-10-05 审计 P2-1）：同窗评审失败达上限后不再自动付费评审——
// 恢复路径=评审成功换新窗（新窗计数重置）或人工处理后手动换窗；防"模型永不调用 complete"时每条消息都付费评审。
const MAX_WINDOW_REVIEW_ATTEMPTS = 3;
// R10（复审 2026-10-07）：bootstrap 受控截止时间——准备阶段不无限挂起
const BOOTSTRAP_DEADLINE_MS = 8000;

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
  private chains = new Map<string, Promise<unknown>>(); // F-J-31：runSerialized 链尾 Promise<T|void> 存迹，只 await 不读值
  private active = new Map<string, ActiveRun>(); // key = turnId
  // F-J-09（联合审计 2026-10-06）：工具 schema/顺序按 epoch（窗口）冻结——
  // 同窗续请求 tools 恒定（§7.1）；词表刷新只影响新窗快照。进程内缓存；
  // 重启后同窗首发的快照重建（跨重启的前缀漂移只影响缓存命中，不影
  // 响正确性——新窗在换窗时取新快照）。
  private frozenToolsByWindow = new Map<string, import('./or-payload.ts').OrTool[]>();
  // D2（她批准 2026-10-06）：本窗 Mariposa 开窗资料快照（缓存点 B）——
  // 首个信封前取一次并冻结（§5.2/§7.1：B 只冻结这一窗的输入快照，权限
  // 撤销/关键身份更正例外走既有安全换窗）。取不到=如实降级不带 B（事件
  // 记录），不阻塞聊天、不伪造"记忆已恢复"。
  private bootstrapByWindow = new Map<string, string>();

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

  // AUD-10/38（§10）+ D03（审计 3655d60）：启动恢复——孤儿 running/streaming/PREPARING/无票据 waiting 全部落确定状态，不重跑模型；
  //   active 评审无执行者（宿主重启即失主）→ failed（下次换窗按上限内有界重开评审，先做 unknown 写恢复）；
  //   running 写操作 → hold 记 unknown（可按 operation_id 恢复探测），本地类（review_complete 等）→ failed_resolved。
  static recoveryPass(db: Db, logger: { warn: (e: string, f: Record<string, unknown>) => void }): { turns: number; attempts: number; blocks: number; staleWindows: number; releasedWaiting: number; failedOwners: number; staleReviews: number; orphanEffects: number } {
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
    // D03a：无执行者的 active 评审 → failed（重启后没有任何协程会收口它；不伪造完成凭证）
    const staleReviews = tx(db, () => Number(db.prepare("UPDATE rotation_reviews SET status = 'failed', updated_at = ? WHERE status = 'active'").run(now).changes));
    // D03b：崩溃遗留 running 写操作——hold 类结果不明（可按 operation_id 探测恢复），本地类可判未提交
    const orphanEffects = tx(db, () => Number(db.prepare(
      "UPDATE tool_side_effects SET state = CASE WHEN kind = 'hold' THEN 'unknown' ELSE 'failed_resolved' END, updated_at = ? WHERE state = 'running'",
    ).run(now).changes));
    const total = turns + attempts + blocks + staleWindows + releasedWaiting + failedOwners + staleReviews + orphanEffects;
    if (total > 0) logger.warn('recovery_pass', { turns, attempts, blocks, staleWindows, releasedWaiting, failedOwners, staleReviews, orphanEffects, code: 'RECOVERY_HOST_RESTART' });
    return { turns, attempts, blocks, staleWindows, releasedWaiting, failedOwners, staleReviews, orphanEffects };
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
    turnId: string | null; // 自动评审无所属 turn（手动换窗评审线）——与运行时实况对齐（F-J-31）
    attemptId: string;
    controller: AbortController;
    onEvent: (ev: import('../../../../packages/contracts/src/sdk-events.ts').SdkNormalizedEvent, reqCtx?: { requestId: string | null }) => void;
    seenSequence: number;
    seenMessages: ReadonlyArray<{ id: string; revision: number }>; // D13：实际装载视野（引用核对）
    liveSeenAdditions?: ReadonlyArray<{ id: string; revision: number }>; // 流式期间新发布的已见消息（活引用，exec 时取当下值）
    onDispatch?: (info: { attemptIndex: number; generationId: string | null; payloadJson: string; prqId: string }) => void; // F17：每次真实发送逐笔留证
    previousEnvelope?: OrRequestEnvelope | null; // 跨轮 previousPayload（轨迹正本；首轮后由循环内部接管）
  }): Promise<{ result: import('./runner.ts').RunnerRunResult; finalMessages: OrMessage[] | null; lastSentMessages: OrMessage[] | null }> {
    const d = this.d;
    const runner = (d.runnerSelection as Extract<RunnerSelection, { status: 'ok' }>).runner; // runOrToolLoop 仅在信封驱动分支被调用（rotateIfNeeded 的 !dv 早退与 runTurn 的 blocked 早退均已判别 ok）
    let envelope = o.envelope;
    let prevEnvelope: OrRequestEnvelope | null = o.previousEnvelope ?? null;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const captured: MatchedCompleteBlock[] = [];
      let lastText = null as string | null; // 闭包内赋值（wrapped）：外层流分析按声明类型读（F-J-31）
      const prqId0 = `prq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const prqId = prqId0;
      let lastPrqId = prqId0; // D07：终态/计量归属**最后一次实际派发**的请求行（重试不再覆盖首发）
      const wrapped: typeof o.onEvent = (ev, reqCtx) => {
        void reqCtx;
        if (ev.kind === 'complete_message') {
          for (const b of ev.matched) if (b.block_type === 'tool_use') captured.push(b);
          const text = ev.matched.find((b) => b.block_type === 'text' && typeof b.text === 'string');
          if (text) lastText = text.text;
        }
        o.onEvent(ev, { requestId: lastPrqId }); // 审计 F12：usage 按实际请求身份去重（不互覆）
      };
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
          return { result: { outcome: 'error', errorClassified: null, errorCode: 'CAPACITY_BLOCKED_HARD_TOOL_ROUND', errorMessage: `工具续请求输入估计 ${estNow} 超过安全上界 ${planNow.safeInput}`, sessionId: null, requestId: null }, finalMessages: null, lastSentMessages: null };
        }
      }
      const payloadJson = JSON.stringify(envelope);
      const onDispatch = (info: { attemptIndex: number; generationId: string | null }): void => {
        // 审计 F17：重试的每次真实发送单独留证（首发放到本轮 planned 行，重试插新行）
        const nowIso = new Date().toISOString();
        if (info.attemptIndex === 0) {
          d.db.prepare('UPDATE provider_requests SET sent_at = ?, attempt_no = ?, generation_id = COALESCE(?, generation_id) WHERE id = ?')
            .run(nowIso, 0, info.generationId ?? null, prqId);
          lastPrqId = prqId;
        } else {
          const retryId = `prq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          d.db.prepare('INSERT INTO provider_requests(id, window_id, attempt_id, turn_id, purpose, seen_manifest_json, payload_json, created_at, sent_at, attempt_no, generation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(retryId, o.windowId, o.attemptId, o.turnId, o.purpose, JSON.stringify(envelope.messages.map((m) => ({ role: m.role }))), payloadJson, nowIso, nowIso, info.attemptIndex, info.generationId ?? null);
          lastPrqId = retryId; // D07：后续终态/usage 记在真正承载本次发送的行
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
      // D07：终态与 generation 写到**最后一次实际派发**的行；被重试取代的首发行如实标注，不被后次覆盖
      d.db.prepare('UPDATE provider_requests SET generation_id = ?, outcome = ? WHERE id = ?').run(result.requestId, result.outcome, lastPrqId);
      if (lastPrqId !== prqId) {
        d.db.prepare("UPDATE provider_requests SET outcome = 'SUPERSEDED_BY_RETRY' WHERE id = ? AND outcome IS NULL").run(prqId);
      }
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
      // D01（审计 3655d60）：DS thinking 型号在同一工具回合的续请求必须原样回传 reasoning_content
      // （官方协议继续态；§10 opaque 透传——不解释不重构，不入 UI/轨迹正本，下一用户回合清除）。
      // 仅 DS 驱动携带；OR 的协议继续态走上面的 reasoning_details 通道，两不混淆。
      if (this.drv()?.kind === 'deepseek' && typeof (result as { reasoningContent?: unknown }).reasoningContent === 'string' && (result as { reasoningContent: string }).reasoningContent.length > 0) {
        assistantContinue.reasoning_content = (result as { reasoningContent: string }).reasoningContent;
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
          return { result: { outcome: 'interrupted', errorClassified: null, errorCode: 'STOPPED_DURING_TOOLS', errorMessage: '停止：同批后续工具不再分派（已发起写单独保留待核）', sessionId: null, requestId: result.requestId }, finalMessages: null, lastSentMessages: null };
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
          activeReviewId: o.activeReviewId, seenSequence: o.seenSequence,
          seenMessages: [...o.seenMessages, ...(o.liveSeenAdditions ?? [])], // D13：含流式期间新发布的已见原话
          requestId: result.requestId ?? lastPrqId,
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

  /** 审计 F27 + D11（审计 3655d60）：为 manifest=NULL 的旧轨迹行重建已见清单——按**宿主已知结构锚定**
   *  匹配，不用裸子串（旧实现 text.includes(row.content) 会把库内更早的子串正文 A 错配给轨迹里的 AA，
   *  给未发送原话签已见证明）：
   *  - user 轨迹消息=装配投影，正文以 `[user_input]\n` 头结束 → 锚定为 endsWith(`[user_input]\n{正文}`)；
   *  - assistant 轨迹消息=已发布分段原文 → 锚定为全文等值；
   *  按序消费候选防重复正文误配；任一条无匹配 → null（范围未知，如实阻断）。 */
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
        if (row.speaker !== speaker || row.content.length === 0) continue;
        // D11：锚定匹配（杜绝子串误配）——基底段=裸正文等值；回合追加段=装配投影，以 [user_input] 头收尾
        const anchored = text === row.content
          || (speaker === 'owner' && text.endsWith(`[user_input]\n${row.content}`));
        if (anchored) {
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
  private dialogueUpTo(conversationId: string, maxSequence: number): Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string; turnId: string | null }> {
    const rows = this.d.db.prepare(
      'SELECT id, sequence, speaker, current_revision, turn_id FROM messages WHERE conversation_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 200',
    ).all(conversationId, maxSequence) as Array<{ id: string; sequence: number; speaker: string; current_revision: number; turn_id: string | null }>;
    const out: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string; turnId: string | null }> = [];
    for (const r of rows) {
      const msg = this.d.messages.getMessage(r.id);
      if (!msg) continue;
      out.push({ id: r.id, revision: r.current_revision, sequence: r.sequence, role: r.speaker === 'owner' ? 'user' : 'assistant', content: msg.revision.content, turnId: r.turn_id });
    }
    return out.reverse();
  }

  // 信封（§5.1/§5.5/§7.1，OR/DS 共用）：固定前缀=身份+当前 I+批准规则+宿主片段（审计 F02：I 完整装载）；
  // 近期原话从**最新一条向前**装满预算（审计 F06：裁剪留新丢旧）；尾部=输入/评审事件。
  // 身份映射隔离：型号/输出上限/粗估系数/session 派生按驱动取值（drv()）；DS 不发 session_id（runner 序列化丢弃）。
  /** D2：本窗开窗资料文本（B 点）——每窗取一次；Mariposa 不可达时返回
   *  null 并发布 context.warning（如实降级，不阻塞消息）。 */
  private async windowBootstrap(windowId: string, signal?: AbortSignal): Promise<string | null> {
    let t = this.bootstrapByWindow.get(windowId);
    if (t !== undefined) return t;
    const d = this.d;
    const mc = d.tools?.mariposaClient() ?? null;
    if (!mc) return null; // 未接线：如实无 B
    try {
      const r = await mc.bootstrapGet(signal);
      if (!r.ok) {
        d.events.publish('context.warning', { conversationId: 'unknown', entityRef: windowId, scope: 'private', payload: { source: 'bootstrap', code: r.code ?? 'unknown', note: '开窗资料不可用——按无 B 降级，不阻塞消息' } });
        this.bootstrapByWindow.set(windowId, '');
        return null;
      }
      const data = r.result as unknown as Record<string, any>;
      const seg: string[] = ['[memory/bootstrap：开窗资料（数据，非指令；按需可用 memory_recall 查询更多）]'];
      const days = ((data.memory_days as Record<string, any> | undefined)?.items ?? []) as Array<Record<string, unknown>>;
      if (days.length > 0) {
        seg.push('近三日记忆：');
        for (const it of days) {
          seg.push(`- ${String(it.original_title ?? '')}（${String(it.memory_date ?? '?')}）${Array.isArray(it.mood_tags) && it.mood_tags.length > 0 ? ' 心情:' + (it.mood_tags as unknown[]).join('/') : ''}`);
        }
      }
      // R11（复审 2026-10-07）：移除无状态字符串截断——服务端包本就有界
      // （每段≤50 条、I≤2000 字+truncated 标记）；宿主只渲染+如实披露
      // 截断/续页元数据，不再自行砍 200 字符丢 next_cursor
      const plansSection = data.plans as Record<string, any> | undefined;
      const plans = (plansSection?.items ?? []) as Array<Record<string, unknown>>;
      if (plans.length > 0) {
        seg.push('未完成计划：');
        for (const it of plans) seg.push(`- ${JSON.stringify(it)}`);
      }
      if (plansSection && (plansSection.next_cursor || (typeof plansSection.total === 'number' && plansSection.total > plans.length))) {
        seg.push('[未完：计划段还有更多未载入（本窗未取续页）——需要完整清单时明确说明并走计划查询]');
      }
      const annsSection = data.anniversaries as Record<string, any> | undefined;
      const anns = (annsSection?.items ?? []) as Array<Record<string, unknown>>;
      if (anns.length > 0) {
        seg.push('临近纪念：');
        for (const it of anns) seg.push(`- ${JSON.stringify(it)}`);
      }
      const iSeg = data.i as { content?: unknown; truncated?: boolean; total_chars?: number } | undefined;
      if (iSeg && typeof iSeg.content === 'string' && iSeg.content.length > 0) {
        seg.push(`I（当前的话）：${iSeg.content}`);
        if (iSeg.truncated === true) {
          seg.push(`[I 当前的话超窗未全载（全文共 ${String(iSeg.total_chars ?? '?')} 字，续读走 bootstrap.next）——已载入部分如上]`);
        }
      }
      // 昨天日结（她裁定 2026-10-07）：昨天（上海自然日）未归档闲聊的话题
      // 索引——DS 写、与换窗提醒共用一个开关；空/失败/关闭=不注入不伪造
      try {
        const digest = await d.digest?.yesterdaySection(signal);
        if (digest) seg.push(digest);
      } catch {
        d.events.publish('context.warning', { conversationId: 'unknown', entityRef: windowId, scope: 'private', payload: { source: 'digest', code: 'unavailable', note: '昨天日结不可用——不带该段，不伪造' } });
      }
      t = seg.length > 1 ? seg.join('\n') : '';
      this.bootstrapByWindow.set(windowId, t);
      return t || null;
    } catch {
      d.events.publish('context.warning', { conversationId: 'unknown', entityRef: windowId, scope: 'private', payload: { source: 'bootstrap', code: 'transport', note: '开窗资料传输失败——无 B 降级' } });
      this.bootstrapByWindow.set(windowId, '');
      return null;
    }
  }

  /** F-J-09：本窗冻结的工具快照（首发时定格，后续轮/评审/续请求复用） */
  private windowTools(windowId: string): import('./or-payload.ts').OrTool[] {
    let t = this.frozenToolsByWindow.get(windowId);
    if (!t) {
      t = buildHostTools() as unknown as import('./or-payload.ts').OrTool[];
      this.frozenToolsByWindow.set(windowId, t);
    }
    return t;
  }

  /** F-J-39：追赶投影——清单高水位之后、有真实发出证据（purpose=chat 且 sent_at 非空）的
   *  回合消息。失败回合的已发输入/已发布助手原话真实被模型看过，应计入评审范围与
   *  评审信封（不扫库假称已见；评审请求自身不算证据）。 */
  private catchupEntries(conversationId: string, dialogue: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string; turnId: string | null }>, trajMaxSeq: number): Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string; turnId: string | null }> {
    const sentChatTurnIds = new Set((this.d.db.prepare(
      "SELECT DISTINCT a.turn_id AS tid FROM attempts a JOIN provider_requests pr ON pr.attempt_id = a.id WHERE pr.purpose = 'chat' AND pr.sent_at IS NOT NULL",
    ).all() as Array<{ tid: string | null }>).map((r) => r.tid).filter((t): t is string => t !== null));
    return dialogue.filter((m) => m.sequence > trajMaxSeq && m.turnId !== null && sentChatTurnIds.has(m.turnId));
  }

  private buildEnvelope(o: {
    conversationId: string;
    materials: { identityText: string; rulesText: string; iText: string | null } | null;
    dialogue: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }>;
    tailUserText: string;
    bootText?: string | null;
    /** WP3（2026-10-08）：人工选集装配——严格按确认的引用集合装载（E04：
     *  不把 recent_dialogue_budget_tokens 设 0 代替拆分）。给出即忽略
     *  dialogue 的自动预算挑选；可为空数组=明确空选（不带历史）。 */
    selectedMessages?: Array<{ message_id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }>;
    /** 选集间隙元数据（服务端按 sequence 计算，不相邻段如实披露） */
    selectionGaps?: Array<{ after_seq: number; before_seq: number; skipped: number }>;
  }): { envelope: OrRequestEnvelope; selected: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }> } {
    const dv = this.drv()!;
    const budgetChars = this.d.config.windows.recent_dialogue_budget_tokens * dv.charsPerToken; // 粗估（§11.1 估计口径，不冒充精确）
    const systemText = [o.materials?.identityText ?? '', o.materials?.iText ?? '', o.materials?.rulesText ?? '', FIXED_RUNTIME_FRAGMENT, HOST_BOUNDARY_RULES].filter((t) => t.length > 0).join('\n\n');
    const messages: OrMessage[] = [
      { role: 'system', content: [{ type: 'text', text: systemText }] },
    ];
    // R11（复审 2026-10-07）：B（开窗资料）作为独立 system 数据块——显式
    // A/B 缓存分界（cache-plan 的 B 点分支要求 systemMessageCount>=2），
    // 不把外部资料并入 A 段升级成高优先级指令
    if (o.bootText && o.bootText.length > 0) {
      messages.push({ role: 'system', content: [{ type: 'text', text: o.bootText }] });
    }
    let selected: typeof o.dialogue = [];
    if (o.selectedMessages) {
      // WP3：人工选集——顺序=服务端 sequence（已由选集服务排好）；
      // 不要求相邻（间隙由 selectionGaps 元数据披露，不假装连续对话）
      selected = o.selectedMessages.map((m) => ({ id: m.message_id, revision: m.revision, sequence: m.sequence, role: m.role, content: m.content }));
      if (o.selectionGaps && o.selectionGaps.length > 0) {
        const gapNote = `[context/selection-gaps：以下位置之间有未选入的历史消息，按你的选择跳过——${o.selectionGaps.map((g) => `seq ${g.after_seq} 与 ${g.before_seq} 之间略过 ${g.skipped} 条`).join('；')}]`;
        messages.push({ role: 'system', content: [{ type: 'text', text: gapNote }] });
      }
    } else {
      // F06 + D08（审计 3655d60）：从最新**完整回合组**向前装预算（一组=一条用户消息+其后连续助手回复）——
      // 整组放不下就整组排除（留旧丢新不允许，留答丢问也不允许：不产生缺用户输入的孤立助手回复）。
      // 旧实现按单消息累计，预算临界时会留下回答却截掉问题。
      // 【WP5 待退役】自动 12k 携带——人工选集全面接通后删除该回退。
      const groups: Array<Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }>> = [];
      for (const m of o.dialogue) {
        if (m.role === 'user' || groups.length === 0) groups.push([]);
        groups[groups.length - 1]!.push(m);
      }
      let used = 0;
      for (let g = groups.length - 1; g >= 0; g--) {
        const group = groups[g]!;
        const groupChars = group.reduce((s, m) => s + m.content.length, 0);
        if (used + groupChars > budgetChars) break; // 整组放不下：本组及更旧全部不装
        used += groupChars;
        selected.unshift(...group);
      }
    }
    for (const m of selected) messages.push({ role: m.role, content: [{ type: 'text', text: m.content }] });
    messages.push({ role: 'user', content: [{ type: 'text', text: o.tailUserText }] });
    return {
      envelope: {
        model: dv.model,
        sessionId: dv.sessionId(o.conversationId),
        messages,
        tools: buildHostTools() as unknown as import('./or-payload.ts').OrTool[],
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
    // F-J-10（联合审计 2026-10-06）：无轨迹时 manifest=实际装载子集（buildEnvelope
    // selected，12k 预算内完整回合组）——此前用最近 200 条库投影，范围可含模型看不见
    // 的消息，签出覆盖信封外内容的 review（违反 §3.2.2"不扩大到全库"）
    const manifest: ManifestEntry[] = trajManifest ?? this.buildEnvelope({ conversationId: o.conversationId, materials: o.materials, dialogue, tailUserText: ' ' }).selected
      .map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true }));
    // R12（复审 2026-10-07）：单一正本——范围、评审正文、seenMessages、
    // 书签高水位、凭证依据全部由同一份"实际评审输入清单"驱动。追赶投影
    // 此前只进范围与正文，已见集合仍取旧 manifest——catchup 原话进了评审
    // 正文却不在已见清单，引用核对必 QUOTE_MATCH_FAILED。
    const trajEarly = d.trajectory?.forWindow(o.window.id) ?? null;
    const trajMaxEarly = trajEarly?.manifest && trajEarly.manifest.length > 0 ? Math.max(...trajEarly.manifest.map((m) => m.seq)) : -1;
    const unifiedCatchup = trajEarly ? this.catchupEntries(o.conversationId, dialogue, trajMaxEarly) : [];
    const effectiveManifest: ManifestEntry[] = trajRow !== null
      ? [...(trajManifest ?? []), ...unifiedCatchup.map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true }))]
      : manifest;

    // §11.1 估计：本地粗估 + 上次实际 usage 校准；精度如实标注。
    // D06（审计 3655d60）：**旧窗工作集不含新入站消息**——硬门只判旧窗自身是否无可挽回（blocked_hard）；
    // 新消息长度只并入"下一输入"预测触发换窗（§4.2：大输入先保存、先提醒旧窗、新输入只进新窗一次）。
    // 新窗装下新输入的最终校验由工具循环每轮的 P2 容量门承担（F03 尾），真实硬门不放松。
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
    // F-J-33：估算含 I——无轨迹回退路径此前漏计 iText（轨迹路径略保守高估，方向安全不动）
    const systemChars = (o.materials?.identityText.length ?? 0) + (o.materials?.rulesText.length ?? 0) + (o.materials?.iText?.length ?? 0) + FIXED_RUNTIME_FRAGMENT.length + HOST_BOUNDARY_RULES.length;
    const oldWindowEstimate = Math.ceil((sentChars + systemChars) / dv.charsPerToken); // 旧窗自身工作集
    const incomingEstimate = Math.ceil((currentInputLen + systemChars) / dv.charsPerToken); // 新消息独立估计（新窗视角下界）
    const lastActual = (d.db.prepare(
      `SELECT u.input_tokens FROM usage_observations u JOIN attempts a ON a.id = u.attempt_id
       WHERE a.window_id = ? AND u.input_tokens IS NOT NULL AND u.completeness = 'complete' ORDER BY u.observed_at DESC LIMIT 1`,
    ).get(o.window.id) as { input_tokens: number } | undefined)?.input_tokens ?? null;
    const workingSet = Math.max(oldWindowEstimate, lastActual ?? 0);
    // R21（复审 2026-10-07）：下一输入=旧工作集+本轮新增输入（system 只计
    // 一次）——此前 Math.max(workingSet, incomingEstimate) 漏加本轮输入，
    // 临界消息在旧窗超软线却不触发提醒/换窗（既有问题，硬门不受影响）
    const nextWithIncoming = workingSet + Math.ceil(currentInputLen / dv.charsPerToken);

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
        currentInput: workingSet, // D06：旧窗自身（硬门判这个）
        nextInput: nextWithIncoming, // 新消息并入下一输入预测（触发先提醒再换窗，不直接堵死）
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

    // WP3（2026-10-08 她裁定，H07 全入口统一）：换窗历史携带只经人工选集。
    // 需要换窗而无"本窗源"的已确认方案 → 持久 awaiting + 阻断本 attempt
    //（blocked 即释放房间串行锁——H08：等她确认期间 confirm 可达，输入
    // 已保存；未提交≠空选，绝不自动携带/自动清空）。旧窗 hold 评审范围
    // 不受选集影响（selection/seen/hold_checkpoint 三清单分离，H10）。
    let selectionId: string | null = null;
    if (d.selections) {
      const confirmed = d.selections.confirmedFor(o.conversationId);
      if (confirmed && confirmed.source_window_id === o.window.id) {
        selectionId = confirmed.selection_id;
      } else {
        const awaiting = d.selections.ensureAwaiting({
          conversationId: o.conversationId,
          sourceWindowId: o.window.id,
          expectedWindowRevision: o.window.revision,
          cutoffSequence: o.currentInputSequence - 1,
        });
        return { rotated: false, blocked: `CONTEXT_SELECTION_REQUIRED:换窗前请确认新窗携带哪些历史原文（selection_id=${awaiting.selection_id}）；当前输入已保存，确认后自动继续` };
      }
    }

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

    // 她裁定 2026-10-07 的总开关：关=换窗不发 hold 提醒（也不做昨天日结）。
    // 记录 skipped 凭证如实定位（不伪造 reviewed/held 覆盖），直接换窗。
    if (d.config.reminders && !d.config.reminders.enabled) {
      d.reviews.markSkippedEmpty(o.window.id, o.conversationId, o.window.revision, [], {
        reason: 'reminders_disabled',
        note: '她裁定开关：关=不发评审提醒、不做昨天日结',
      });
      return this.doRotate(o, reason, null, selectionId);
    }

    // —— §3.2 评审范围：书签之后、扣除已完成同范围凭证的真实原话 ——
    // §3.2.4 跨窗继承：旧窗成功书签之前的内容做"焦点豁免"（不标 reviewed，避免每次轮动强制补记早餐）；
    // 已完成/跳过的范围键按房间继承（新窗不重复检查旧窗已检查内容）。
    const checkpoint = d.checkpoint.forWindow(o.window.id);
    const priorBookmark = d.db.prepare('SELECT seen_sequence FROM hold_checkpoints WHERE room_id = ? ORDER BY updated_at DESC LIMIT 1').get(o.conversationId) as { seen_sequence: number } | undefined;
    const carriedExempt = priorBookmark && (!checkpoint || checkpoint.epochId !== o.window.id)
      ? effectiveManifest.filter((m) => m.seq <= priorBookmark.seen_sequence).map(rawKey)
      : [];
    let range;
    try {
      // F-J-39 + R12：范围=同一份 effectiveManifest（含追赶投影）——
      // 与评审信封、已见清单同源，范围 ⊆ 模型实际可见集合
      range = selectReviewRange({
        manifest: effectiveManifest,
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
      return this.doRotate(o, reason, null, selectionId); // 同范围有效凭证：直接换窗不再次收费检查（§4.3）
    }
    if (range.length === 0) {
      // F-J-40：空范围凭证携带定位依据（书签/清单高水位/触发原因/凭证计数）——
      // 空键集本身无法复核"为什么空"；不伪造 reviewed/held 全覆盖
      const manifestMax = effectiveManifest.reduce((mx, m) => Math.max(mx, m.seq), -1);
      d.reviews.markSkippedEmpty(o.window.id, o.conversationId, o.window.revision, rangeKeys, {
        reason,
        bookmark_seen_sequence: checkpoint ? checkpoint.seenSequence : null,
        manifest_high_water: manifestMax,
        manifest_entries: effectiveManifest.length,
        carried_exempt: carriedExempt.length,
      }); // §3.2.5：空范围不叫模型
      return this.doRotate(o, reason, null, selectionId);
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
    const traj = trajEarly;
    const fallbackBase = this.buildEnvelope({ conversationId: o.conversationId, materials: o.materials, dialogue, tailUserText: ' ' }).envelope.messages.slice(0, -1);
    // F-J-39 + R12：评审正文追赶投影=同一份 unifiedCatchup（与范围/已见清单
    // 同源——失败回合的已发输入/已发布原话有真实派发证据，属"截至本次已
    // 携带高水位"）
    const reviewCatchup = unifiedCatchup;
    const reviewCatchupMessages: OrMessage[] = reviewCatchup.map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] }) as unknown as OrMessage);
    const reviewBaseMessages: OrMessage[] = traj ? [...traj.messages, ...reviewCatchupMessages] : fallbackBase;
    const reviewMessages: OrMessage[] = [...reviewBaseMessages, { role: 'user', content: [{ type: 'text', text: buildPreRotateReviewMessage({ reviewId: review.id, reason, messageRefs: rangeKeys.join(', ') }) }] }];
    const { boundaries: reviewBoundaries, gDropped: reviewGDropped } = planBoundaries({ messages: reviewMessages, systemMessageCount: reviewMessages.filter((m) => m.role === 'system').length, prevBoundary: traj?.lastBoundary ?? null });
    // F-J-32：G 保护点被丢弃时发脱敏观察事件（§7.2"保护未覆盖"可观测）
    if (reviewGDropped) {
      d.events.publish('context.warning', { conversationId: o.conversationId, entityRef: o.window.id, scope: 'private', payload: { source: 'cache', code: 'g_dropped' } });
    }
    const envelope: OrRequestEnvelope = {
      model: dv.model,
      sessionId: dv.sessionId(o.conversationId),
      messages: reviewMessages,
      // F-J-09：评审请求同窗复用冻结工具快照（epoch 内 tools 恒定）
      tools: this.windowTools(o.window.id),
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
        d.usage.record({ turnId: reviewTurnId, attemptId: o.attemptId, requestId: reqCtx?.requestId ?? undefined, windowId: o.window.id, scope: ev.scope, usage: ev.usage, model: dv.model, source: ev.source, completeness: ev.completeness }); // F31：评审费用按窗口归属（D10 修复：此前误传不存在的 o.windowId → 恒 NULL）
      }
    };
    const seenHighWater = effectiveManifest.length > 0 ? Math.max(...effectiveManifest.map((m) => m.seq)) : 0;
    let result: import('./runner.ts').RunnerRunResult;
    try {
      ({ result } = await this.runOrToolLoop({
        envelope, purpose: 'pre_rotate_review', activeReviewId: review.id,
        conversationId: o.conversationId, windowId: o.window.id,
        turnId: null, attemptId: o.attemptId, controller, onEvent: quietEvent, seenSequence: seenHighWater,
        seenMessages: effectiveManifest.map((m) => ({ id: m.id, revision: m.revision })), // D13+R12：评审视野=本窗实际已见清单（单一正本，含追赶投影）
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
    return this.doRotate(o, reason, review.id, selectionId);
  }

  private doRotate(o: { conversationId: string; window: import('../windows/manager.ts').WindowRow; gate: import('../identity/service.ts').GateResult; currentInputSequence: number }, reason: 'idle' | 'capacity' | 'manual', reviewId: string | null, selectionId: string | null = null): { rotated: boolean; blocked: string | null } {
    // 审计 F05：评审期间可能已被并发换窗（手动/上一轮迟到返回）——只对评审针对的那个旧窗切换，
    // 活动指针已变则本轮评审作废（凭证留档），绝不叠加第二次轮转。
    const active = this.d.windows.activeWindow(o.conversationId);
    if (!active || active.id !== o.window.id) {
      return { rotated: false, blocked: 'ROTATION_SUPERSEDED:窗口已被并发切换，本次评审结果留档不重复换窗' };
    }
    // WP3：选集消费与窗口指针切换同一事务（E07 原子提交——selection
    // consumed + target_window_id + ACTIVE 指针要么全成要么全回滚）
    const rotated = this.d.windows.rotate({ conversationId: o.conversationId, gate: o.gate, maxSequence: o.currentInputSequence - 1, assembledOptions: null, selectionId: selectionId ?? undefined });
    if (!rotated.ok) return { rotated: false, blocked: `ROTATE_PREPARE_FAILED:${rotated.reason.slice(0, 80)}` };
    this.d.events.publish('window.rotated', { conversationId: o.conversationId, entityRef: rotated.window.id, scope: 'private', payload: { reason, review_id: reviewId, selection_id: selectionId } });
    return { rotated: true, blocked: null };
  }

  /** 审计 F05：手动换窗入口——与自动换窗同一条评审管线（同互斥/恢复/未决检查/CAS），
   *  不再存在绕过评审的直转旁路。SDK 驱动（无评审线）保持 v0.2.2 行为（running/票据检查仍在 manager）。 */
  // —— WP3（MANUAL_HANDOFF_JUDGE_SWITCH_V1）：人工选集的宿主面 ——

  /** 选集容量估计上下文（§6.2：选集+A/B 系统段+待回答输入一起算；
   *  未知 tokenizer 标 rough；界=有效软线 min(soft, C-O-T-R-S)——装得下
   *  还要过请求级容量终检，这里只做选集级预检）。 */
  private selectionEstimateContext(tailInputChars: number): { charsPerToken: number; systemChars: number; tailInputChars: number; capacityBoundTokens: number } | null {
    const d = this.d;
    const dv = this.drv();
    if (!dv) {
      // SDK 驱动（无信封映射）：粗估回退——不做选集级容量预检（请求级
      // 容量门仍在 SDK 侧），系统段记 0、界=不设限；tokenizer 未知=rough
      return { charsPerToken: 1.5, systemChars: 0, tailInputChars, capacityBoundTokens: Number.MAX_SAFE_INTEGER };
    }
    const gate = d.identity.evaluateGate(d.db, { driver: dv.kind });
    const materials = gate.state === 'READY' && gate.manifest ? d.identity.loadVerifiedMaterials(gate.manifest) : null;
    const systemChars = (materials?.identityText.length ?? 0) + (materials?.rulesText.length ?? 0) + (materials?.iText?.length ?? 0) + FIXED_RUNTIME_FRAGMENT.length + HOST_BOUNDARY_RULES.length;
    const w = d.config.windows;
    const capacity = w.model_context_capacity ?? Number.MAX_SAFE_INTEGER;
    const bound = Math.min(w.soft_limit_tokens, capacity - dv.maxTokens - w.tool_input_reserve_tokens - w.review_reserve_tokens - w.safety_reserve_tokens);
    return { charsPerToken: dv.charsPerToken, systemChars, tailInputChars, capacityBoundTokens: Math.max(0, bound) };
  }

  /** 选择面截止水位：最后一条"已了结"消息（其 turn 非 pending/blocked）——
   *  待回答与排队输入不得作为历史带入（H04）。 */
  private selectionCutoffSequence(conversationId: string): number {
    const row = this.d.db.prepare(
      `SELECT MAX(m.sequence) AS m FROM messages m
       LEFT JOIN turns t ON t.input_message_id = m.id
       WHERE m.conversation_id = ? AND (t.id IS NULL OR t.state NOT IN ('pending','blocked'))`,
    ).get(conversationId) as { m: number | null };
    return row?.m ?? 0;
  }

  /** 待回答/排队输入的总字符（容量估计并入"当前待回答输入"，H04/H05）。 */
  private selectionPendingInputChars(conversationId: string): number {
    const row = this.d.db.prepare(
      `SELECT COALESCE(SUM(LENGTH(r.content)), 0) AS chars FROM messages m
       JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
       JOIN turns t ON t.input_message_id = m.id
       WHERE m.conversation_id = ? AND t.state IN ('pending','blocked')`,
    ).get(conversationId) as { chars: number };
    return row?.chars ?? 0;
  }

  /** preview（§6.2）：只读核验——不跑模型、不 hold、不换窗、不写选集。 */
  selectionPreview(conversationId: string, windowId: string, items: Array<{ message_id: string; revision?: number; content_hash?: string }>): { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string } & Record<string, unknown> } {
    const d = this.d;
    if (!d.selections) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNAVAILABLE', detail: '选集服务未接线' } };
    const win = d.windows.get(windowId);
    if (!win || win.conversation_id !== conversationId) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNKNOWN_WINDOW', detail: '窗口不存在或不属于该房间' } };
    const est = this.selectionEstimateContext(this.selectionPendingInputChars(conversationId));
    if (!est) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNAVAILABLE', detail: '无可用信封驱动（聊天模型未配置）' } };
    const cutoff = this.selectionCutoffSequence(conversationId);
    return d.selections.preview({ conversationId, sourceWindowId: windowId, expectedWindowRevision: win.revision, items, cutoffSequence: cutoff, estimate: est, capacityBoundTokens: est.capacityBoundTokens });
  }

  /** confirm（§6.2/§6.3）：幂等确认；有被选集阻断的待回答输入时确认后
   *  自动换窗+原 input_message_id 恢复（只发一次，不重复 submit）。 */
  async selectionConfirm(o: {
    conversationId: string;
    windowId: string;
    items: Array<{ message_id: string; revision?: number; content_hash?: string }>;
    explicitEmpty: boolean;
    idempotencyKey: string | null;
    expectedWindowRevision?: number;
  }): Promise<{ ok: true; selection_id: string; rotated: boolean; windowId: string | null; resumed: number } | { ok: false; error: { code: string } & Record<string, unknown> }> {
    const d = this.d;
    if (!d.selections) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNAVAILABLE', detail: '选集服务未接线' } };
    const win = d.windows.get(o.windowId);
    const isSentinel = o.windowId.startsWith('csel-src-');
    if (!win && !isSentinel) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNKNOWN_WINDOW', detail: '窗口不存在或不属于该房间' } };
    if (win && win.conversation_id !== o.conversationId) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNKNOWN_WINDOW', detail: '窗口不属于该房间' } };
    const est = this.selectionEstimateContext(this.selectionPendingInputChars(o.conversationId));
    if (!est) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNAVAILABLE', detail: '无可用信封驱动（聊天模型未配置）' } };
    const cutoff = this.selectionCutoffSequence(o.conversationId);
    const confirmed = d.selections.confirm({
      conversationId: o.conversationId,
      sourceWindowId: o.windowId,
      // 显式携带的 expected_window_revision 优先（§6.2 preview→confirm
      // 期间窗口被并发轮转的 CAS；未携带按当前窗口修订）
      expectedWindowRevision: o.expectedWindowRevision ?? (win ? win.revision : 0),
      items: o.items,
      explicitEmpty: o.explicitEmpty,
      idempotencyKey: o.idempotencyKey,
      cutoffSequence: cutoff,
      estimate: est,
      capacityBoundTokens: est.capacityBoundTokens,
    });
    if (!confirmed.ok) return { ok: false, error: confirmed.error as { code: string } & Record<string, unknown> };
    // 有被选集阻断的待回答输入 → 确认即恢复（换窗/建窗 + 原输入重派一次）
    const blockedRows = d.db.prepare(
      "SELECT COUNT(*) n FROM turns t JOIN attempts a ON a.turn_id = t.id AND a.state='blocked' AND a.blocked_reason LIKE 'CONTEXT_SELECTION_REQUIRED%' WHERE t.conversation_id = ? AND t.state='blocked'",
    ).get(o.conversationId) as { n: number };
    if (blockedRows.n === 0) {
      return { ok: true, selection_id: confirmed.selection.selection_id, rotated: false, windowId: null, resumed: 0 };
    }
    const resumed = await this.resumeAfterSelectionConfirm(o.conversationId);
    return resumed.ok
      ? { ok: true, selection_id: confirmed.selection.selection_id, rotated: true, windowId: resumed.windowId, resumed: resumed.resumed }
      : { ok: false, error: { code: 'CONTEXT_SELECTION_RESUME_FAILED', detail: resumed.reason.slice(0, 200), selection_id: confirmed.selection.selection_id, resumed: resumed.resumed } };
  }

  /** 确认后的恢复（§6.3）：同一串行队列 → 换窗（或无活动窗时建窗）→
   *  以原 input_message_id 重派被阻断输入（不 submitUserMessage，不重复
   *  归档）。旧窗 hold 提醒/unknown 恢复在换窗管线内照常执行。 */
  async resumeAfterSelectionConfirm(conversationId: string): Promise<{ ok: true; windowId: string; resumed: number } | { ok: false; reason: string; resumed: number }> {
    return this.runSerialized(conversationId, async () => {
      const d = this.d;
      let rot: { ok: true; windowId: string } | { ok: false; reason: string };
      if (d.windows.activeWindow(conversationId)) {
        rot = await this.manualRotateInner(conversationId);
      } else {
        // 无活动窗（H13 分支的恢复）：按已确认选集直接建窗
        const dv = this.drv();
        const gate = d.identity.evaluateGate(d.db, { driver: dv ? dv.kind : 'claude-agent-sdk' });
        const confirmed = d.selections?.confirmedFor(conversationId) ?? null;
        const selId = confirmed && confirmed.status === 'confirmed' ? confirmed.selection_id : undefined;
        const created = d.windows.createWindow({ conversationId, gate, assembledOptions: null, selectionId: selId });
        rot = created.window.status === 'ACTIVE' ? { ok: true, windowId: created.window.id } : { ok: false, reason: created.blockedReason ?? '建窗失败' };
      }
      const rows = d.db.prepare(
        "SELECT DISTINCT t.id FROM turns t JOIN attempts a ON a.turn_id = t.id AND a.state='blocked' AND a.blocked_reason LIKE 'CONTEXT_SELECTION_REQUIRED%' WHERE t.conversation_id = ? AND t.state='blocked'",
      ).all(conversationId) as Array<{ id: string }>;
      for (const r of rows) {
        tx(d.db, () => {
          d.db.prepare("UPDATE attempts SET state='pending', blocked_reason=NULL WHERE turn_id=? AND state='blocked' AND blocked_reason LIKE 'CONTEXT_SELECTION_REQUIRED%'").run(r.id);
          d.db.prepare("UPDATE turns SET state='pending', completed_at=NULL WHERE id=? AND state='blocked'").run(r.id);
        });
        this.enqueue(r.id); // 链尾排队（当前串行任务结束后执行）
      }
      return rot.ok ? { ok: true, windowId: rot.windowId, resumed: rows.length } : { ok: false, reason: rot.reason, resumed: rows.length };
    });
  }

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
    // D02（审计 3655d60）：手动换窗与普通回合同一上下文指纹门——身份/规则/驱动变化后旧窗轨迹失效，
    // 不得把旧 system/协议轨迹再发给模型评审（§4.4 安全性优先于提醒：被撤换的身份内容不外发）。
    // 处置=旧窗 CONTEXT_STALE + 按**新材料**直接建新窗（跳过对失效内容的评审，不伪造检查凭证）。
    // WP3（H07）：身份失效路径保留"不外发失效旧身份"的特殊处理，但同样
    // 要求选集确认——不能借身份失效绕过人工选择。
    const expectedFingerprint = contextFingerprint(d.config, gate.manifest);
    const maxSeqNow = () => (d.db.prepare('SELECT COALESCE(MAX(sequence),0) AS m FROM messages WHERE conversation_id = ?').get(conversationId) as { m: number }).m;
    if (window.context_fingerprint && window.context_fingerprint !== expectedFingerprint) {
      if (gate.state !== 'READY') {
        d.windows.markContextStale(window.id, 'CONTEXT_FINGERPRINT_MISMATCH');
        return { ok: false, reason: `IDENTITY_BLOCKED：${gate.reasons.join('; ')}（旧窗已标失效，新材料就绪后重试手动换窗）` };
      }
      // WP3 选集门（与主线同一规则：无本窗源的已确认方案 → awaiting 阻断）
      let staleSelectionId: string | null = null;
      if (d.selections) {
        const confirmed = d.selections.confirmedFor(conversationId);
        if (confirmed && confirmed.source_window_id === window.id) {
          staleSelectionId = confirmed.selection_id;
        } else {
          const awaiting = d.selections.ensureAwaiting({
            conversationId, sourceWindowId: window.id,
            expectedWindowRevision: window.revision,
            cutoffSequence: maxSeqNow(),
          });
          return { ok: false, reason: `CONTEXT_SELECTION_REQUIRED:身份变化换窗同样需要确认历史选集（selection_id=${awaiting.selection_id}）` };
        }
      }
      // 先按旧窗 CAS 轮转（rotate 需要 ACTIVE 旧窗），成功后给旧窗补记失效原因——
      // 旧窗终态=CLOSED+ROTATED_CONTEXT_STALE，新窗按新材料装配，失效轨迹零外发。
      const r = d.windows.rotate({
        conversationId, gate,
        maxSequence: maxSeqNow(),
        assembledOptions: null,
        selectionId: staleSelectionId ?? undefined,
      });
      if (r.ok) {
        d.db.prepare("UPDATE windows SET blocked_reason = 'ROTATED_CONTEXT_STALE' WHERE id = ?").run(window.id);
        d.events.publish('window.rotated', { conversationId, entityRef: r.window.id, scope: 'private', payload: { reason: 'manual-stale-context', review_id: null, stale_window: window.id, selection_id: staleSelectionId } });
        return { ok: true, windowId: r.window.id };
      }
      d.windows.markContextStale(window.id, 'CONTEXT_FINGERPRINT_MISMATCH');
      return { ok: false, reason: `IDENTITY_STALE_ROTATE_FAILED:${r.reason.slice(0, 80)}` };
    }
    if (!dv || !d.tools || !d.reviews || !d.checkpoint) {
      // SDK 驱动（无评审线）保持 v0.2.2 行为 + WP3 选集门（H07 全入口统一：
      // SDK 新窗用独立 session 与同一引用选集，不残留自动历史回退）
      let sdkSelectionId: string | null = null;
      if (d.selections) {
        const confirmed = d.selections.confirmedFor(conversationId);
        if (confirmed && confirmed.source_window_id === window.id) {
          sdkSelectionId = confirmed.selection_id;
        } else {
          const awaiting = d.selections.ensureAwaiting({
            conversationId, sourceWindowId: window.id,
            expectedWindowRevision: window.revision,
            cutoffSequence: maxSeqNow(),
          });
          return { ok: false, reason: `CONTEXT_SELECTION_REQUIRED:换窗前请确认新窗携带哪些历史原文（selection_id=${awaiting.selection_id}）` };
        }
      }
      const r = d.windows.rotate({ conversationId, gate, maxSequence: maxSeqNow(), assembledOptions: null, selectionId: sdkSelectionId ?? undefined });
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
      // WP3（H13，她裁定 2026-10-08）：已有历史但无活动窗**不擅自空选**——
      // 锚定 awaiting 等人工确认；只有真正全新的空房间才自动建首窗
      //（first_window_empty：无历史可带，自动空初始化合法）。恢复锚=最近
      // 一个窗口行（任意状态）；无窗口行的存量历史用哨兵源。
      if (dv && d.selections) {
        // H13 判据=**已了结**历史（其 turn 非 pending/blocked）——本输入
        // 自身还在 pending，不能把自己算成"已有历史"（首条消息即建窗）
        const histCount = (d.db.prepare(
          `SELECT COUNT(*) n FROM messages m LEFT JOIN turns t ON t.input_message_id = m.id
           WHERE m.conversation_id = ? AND (t.id IS NULL OR t.state NOT IN ('pending','blocked'))`,
        ).get(turn.conversation_id) as { n: number }).n;
        if (histCount > 0) {
          const lastWin = d.db.prepare('SELECT id, revision FROM windows WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get(turn.conversation_id) as { id: string; revision: number } | undefined;
          const awaiting = d.selections.ensureAwaiting({
            conversationId: turn.conversation_id,
            sourceWindowId: lastWin?.id ?? `csel-src-${turn.conversation_id}`,
            expectedWindowRevision: lastWin?.revision ?? 0,
            cutoffSequence: (d.db.prepare('SELECT COALESCE(MAX(sequence),0) AS m FROM messages WHERE conversation_id = ?').get(turn.conversation_id) as { m: number }).m,
          });
          this.blockAttempt(attempt.id, turnId, turn.conversation_id, `CONTEXT_SELECTION_REQUIRED:本房间已有历史但当前无活动窗口，请先确认新窗携带哪些历史（selection_id=${awaiting.selection_id}）；输入已保存`, 'blocked');
          return;
        }
      }
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
    // R10（复审 2026-10-07）：准备阶段开始即可取消——活动代登记先于任何
    // await（此前 bootstrap 挂起发生在登记前，Stop 只认 active，房间卡在
    // 准备 await 上）。bootstrap 带受控截止时间+取消传递；取消后迟到
    // 结果不得再启动模型。
    const prepController = new AbortController();
    const prepRun: ActiveRun = { token: { cancelled: false }, controller: prepController, generation: turn.generation + 1 };
    this.active.set(turnId, prepRun);
    const prepSignal = AbortSignal.any([prepController.signal, AbortSignal.timeout(BOOTSTRAP_DEADLINE_MS)]);
    if (dv && d.trajectory) {
      const trajExists = d.trajectory.forWindow(window.id) !== null;
      if (!trajExists) {
        // WP3：新窗历史装配只经人工选集（forTargetWindow 命中=消费过选集的
        // 新窗，严格按引用装配；空选=不带历史）。无选集命中的窗（真全新
        // 首窗/升级兼容期）维持旧自动回退——由 WP5 随 DS/12k 一并退役。
        const baseDialogue = this.dialogueUpTo(turn.conversation_id, inputMessage ? inputMessage.sequence - 1 : Number.MAX_SAFE_INTEGER);
        // D2（她批准 2026-10-06）：新窗轨迹初始化时装入开窗资料（缓存点 B）——
        // B 进入轨迹正本的 system 段并随窗冻结（§7.1 首次装配后固定）；取不到
        // =无 B 降级（context.warning 已记），不阻塞消息、不伪造"记忆已恢复"
        const boot0 = await this.windowBootstrap(window.id, prepSignal);
        const sel0 = d.selections?.forTargetWindow(window.id) ?? null;
        const built0 = sel0
          ? this.buildEnvelope({ conversationId: turn.conversation_id, materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null, bootText: boot0, dialogue: [], tailUserText: ' ', selectedMessages: d.selections!.loadContents(sel0.items ?? []), selectionGaps: d.selections!.gapsOf(sel0.items ?? []) })
          : this.buildEnvelope({ conversationId: turn.conversation_id, materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null, bootText: boot0, dialogue: baseDialogue, tailUserText: ' ' });
        // F06（复审修正）：manifest 从 buildEnvelope 实际选中的子集生成——裁剪掉旧消息时
        // 不再按索引回映全量前缀 ID（正文含 B、清单含 A 的错配源头）
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
        this.active.delete(turnId);
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
            const bootR = await this.windowBootstrap(window.id, prepSignal);
            // WP3：换窗后的新窗按消费的选集装配（选集在 doRotate 同事务
            // 绑定 target_window_id；无命中=兼容期自动回退）
            const selR = d.selections?.forTargetWindow(window.id) ?? null;
            const builtR = selR
              ? this.buildEnvelope({ conversationId: turn.conversation_id, materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null, bootText: bootR, dialogue: [], tailUserText: ' ', selectedMessages: d.selections!.loadContents(selR.items ?? []), selectionGaps: d.selections!.gapsOf(selR.items ?? []) })
              : this.buildEnvelope({ conversationId: turn.conversation_id, materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null, bootText: bootR, dialogue: baseDialogue, tailUserText: ' ' });
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
    if (claimed !== 1) { // 已被其他执行路径占有：跳过（数据库是真源）
      if (this.active.get(turnId) === prepRun) this.active.delete(turnId);
      return;
    }
    d.events.publish('turn.status', {
      conversationId: turn.conversation_id, turnId, attemptId: attempt.id, entityRef: attempt.id,
      payload: { state: 'running', attempt_no: attempt.attempt_no, generation, resume_session: Boolean(resumeSessionId) },
    });

    // R10：准备阶段被取消 → 迟到的 bootstrap 结果不得再启动模型
    if (prepRun.token.cancelled) {
      this.active.delete(turnId);
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'STOPPED_DURING_PREP:准备阶段已取消——迟到资料不派发模型，输入已保存', 'blocked');
      return;
    }
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
    // D05（审计 3655d60）：轨迹追赶投影——上一轨迹落盘后新发布的消息（含失败回合的已发输入与已发布
    // 助手原话）按库内当前修订补进本次信封，模型上下文与聊天界面不再分叉。成功回合的轨迹已含它们
    // （无重复）；失败回合不落轨迹，下一轮按同一规则重算（自愈且幂等，重试不去重问题不存在——
    // 失败轮的输入修订若被 route-edit 替代，追赶段按 current_revision 取到的是新修订，仍只出现一次）。
    const trajMaxSeq = orTraj?.manifest && orTraj.manifest.length > 0 ? Math.max(...orTraj.manifest.map((m) => m.seq)) : -1;
    // D05/D06 交互：追赶只收**有真实发出证据**的回合（该回合存在 purpose='chat' 且 sent_at 非空的请求）——
    // 被 P2 硬门拒发的大输入从未上线，不得被追赶投影反复注回上下文（否则 F25 短输入被永久堵死的
    // 回归以新形式复现）；评审请求（pre_rotate_review）不算证据（其信封不含聊天正文）。
    // F-J-39：追赶投影与评审路径同源（catchupEntries 单一实现）
    const catchup = orTraj ? this.catchupEntries(turn.conversation_id, dialogueForInput, trajMaxSeq) : [];
    const catchupMessages: OrMessage[] = catchup.map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] }) as unknown as OrMessage);
    const catchupManifest: ManifestEntry[] = catchup.map((m) => ({ id: m.id, revision: m.revision, seq: m.sequence, origin: 'dialogue' as const, visible: true }));
    const orBaseMessages: OrMessage[] = orTraj
      ? [...orTraj.messages, ...catchupMessages]
      : (dv ? this.buildEnvelope({ conversationId: turn.conversation_id, materials: materials ? { identityText: materials.identityText, rulesText: materials.rulesText, iText: materials.iText } : null, dialogue: dialogueForInput, tailUserText: prompt }).envelope.messages : []);
    const orMessages: OrMessage[] = orTraj
      ? [...orTraj.messages, ...catchupMessages, { role: 'user', content: [{ type: 'text', text: prompt }] } as unknown as OrMessage]
      : orBaseMessages;
    const orEnvelope: OrRequestEnvelope | null = dv
      ? (() => {
          // R11：systemMessageCount 按实际（B 独立数据块时=2，cache-plan
          // 的独立 B 点分支由此生效；此前硬编码 1，B 点显式边界从未成立）
          const { boundaries, gDropped } = planBoundaries({ messages: orMessages, systemMessageCount: orMessages.filter((m) => m.role === 'system').length, prevBoundary: orTraj?.lastBoundary ?? null });
          if (gDropped) {
            d.events.publish('context.warning', { conversationId: turn.conversation_id, entityRef: window.id, scope: 'private', payload: { source: 'cache', code: 'g_dropped' } });
          }
          return {
            model: dv.model,
            sessionId: dv.sessionId(turn.conversation_id),
            messages: orMessages,
            // F-J-09：本窗冻结快照（首发定格；词表中途变化不改变本窗 tools）
            tools: this.windowTools(window.id),
            boundaries,
            maxTokens: dv.maxTokens,
            reasoning: dv.reasoning,
          };
        })()
      : null;
    // F-J-09：跨轮 previousPayload 的 tools 取**已发送冻结快照**（本窗首发定格），
    // 不用本轮重建结果充当"上一请求"——若当前信封 tools 与冻结快照漂移（回归），
    // append-only 断言可在跨轮间抓到（此前两边恒同源=结构性失明）
    const orPreviousPayloadEnvelope: OrRequestEnvelope | null = orTraj && orEnvelope !== null ? { ...orEnvelope, tools: this.windowTools(window.id), messages: [...orTraj.messages, ...catchupMessages] } : null;
    // F14：书签视野=发起请求实际看见的位置——本轮输入已进入 payload，序号=输入序号（不再减一）
    const orSeenHighWater = inputMessage ? inputMessage.sequence : 0;
    // D13（审计 3655d60）：本请求**实际装载**的 (消息,修订) 视野——引用核对只认这份清单
    const orSeenBase: ReadonlyArray<{ id: string; revision: number }> = orTraj
      ? [...(orTraj.manifest ?? []).map((m) => ({ id: m.id, revision: m.revision })), ...catchupManifest.map((m) => ({ id: m.id, revision: m.revision })), ...(inputMessage ? [{ id: inputMessage.id, revision: effective.revision }] : [])]
      : catchupManifest.map((m) => ({ id: m.id, revision: m.revision }));
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
        seenMessages: orSeenBase, liveSeenAdditions: turnManifestAdditions, // D13：流式发布即时入视野
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
      // D01（审计 3655d60）：DS 的 reasoning_content 只是同轮工具续传的协议继续态——落轨迹前剥除，
      // 下一用户回合绝不携带（DS 官方合同：跨回合回传不被允许且无意义）。provider_requests 留的是
      // 实际发送副本，不剥（对账需要真实形状）。
      const trajMessages: OrMessage[] = dv?.kind === 'deepseek'
        ? orFinalMessages.map((m) => (m.role === 'assistant' && typeof (m as { reasoning_content?: unknown }).reasoning_content === 'string'
          ? (({ reasoning_content: _strip, ...rest }) => rest as OrMessage)(m as Record<string, unknown> & OrMessage)
          : m))
        : orFinalMessages;
      // F18：G 候选=本轮实际发送的最后一个 text 块（生成的最终 assistant 尚未随任何请求发出，
      // 不得作为"已发送边界"；它将在下一轮真实发送后才成为候选）
      const boundaryBase = orLastSentMessages ?? orFinalMessages;
      d.trajectory.replace(window.id, trajMessages, tailBoundaryOf(boundaryBase), [...baseManifest, ...catchupManifest, ...inputEntry, ...turnManifestAdditions]);
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
    for (const r of rows) deps.supervisor!.enqueue(r.id);
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
