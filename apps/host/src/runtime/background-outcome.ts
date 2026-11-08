// 后台回合结果分类与收尾——R4a（2026-11-07）自 supervisor.runBackgroundTurn 迁出，
// 行为逐字保留：终态落库、PURE_ACK/Substantive 判定（按整轮不是最后字符串）、
// 轨迹提交（C08 已发协议保留）、C09/K-13 维护回执、失败/取消/睡眠分类。
import type { Db } from '../db/connection.ts';
import type { OrMessage } from './or-payload.ts';
import type { RunnerRunResult } from './runner.ts';
import { tailBoundaryOf } from './cache-plan.ts';
import type { ManifestEntry } from '../context/review-policy.ts';
import type { SupervisorDeps } from './supervisor.ts';

export type BackgroundOutcomeInput = {
  db: Db;
  trajectory: SupervisorDeps['trajectory'];
  activity: SupervisorDeps['activity'];
  kind: 'autonomous' | 'keepwarm';
  runId: string;
  conversationId: string;
  windowId: string;
  turnId: string;
  attemptId: string;
  baseManifest: ManifestEntry[];
  capturedActivityRevision: number | null;
  toolCallsObserved: number;
  isCancelRequested: () => boolean;
  loop: {
    result: RunnerRunResult;
    finalMessages: OrMessage[] | null;
    lastSentMessages: OrMessage[] | null;
    toolSeen: ManifestEntry[];
    pendingToolSeen: ManifestEntry[];
  };
};

export function classifyBackgroundOutcome(input: BackgroundOutcomeInput): { outcome: 'completed' | 'noop' | 'failed' | 'unknown'; result_code?: string } {
  const { db, loop, kind, runId } = input;
  const sleepPaused = loop.result.errorCode?.startsWith('KEEPWARM_SLEEP_') === true;
  const finishedState = loop.result.outcome === 'completed' || sleepPaused ? 'completed' : 'failed';
  db.prepare('UPDATE turns SET state = ?, completed_at = ? WHERE id = ?').run(finishedState, new Date().toISOString(), input.turnId);
  db.prepare('UPDATE attempts SET state=?,blocked_reason=?,completed_at=? WHERE id=?').run(finishedState, loop.result.errorCode, new Date().toISOString(), input.attemptId);

  // —— 结果分类（06 §2：一条执行路径、两种提交结果；判定按整轮不是最后字符串）——
  const finalText = loop.finalMessages !== null && loop.finalMessages.length > 0
    ? (() => { const last = loop.finalMessages![loop.finalMessages!.length - 1]!; const c = last.content; return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => (b as { type?: string }).type === 'text').map((b) => (b as { text?: string }).text ?? '').join('') : ''; })()
    : '';
  const publishedCount = Number((db.prepare("SELECT COUNT(*) n FROM messages WHERE turn_id = ? AND speaker = 'assistant'").get(input.turnId) as { n: number }).n);
  const pureAck = loop.result.outcome === 'completed' && !loop.result.errorCode && input.toolCallsObserved === 0 && publishedCount === 0 && finalText.trim() === '1';
  db.prepare('UPDATE background_runs SET tool_calls_observed = ?, published_message_count = ?, retention = ?, updated_at = ? WHERE id = ?')
    .run(input.toolCallsObserved, publishedCount, pureAck ? 'ephemeral_ack' : 'retained', new Date().toISOString(), runId);

  if (!pureAck) {
    // SUBSTANTIVE（06 §2）：提交最初事件与整个必要协议链——工具调用/结果/续轮/最终文本；
    // 正式发言已在工具执行时入消息库与归档 outbox；已见清单并入轨迹 manifest（B11/C-09）。
    if (input.trajectory && loop.finalMessages !== null) {
      const baseManifest = input.baseManifest;
      const publishedEntries = (db.prepare("SELECT id, sequence FROM messages WHERE turn_id = ? AND speaker = 'assistant' ORDER BY sequence").all(input.turnId) as Array<{ id: string; sequence: number }>)
        .map((m) => ({ id: m.id, revision: 1, seq: m.sequence, origin: 'dialogue' as const, visible: true }));
      input.trajectory.replace(input.windowId, loop.finalMessages, tailBoundaryOf(loop.lastSentMessages ?? loop.finalMessages), [...baseManifest, ...publishedEntries, ...loop.toolSeen, ...loop.pendingToolSeen.map(entry => ({ ...entry, visible: false, pending_dispatch: true as const }))]);
      db.prepare('UPDATE background_runs SET trajectory_committed_at = ?, updated_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), runId);
    }
    // C09（四仓审计 20261106）：工具心跳（substantive）完成同样记维护回执——后继维护
    // 安排与缓存证据独立成立（不记回执→occurrence key 永不变→后继永久停摆，审计实测
    // 工具心跳后 next_run/model 增量=0）。缓存命中事实仍以真实 usage 为准（K-13 不冒充）。
    if (kind === 'keepwarm' && loop.result.outcome === 'completed' && input.activity && input.capturedActivityRevision !== null) {
      const evAny = db.prepare(
        `SELECT pr.id AS rid, pr.dispatch_started_at AS started FROM provider_requests pr
         JOIN background_dispatches bd ON bd.provider_request_id = pr.id
         WHERE bd.run_id = ? AND pr.outcome = 'completed' AND pr.dispatch_started_at IS NOT NULL
         ORDER BY pr.dispatch_started_at DESC LIMIT 1`,
      ).get(runId) as { rid: string; started: string } | undefined;
      if (evAny) {
        input.activity.noteMaintenanceReceipt({ conversationId: input.conversationId, capturedActivityRevision: input.capturedActivityRevision, requestId: evAny.rid, windowId: input.windowId, dispatchStartedAtIso: evAny.started });
      }
    }
    if (loop.result.outcome !== 'completed') {
      // RB02（复审 20261106）：background_complete 的合法停发已在 runner 控制层归一为
      // completed（sdk-host-query 与 API complete 门同一出口）——此处只剩真实失败/未知。
      if (loop.result.errorCode === 'TOOL_EXECUTION_OUTCOME_UNKNOWN') return { outcome: 'unknown', result_code: loop.result.errorCode };
      if (input.isCancelRequested()) return { outcome: 'completed', result_code: 'CANCELLED_MID_RUN' };
      if (sleepPaused) return { outcome: 'noop', result_code: loop.result.errorCode! };
      return { outcome: 'failed', result_code: loop.result.errorCode ?? (kind === 'keepwarm' ? 'KEEPWARM_FAILED' : 'AUTONOMOUS_FAILED') };
    }

    const runCode = db.prepare('SELECT result_code FROM background_runs WHERE id = ?').get(runId) as { result_code: string | null };
    const completion = runCode?.result_code?.startsWith('complete:') === true ? runCode.result_code.slice('complete:'.length) : null;
    // 非1最终文本默认内部可见（E03）：保存于轨迹与运行详情，不自动推送；发言走既有发送工具。
    return { outcome: completion === 'noop' ? 'noop' : 'completed', result_code: loop.result.errorCode?.startsWith('KEEPWARM_SLEEP_') ? loop.result.errorCode : completion === 'noop' ? 'complete:noop' : 'complete:done' };
  }

  // PURE_ACK（05）：完整成功且整轮恰为"1"——维护回执；不进聊天原文、不推进 L、
  // 清单不加可见条目。C08（四仓审计 20261106）：**已发协议保留**——host 事件与
  // assistant "1" 随轨迹提交（缓存前缀延续），下一普通输入/维护从实发前缀接续，
  // 不再出现首差（旧实现整段丢弃→下一请求 messages[4] 起分叉）。
  if (input.trajectory && loop.finalMessages !== null) {
    input.trajectory.replace(input.windowId, loop.finalMessages, tailBoundaryOf(loop.lastSentMessages ?? loop.finalMessages), input.baseManifest);
    db.prepare('UPDATE background_runs SET trajectory_committed_at = ?, updated_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), runId);
  }
  // A retained tool result from an earlier interrupted run may have entered
  // the model in this pure maintenance request. Promote only that source
  // evidence; the canonical messages and cache boundary remain untouched.
  if (input.trajectory && loop.toolSeen.length > 0) {
    input.trajectory.replaceManifest(input.windowId, [...input.baseManifest, ...loop.toolSeen, ...loop.pendingToolSeen.map(entry => ({ ...entry, visible: false, pending_dispatch: true as const }))]);
  }
  if (kind === 'keepwarm' && input.activity && input.capturedActivityRevision !== null) {
    // 缓存证据以本 run 的模型请求 usage 为准（K-13：无证据=回执可记、缓存 unknown，
    // 不写"保温成功"，同活动版本不重试）
    const evRow = db.prepare(
      `SELECT pr.id AS rid, pr.dispatch_started_at AS started FROM provider_requests pr
       JOIN background_dispatches bd ON bd.provider_request_id = pr.id
       JOIN usage_observations u ON u.request_id = pr.id AND u.completeness = 'complete'
       WHERE bd.run_id = ? AND pr.outcome = 'completed' AND (u.cache_read_input_tokens > 0 OR u.cache_creation_input_tokens > 0)
       ORDER BY pr.dispatch_started_at DESC LIMIT 1`,
    ).get(runId) as { rid: string; started: string } | undefined;
    if (evRow) {
      input.activity.noteMaintenanceReceipt({ conversationId: input.conversationId, capturedActivityRevision: input.capturedActivityRevision, requestId: evRow.rid, windowId: input.windowId, dispatchStartedAtIso: evRow.started });
    }
  }
  return { outcome: 'completed', result_code: kind === 'keepwarm' ? 'ack_only' : 'complete:noop' };
}

