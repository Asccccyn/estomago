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
};

const RUNNER_GRACE_MS = 5000; // §11：不合作 runner 的强制终态宽限

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
    const prev = this.chains.get(conv.conversation_id) ?? Promise.resolve();
    const next = prev
      .then(() => this.runTurn(turnId))
      .catch((err) => {
        // AUD-10：链条内崩溃不留悬挂——该 turn 落 failed 终态
        this.d.logger.error('turn_crashed', { turn_id: turnId, code: stableCode(err) });
        this.failTurnQuietly(turnId, 'RUNNER_CRASHED');
      })
      .finally(() => {
        if (this.chains.get(conv.conversation_id) === next) this.chains.delete(conv.conversation_id);
      });
    this.chains.set(conv.conversation_id, next);
  }

  async waitIdle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  stop(turnId: string): { stopped: boolean; generation: number | null } {
    const run = this.active.get(turnId);
    if (!run) return { stopped: false, generation: null };
    run.token.cancelled = true; // generation fence：迟到 chunk 一律丢弃
    run.controller.abort();
    // AUD-10（§11）：不合作 runner 的有界终止——grace 后强制落终态，即使底层 promise 永不 resolve
    setTimeout(() => this.forceFinalizeIfStuck(turnId, run), RUNNER_GRACE_MS).unref?.();
    return { stopped: true, generation: run.generation };
  }

  private forceFinalizeIfStuck(turnId: string, run: ActiveRun): void {
    const cur = this.active.get(turnId);
    if (cur !== run) return; // 已正常收尾
    this.active.delete(turnId);
    try {
      const now = new Date().toISOString();
      tx(this.d.db, () => {
        const att = this.d.db.prepare("SELECT id FROM attempts WHERE turn_id = ? AND state = 'running'").get(turnId) as { id: string } | undefined;
        this.d.db.prepare("UPDATE turns SET state = 'interrupted', completed_at = ? WHERE id = ? AND state = 'running'").run(now, turnId);
        if (att) {
          this.d.db.prepare("UPDATE attempts SET state = 'interrupted', blocked_reason = 'RUNNER_GRACE_TIMEOUT', completed_at = ? WHERE id = ?").run(now, att.id);
          this.d.db.prepare("UPDATE reasoning_blocks SET state = 'interrupted', updated_at = ? WHERE attempt_id = ? AND state = 'streaming'").run(now, att.id);
        }
      });
      this.d.events.publish('turn.interrupted', { conversationId: null, turnId, attemptId: null, payload: { generation: run.generation, reason: 'RUNNER_GRACE_TIMEOUT' } });
      this.d.logger.warn('runner_grace_timeout', { turn_id: turnId, code: 'RUNNER_GRACE_TIMEOUT' });
    } catch { /* 尽力 */ }
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

  private async runTurn(turnId: string): Promise<void> {
    const d = this.d;
    const turn = d.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as
      | { id: string; conversation_id: string; state: string; input_message_id: string | null; generation: number }
      | undefined;
    if (!turn) return;
    const attempt = d.db.prepare("SELECT * FROM attempts WHERE turn_id = ? AND state = 'pending' ORDER BY attempt_no DESC LIMIT 1").get(turnId) as
      | { id: string; attempt_no: number; input_revision: number | null }
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
    const gate = d.identity.evaluateGate(d.db);
    const identityText = gate.state === 'READY' && gate.manifest ? d.identity.readApprovedIdentityText(gate.manifest) : null;
    const workspacesDir = buildPaths(resolveStateRoot(process.env.ESTOMAGO_HOME)).workspacesDir;
    const built = buildSdkOptions({ config: d.config, gate, identityText, cwd: workspacesDir });
    if (d.runnerSelection.status === 'blocked') {
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, `RUNTIME_NOT_READY:${d.runnerSelection.reasons.map(codeOf).join(';')}`, 'blocked');
      return;
    }
    if (built.status === 'blocked') {
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, `IDENTITY_NOT_READY:${built.reasons.map(codeOf).join(';').slice(0, 120)}`, 'blocked');
      return;
    }

    // —— 窗口与 session（AUD-03）——
    let window = d.windows.activeWindow(turn.conversation_id);
    if (!window) {
      d.windows.createWindow({ conversationId: turn.conversation_id, gate, assembledOptions: built.assembled });
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
    const resumeSessionId = window.sdk_session_id;

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

    const prompt = [
      `[estomago time-context v1]（宿主注入的程序事实，不是用户发言）`,
      JSON.stringify(timeCtx),
      ``,
      `[estomago effective-input] message_id=${inputMessage?.id ?? 'none'} revision=${effective.revision}`,
      effective.content,
    ].join('\n');
    const inputHash = effective.hash || sha256Hex(effective.content);

    const segmenter = new TextSegmenter();
    let sawReasoningBlock = false;
    // §16（AUD-24）：完整 text 块与流式正文统一核对——published 跟踪 + 前缀补尾；冲突不覆盖已发布气泡
    const publishedByMessage = new Map<string, string>();
    const publishText = (sdkMessageId: string, text: string): void => {
      const prev = publishedByMessage.get(sdkMessageId) ?? '';
      if (!text.startsWith(prev)) return; // 冲突：已发布气泡不可改写；仅记码
      const tail = text.slice(prev.length);
      if (tail.length === 0) return;
      publishedByMessage.set(sdkMessageId, text);
      publishSegments(segmenter.push(tail));
    };
    let routeSignalHandled = false;
    const publishSegments = (segs: string[]): void => {
      for (const seg of segs) {
        if (runToken.token.cancelled) return;
        const msg = d.messages.publishAssistantMessage({ conversationId: turn.conversation_id, turnId, content: seg });
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

    const runner = d.runnerSelection.runner;
    let result: import('./runner.ts').RunnerRunResult;
    try {
      result = await runner.run({
        prompt,
        options: built.assembled,
        resumeSessionId,
        abortController: runToken.controller,
        onEvent: (ev) => {
          if (runToken.token.cancelled) return; // generation fence（AUD-05/03 迟到 chunk）
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
              publishText(ev.sdk_message_id, (publishedByMessage.get(ev.sdk_message_id) ?? '') + ev.text);
              break;
            case 'content_block_stop':
              if (ev.channel === 'subagent') break;
              d.reasoning.markStreamBlockComplete({ attemptId: attempt.id, sdkMessageId: ev.sdk_message_id, blockIndex: ev.block_index, generation });
              break;
            case 'complete_message':
              if (ev.channel === 'subagent') break;
              if (ev.matched.some((b) => b.block_type === 'thinking') || ev.matched.some((b) => b.block_type === 'redacted_thinking')) sawReasoningBlock = true;
              for (const b of ev.matched) {
                if (b.block_type === 'text' && typeof b.text === 'string') publishText(ev.sdk_message_id, b.text); // §16：完整正文核对入通道
              }
              for (const u of ev.unmatched) {
                if (u.block_type === 'text' && typeof u.text === 'string' && u.text.length > 0 && !(publishedByMessage.get(ev.sdk_message_id))) {
                  publishText(ev.sdk_message_id, u.text); // 无流式正文的完整 text（唯一候选歧义时不猜，仅 no_open_block 情况可安全发布）
                }
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
                model: d.config.runtime.model, source: ev.source, completeness: ev.completeness,
              });
              d.events.publish('usage.updated', {
                conversationId: turn.conversation_id, turnId, attemptId: attempt.id,
                payload: { scope: ev.scope, usage: ev.usage, attempt_id: attempt.id },
              });
              break;
            case 'turn_end':
              if (ev.outcome === 'error' && ev.error_classified === 'route_signal') handleRouteSignal();
              break;
            default:
              break;
          }
        },
      });
    } catch (err) {
      // AUD-10：runner 异常也走统一终态
      d.logger.error('runner_threw', { turn_id: turnId, attempt_id: attempt.id, code: stableCode(err) });
      result = { outcome: 'error', errorClassified: 'unknown', errorCode: 'RUNNER_THREW', errorMessage: String((err as Error)?.message ?? err), sessionId: null, requestId: null };
    }
    this.active.delete(turnId);

    // session 绑定（AUD-03）：首轮把观察到的 session 持久化到窗口
    if (result.sessionId && !resumeSessionId) {
      d.windows.bindSession(window.id, result.sessionId);
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
        d.db.prepare("UPDATE attempts SET state = 'interrupted', completed_at = ? WHERE id = ?").run(now, attempt.id);
        d.db.prepare("UPDATE turns SET state = 'interrupted', completed_at = ? WHERE id = ?").run(now, turnId);
      });
      d.events.publish('turn.interrupted', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, payload: { generation } });
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
      d.db.prepare("UPDATE turns SET state = 'completed', completed_at = ? WHERE id = ?").run(now, turnId);
    });
    d.events.publish('turn.completed', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, payload: { generation, session_id: result.sessionId } });
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
