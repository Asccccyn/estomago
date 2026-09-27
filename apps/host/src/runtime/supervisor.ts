// Turn Supervisor（01 §5.2/§5.3）：每个 conversation 同时只有一个有效执行者（首版并发 1）。
// 顺序：刷新 Time Context → 检查路由待决/身份/运行时 gate → fence 当前 generation →
// 跑 runner → 归一化分流（thinking→reasoning，text→分句发布）→ finalizer 收尾。
// stop：先 fence（迟到 chunk 失效）再 abort；已发布气泡保留，未发布缓冲丢弃。
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
import { TextSegmenter } from '../output/segments.ts';
import { sha256Hex } from '../util/id.ts';

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

type ActiveRun = {
  token: { cancelled: boolean };
  controller: AbortController;
  generation: number;
};

export class TurnSupervisor {
  private chains = new Map<string, Promise<void>>();
  private active = new Map<string, ActiveRun>(); // key = turnId

  private d: SupervisorDeps;
  constructor(d: SupervisorDeps) {
    this.d = d;
  }

  // 每 conversation 串行；turn 之间按提交顺序
  enqueue(turnId: string): void {
    const conv = this.d.db.prepare('SELECT conversation_id FROM turns WHERE id = ?').get(turnId) as { conversation_id: string } | undefined;
    if (!conv) return;
    const prev = this.chains.get(conv.conversation_id) ?? Promise.resolve();
    const next = prev
      .then(() => this.runTurn(turnId))
      .catch((err) => {
        // 单个 turn 崩溃不拖垮队列；状态在 runTurn 内部落库
        this.d.logger.error('turn_crashed', { turn_id: turnId, error: (err as Error).message });
      })
      .finally(() => {
        if (this.chains.get(conv.conversation_id) === next) this.chains.delete(conv.conversation_id);
      });
    this.chains.set(conv.conversation_id, next);
  }

  async waitIdle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  // 控制通道（5.3）：先 fence 再取消；没有活动代则如实返回
  stop(turnId: string): { stopped: boolean; generation: number | null } {
    const run = this.active.get(turnId);
    if (!run) return { stopped: false, generation: null };
    run.token.cancelled = true; // generation fence：迟到 chunk 一律丢弃
    run.controller.abort();
    return { stopped: true, generation: run.generation };
  }

  createAttempt(turnId: string, inputRevision: number | null): string {
    const attemptId = `att_${turnId.slice(4)}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const row = this.d.db.prepare('SELECT MAX(attempt_no) AS m FROM attempts WHERE turn_id = ?').get(turnId) as { m: number | null };
    this.dbInsertAttempt(attemptId, turnId, (row.m ?? 0) + 1, inputRevision);
    return attemptId;
  }

  private dbInsertAttempt(attemptId: string, turnId: string, attemptNo: number, inputRevision: number | null): void {
    tx(this.d.db, () => {
      this.d.db
        .prepare("INSERT INTO attempts(id, turn_id, attempt_no, input_revision, state) VALUES (?,?,?,?,'pending')")
        .run(attemptId, turnId, attemptNo, inputRevision);
    });
  }

  private async runTurn(turnId: string): Promise<void> {
    const d = this.d;
    const turn = d.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as
      | {
          id: string;
          conversation_id: string;
          state: string;
          input_message_id: string | null;
          generation: number;
        }
      | undefined;
    if (!turn) return;
    const attempt = d.db.prepare("SELECT * FROM attempts WHERE turn_id = ? AND state = 'pending' ORDER BY attempt_no DESC LIMIT 1").get(turnId) as
      | { id: string; attempt_no: number; input_revision: number | null; state: string }
      | undefined;
    if (!attempt) return;

    // 路由待决 gate：待决期间不继续模型生成（10.3）
    const pending = d.routing.pendingForTurn(turnId);
    if (pending && pending.attempt_id !== attempt.id) {
      // 旧 attempt 的待决票据存在而这是新 attempt → 已被决策流程处理；继续
    } else if (pending && pending.attempt_id === attempt.id) {
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, 'route_pending: 等待用户决定（编辑/同意/取消）');
      return;
    }

    // —— 每轮实际执行前刷新 Time Context（01 §8）——
    const inputMessage = turn.input_message_id ? d.messages.getMessage(turn.input_message_id) : null;
    const timeCtx = buildTimeContext(d.db, {
      conversationId: turn.conversation_id,
      config: d.config,
      eventOccurredAt: inputMessage?.revision.occurred_at ?? null,
    });
    d.db.prepare('UPDATE turns SET time_context_json = ?, started_at = COALESCE(started_at, ?) WHERE id = ?').run(
      JSON.stringify(timeCtx),
      new Date().toISOString(),
      turnId,
    );

    // —— 运行时 gate：身份/装配/runner（不满足 → attempt blocked，消息已保存，前端可看时间线）——
    const gate = d.identity.evaluateGate();
    const identityText = gate.state === 'READY' && gate.manifest ? d.identity.readApprovedIdentityText(gate.manifest) : null;
    const built = buildSdkOptions({ config: d.config, gate, identityText });
    if (d.runnerSelection.status === 'blocked') {
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, `runtime_not_ready: ${d.runnerSelection.reasons.join('; ')}`);
      return;
    }
    if (built.status === 'blocked') {
      this.blockAttempt(attempt.id, turnId, turn.conversation_id, `identity_not_ready: ${built.reasons.join('; ')}`);
      return;
    }

    // —— 窗口：无活动窗则尝试开窗；身份不通过时窗口 BLOCKED，attempt 同因阻断 ——
    let window = d.windows.activeWindow(turn.conversation_id);
    if (!window) {
      const created = d.windows.createWindow({ conversationId: turn.conversation_id, gate });
      window = d.windows.activeWindow(turn.conversation_id);
      if (!window) {
        this.blockAttempt(attempt.id, turnId, turn.conversation_id, `no_active_window: ${created.blockedReason ?? '开窗失败'}`);
        return;
      }
    }

    // —— fence + attempt 置 running ——
    const generation = turn.generation + 1;
    tx(d.db, () => {
      d.db.prepare('UPDATE turns SET generation = ?, state = ? WHERE id = ?').run(generation, 'running', turnId);
      d.db.prepare("UPDATE attempts SET state = 'running', window_id = ?, started_at = ? WHERE id = ?").run(window.id, new Date().toISOString(), attempt.id);
    });
    d.events.publish('turn.status', {
      conversationId: turn.conversation_id,
      turnId,
      attemptId: attempt.id,
      entityRef: attempt.id,
      payload: { state: 'running', attempt_no: attempt.attempt_no, generation },
    });

    const runToken: ActiveRun = { token: { cancelled: false }, controller: new AbortController(), generation };
    this.active.set(turnId, runToken);

    // 有效输入投影：attempt.input_revision 指定修订（路由编辑后新 revision），否则当前修订（4.2）
    const effective = (() => {
      if (!inputMessage) return { content: '', revision: 1, hash: '' };
      if (attempt.input_revision && attempt.input_revision !== inputMessage.current_revision) {
        const row = d.db
          .prepare('SELECT revision, content, content_hash FROM message_revisions WHERE message_id = ? AND revision = ?')
          .get(inputMessage.id, attempt.input_revision) as { revision: number; content: string; content_hash: string } | undefined;
        if (row) return row;
      }
      return { content: inputMessage.revision.content, revision: inputMessage.current_revision, hash: inputMessage.revision.content_hash };
    })();

    // 每轮时间上下文 + 有效输入：宿主构造、带来源，不伪装成用户发言（6.5）
    const prompt = [
      `[estomago time-context v1]（宿主注入的程序事实，不是用户发言）`,
      JSON.stringify(timeCtx),
      ``,
      `[estomago effective-input] message_id=${inputMessage?.id ?? 'none'} revision=${effective.revision}`,
      effective.content,
    ].join('\n');
    const inputHash = sha256Hex(effective.content);

    const segmenter = new TextSegmenter();
    const publishSegments = (segs: string[]): void => {
      for (const seg of segs) {
        if (runToken.token.cancelled) return; // fence：被打断的代不再发布尾部
        const msg = d.messages.publishAssistantMessage({
          conversationId: turn.conversation_id,
          turnId,
          content: seg,
        });
        d.events.publish('message.published', {
          conversationId: turn.conversation_id,
          turnId,
          entityRef: msg.id,
          entityRevision: msg.sequence,
          payload: { message: msg },
        });
      }
    };

    const runner = d.runnerSelection.runner;
    let sawReasoningBlock = false;
    const result = await runner.run({
      prompt,
      options: built.assembled,
      signal: runToken.controller.signal,
      onEvent: (ev) => {
        if (runToken.token.cancelled) return; // generation fence：迟到事件丢弃
        switch (ev.kind) {
          case 'content_block_start':
            if (ev.block_type === 'thinking') {
              sawReasoningBlock = true;
              d.reasoning.startBlock({
                conversationId: turn.conversation_id,
                turnId,
                attemptId: attempt.id,
                sdkMessageId: ev.sdk_message_id,
                blockIndex: ev.block_index,
                origin: 'stream',
                visibility: 'summary',
                generation,
              });
            } else if (ev.block_type === 'redacted_thinking') {
              sawReasoningBlock = true;
              d.reasoning.markRedactedOrOmitted({
                conversationId: turn.conversation_id,
                turnId,
                attemptId: attempt.id,
                sdkMessageId: ev.sdk_message_id,
                blockIndex: ev.block_index,
                visibility: 'redacted',
                generation,
              });
            }
            break;
          case 'thinking_delta':
            d.reasoning.appendDelta({
              conversationId: turn.conversation_id,
              turnId,
              attemptId: attempt.id,
              sdkMessageId: ev.sdk_message_id,
              blockIndex: ev.block_index,
              text: ev.text,
              generation,
            });
            break;
          case 'text_delta':
            publishSegments(segmenter.push(ev.text));
            break;
          case 'content_block_stop':
            // 关闭内容块；不是工具动作成功证明（05 §5.1）
            d.reasoning.markStreamBlockComplete({
              attemptId: attempt.id,
              sdkMessageId: ev.sdk_message_id,
              blockIndex: ev.block_index,
              generation,
            });
            break;
          case 'complete_message':
            d.reasoning.reconcileCompleteMessage({
              conversationId: turn.conversation_id,
              turnId,
              attemptId: attempt.id,
              sdkMessageId: ev.sdk_message_id,
              blocks: ev.blocks,
              generation,
            });
            break;
          case 'tool_input_delta':
            d.events.publish('tool.status', {
              conversationId: turn.conversation_id,
              turnId,
              attemptId: attempt.id,
              entityRef: `${ev.sdk_message_id}:${ev.block_index}`,
              payload: { phase: 'input_streaming', tool: ev.tool_name ?? null },
            });
            break;
          case 'usage':
            d.usage.record({
              turnId,
              attemptId: attempt.id,
              scope: ev.scope,
              usage: ev.usage,
              source: ev.source,
              completeness: ev.completeness,
            });
            d.events.publish('usage.updated', {
              conversationId: turn.conversation_id,
              turnId,
              attemptId: attempt.id,
              payload: { scope: ev.scope, usage: ev.usage },
            });
            break;
          case 'turn_end':
            if (ev.outcome === 'error' && ev.error_classified === 'route_signal') {
              // 可识别路由信号 → 暂停并出票据；宿主不替用户同意（10.2）
              d.routing.createPending({
                conversationId: turn.conversation_id,
                turnId,
                attemptId: attempt.id,
                inputHash,
                targetModel: null, // 目标模型未知就明确未知
                evidence: ev.error_message ?? 'route_signal',
              });
            }
            break;
          default:
            break;
        }
      },
    });

    this.active.delete(turnId);
    const now = new Date().toISOString();

    if (runToken.token.cancelled || result.outcome === 'interrupted') {
      segmenter.drop(); // 未发布缓冲丢弃；已发布气泡保留（11.2/6.3）
      d.reasoning.markAttemptInterrupted({ attemptId: attempt.id, generation });
      if (!sawReasoningBlock) d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
      tx(d.db, () => {
        d.db.prepare("UPDATE attempts SET state = 'interrupted', completed_at = ? WHERE id = ?").run(now, attempt.id);
        d.db.prepare("UPDATE turns SET state = 'interrupted', completed_at = ? WHERE id = ?").run(now, turnId);
      });
      d.events.publish('turn.interrupted', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, payload: { generation } });
      return;
    }

    if (result.outcome === 'error') {
      segmenter.drop();
      const pending2 = d.routing.pendingForTurn(turnId);
      const state = pending2 && pending2.attempt_id === attempt.id ? 'route_pending' : 'failed';
      tx(d.db, () => {
        d.db.prepare('UPDATE attempts SET state = ?, completed_at = ? WHERE id = ?').run(state, now, attempt.id);
        d.db.prepare('UPDATE turns SET state = ?, completed_at = ? WHERE id = ?').run(state, now, turnId);
      });
      if (state === 'failed') {
        this.blockAttemptFinal(attempt.id, turnId, turn.conversation_id, `runner_error(${result.errorClassified ?? 'unknown'}): ${result.errorMessage ?? ''}`);
      }
      return;
    }

    // 正常完成：flush 尾段 → no_block 检查 → 定稿
    publishSegments(([segmenter.flushTail()].filter(Boolean) as string[]));
    if (!sawReasoningBlock) {
      d.reasoning.markTurnNoBlock({ conversationId: turn.conversation_id, turnId, attemptId: attempt.id, generation });
    }
    tx(d.db, () => {
      d.db.prepare("UPDATE attempts SET state = 'completed', completed_at = ? WHERE id = ?").run(now, attempt.id);
      d.db.prepare("UPDATE turns SET state = 'completed', completed_at = ? WHERE id = ?").run(now, turnId);
    });
    d.events.publish('turn.completed', { conversationId: turn.conversation_id, turnId, attemptId: attempt.id, payload: { generation } });
  }

  private blockAttempt(attemptId: string, turnId: string, conversationId: string, reason: string): void {
    this.blockAttemptFinal(attemptId, turnId, conversationId, reason);
  }

  private blockAttemptFinal(attemptId: string, turnId: string, conversationId: string, reason: string): void {
    const now = new Date().toISOString();
    tx(this.d.db, () => {
      this.d.db.prepare("UPDATE attempts SET state = 'blocked', blocked_reason = ?, completed_at = ? WHERE id = ?").run(reason, now, attemptId);
      this.d.db.prepare("UPDATE turns SET state = 'blocked', completed_at = ? WHERE id = ?").run(now, turnId);
    });
    this.d.events.publish('turn.status', {
      conversationId,
      turnId,
      attemptId,
      entityRef: attemptId,
      payload: { state: 'blocked', reason },
    });
    this.d.logger.warn('attempt_blocked', { turn_id: turnId, attempt_id: attemptId, reason });
  }
}
