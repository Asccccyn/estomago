// Reasoning 服务（05 §4/§5/§6）：官方可读思考摘要的接收、持久化、投影与回放事件。
// 隔离纪律（05 §9）：不进原文 outbox、hold、TTS、默认交接、推送；签名不入库；
// 日志只记 ID/状态/计数。块身份 = (attempt_id, sdk_message_id, block_index)。
import type { Db } from '../db/connection.ts';
import type { EventService } from '../events/service.ts';
import { genId } from '../util/id.ts';
import { reconcile } from './reconciler.ts';
import type { ReasoningBlockDto, ReasoningState, ReasoningVisibility } from '../../../../packages/contracts/src/reasoning.ts';

const HARD_BUFFER_LIMIT = 256 * 1024; // 兜底容量；正式上限待实测（reasoning.maximum_buffer_bytes）

type BlockRow = {
  id: string;
  conversation_id: string;
  turn_id: string;
  attempt_id: string;
  sdk_message_id: string;
  block_index: number;
  origin: 'stream' | 'complete_message' | 'snapshot';
  visibility: string;
  state: string;
  received_text: string;
  final_text: string | null;
  revision: number;
  completeness: string;
  updated_at: string;
};

export class ReasoningService {
  private db: Db;
  private events: EventService;
  constructor(db: Db, events: EventService) {
    this.db = db;
    this.events = events;
  }

  private ensureBlock(o: {
    conversationId: string;
    turnId: string;
    attemptId: string;
    sdkMessageId: string;
    blockIndex: number;
    origin: 'stream' | 'complete_message' | 'snapshot';
    visibility: ReasoningVisibility;
  }): BlockRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO reasoning_blocks(id, conversation_id, turn_id, attempt_id, sdk_message_id, block_index, origin, visibility, state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?, 'streaming', ?, ?)
         ON CONFLICT(attempt_id, sdk_message_id, block_index) DO NOTHING`,
      )
      .run(genId('rbl'), o.conversationId, o.turnId, o.attemptId, o.sdkMessageId, o.blockIndex, o.origin, o.visibility, now, now);
    return this.getBlock(o.attemptId, o.sdkMessageId, o.blockIndex)!;
  }

  private getBlock(attemptId: string, sdkMessageId: string, blockIndex: number): BlockRow | null {
    return (this.db
      .prepare('SELECT * FROM reasoning_blocks WHERE attempt_id = ? AND sdk_message_id = ? AND block_index = ?')
      .get(attemptId, sdkMessageId, blockIndex) as BlockRow | undefined) ?? null;
  }

  startBlock(o: Parameters<ReasoningService['ensureBlock']>[0] & { generation: number }): void {
    const existed = this.getBlock(o.attemptId, o.sdkMessageId, o.blockIndex);
    if (existed) return;
    const block = this.ensureBlock(o);
    this.emit('reasoning.started', block, o.generation, { visibility: block.visibility as ReasoningVisibility });
  }

  appendDelta(o: {
    conversationId: string;
    turnId: string;
    attemptId: string;
    sdkMessageId: string;
    blockIndex: number;
    text: string;
    generation: number;
  }): void {
    const block = this.ensureBlock({
      conversationId: o.conversationId,
      turnId: o.turnId,
      attemptId: o.attemptId,
      sdkMessageId: o.sdkMessageId,
      blockIndex: o.blockIndex,
      origin: 'stream',
      visibility: 'summary',
    });
    let nextText = block.received_text + o.text;
    let state: ReasoningState = 'streaming';
    if (nextText.length > HARD_BUFFER_LIMIT) {
      nextText = nextText.slice(0, HARD_BUFFER_LIMIT);
      state = 'truncated'; // 显式截断，不悄悄丢一半还标完整（05 §5.3）
    }
    const rev = block.revision + 1;
    this.db
      .prepare('UPDATE reasoning_blocks SET received_text = ?, revision = ?, state = ?, updated_at = ? WHERE id = ?')
      .run(nextText, rev, state, new Date().toISOString(), block.id);
    const fresh = this.getBlock(o.attemptId, o.sdkMessageId, o.blockIndex)!;
    this.emit('reasoning.delta', fresh, o.generation, { delta: o.text, state });
  }

  markRedactedOrOmitted(o: {
    conversationId: string;
    turnId: string;
    attemptId: string;
    sdkMessageId: string;
    blockIndex: number;
    visibility: 'redacted' | 'omitted';
    generation: number;
  }): void {
    const block = this.ensureBlock({
      conversationId: o.conversationId,
      turnId: o.turnId,
      attemptId: o.attemptId,
      sdkMessageId: o.sdkMessageId,
      blockIndex: o.blockIndex,
      origin: 'stream',
      visibility: o.visibility,
    });
    this.db
      .prepare('UPDATE reasoning_blocks SET visibility = ?, state = ?, received_text = ?, updated_at = ? WHERE id = ?')
      .run(o.visibility, 'complete', '', new Date().toISOString(), block.id);
    // 不还原、不编写替代文本（T16）
    const fresh = this.getBlock(o.attemptId, o.sdkMessageId, o.blockIndex)!;
    this.emit('reasoning.status_changed', fresh, o.generation, { visibility: o.visibility, state: 'complete' });
  }

  markStreamBlockComplete(o: { attemptId: string; sdkMessageId: string; blockIndex: number; generation: number }): void {
    const block = this.getBlock(o.attemptId, o.sdkMessageId, o.blockIndex);
    if (!block || block.state === 'complete') return;
    this.db
      .prepare("UPDATE reasoning_blocks SET state = 'complete', completeness = 'complete', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), block.id);
    const fresh = this.getBlock(o.attemptId, o.sdkMessageId, o.blockIndex)!;
    this.emit('reasoning.completed', fresh, o.generation, { state: 'complete' });
  }

  // 完整块核对（05 §5.2）：只核对/补齐，不重复追加
  reconcileCompleteMessage(o: {
    conversationId: string;
    turnId: string;
    attemptId: string;
    sdkMessageId: string;
    blocks: Array<{ block_type: string; block_index: number; text: string | null }>;
    generation: number;
  }): void {
    for (const b of o.blocks) {
      if (b.block_type === 'redacted_thinking') {
        this.markRedactedOrOmitted({ ...o, blockIndex: b.block_index, visibility: 'redacted', generation: o.generation });
        continue;
      }
      if (b.block_type !== 'thinking') continue; // text/tool 块不属 reasoning
      const finalText = b.text ?? '';
      const existing = this.getBlock(o.attemptId, o.sdkMessageId, b.block_index);
      if (!existing) {
        // 未见流增量的完整块：直接落完整投影（origin=complete_message），不算重复追加
        const block = this.ensureBlock({
          conversationId: o.conversationId,
          turnId: o.turnId,
          attemptId: o.attemptId,
          sdkMessageId: o.sdkMessageId,
          blockIndex: b.block_index,
          origin: 'complete_message',
          visibility: finalText === '' ? 'omitted' : 'summary',
        });
        this.db
          .prepare("UPDATE reasoning_blocks SET received_text = ?, final_text = ?, state = 'complete', completeness = 'complete', updated_at = ? WHERE id = ?")
          .run(finalText, finalText, new Date().toISOString(), block.id);
        this.emit('reasoning.completed', this.getBlock(o.attemptId, o.sdkMessageId, b.block_index)!, o.generation, { state: 'complete' });
        continue;
      }
      const outcome = reconcile(existing.received_text, finalText);
      const now = new Date().toISOString();
      if (outcome.action === 'already_complete') {
        this.db
          .prepare("UPDATE reasoning_blocks SET state = 'complete', completeness = 'complete', final_text = ?, updated_at = ? WHERE id = ?")
          .run(finalText, now, existing.id);
      } else if (outcome.action === 'append_tail') {
        const rev = existing.revision + 1;
        this.db
          .prepare("UPDATE reasoning_blocks SET received_text = ?, final_text = ?, state = 'complete', completeness = 'complete', revision = ?, updated_at = ? WHERE id = ?")
          .run(finalText, finalText, rev, now, existing.id);
        this.emit('reasoning.delta', this.getBlock(o.attemptId, o.sdkMessageId, b.block_index)!, o.generation, { delta: outcome.tail });
        this.emit('reasoning.completed', this.getBlock(o.attemptId, o.sdkMessageId, b.block_index)!, o.generation, { state: 'complete' });
      } else {
        // 冲突：不拼接；发 snapshot 更正投影并标 reconciliation
        const rev = existing.revision + 1;
        this.db
          .prepare("UPDATE reasoning_blocks SET final_text = ?, state = 'conflict', completeness = 'reconciliation', revision = ?, updated_at = ? WHERE id = ?")
          .run(finalText, rev, now, existing.id);
        const fresh = this.getBlock(o.attemptId, o.sdkMessageId, b.block_index)!;
        this.emit('reasoning.snapshot', fresh, o.generation, { text: finalText, state: 'conflict' });
      }
    }
  }

  // turn 级 no_block：简单请求没有思考块时如实记录，不编造"无思考"文字（05 §4）
  markTurnNoBlock(o: { conversationId: string; turnId: string; attemptId: string; generation: number }): void {
    const any = this.db.prepare('SELECT 1 FROM reasoning_blocks WHERE attempt_id = ?').get(o.attemptId);
    if (any) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO reasoning_blocks(id, conversation_id, turn_id, attempt_id, sdk_message_id, block_index, origin, visibility, state, completeness, created_at, updated_at)
         VALUES (?,?,?,?,?, -1, 'snapshot', 'no_block', 'complete', 'complete', ?, ?)
         ON CONFLICT(attempt_id, sdk_message_id, block_index) DO NOTHING`,
      )
      .run(genId('rbl'), o.conversationId, o.turnId, o.attemptId, '__turn__', now, now);
  }

  markAttemptInterrupted(o: { attemptId: string; generation: number }): void {
    const rows = this.db
      .prepare("SELECT * FROM reasoning_blocks WHERE attempt_id = ? AND state IN ('streaming')")
      .all(o.attemptId) as BlockRow[];
    for (const b of rows) {
      this.db
        .prepare("UPDATE reasoning_blocks SET state = 'interrupted', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), b.id);
      this.emit('reasoning.status_changed', this.getBlock(o.attemptId, b.sdk_message_id, b.block_index)!, o.generation, { state: 'interrupted' });
    }
  }

  listForTurn(turnId: string, attemptId?: string | null): ReasoningBlockDto[] {
    const rows = attemptId
      ? (this.db.prepare('SELECT * FROM reasoning_blocks WHERE turn_id = ? AND attempt_id = ? ORDER BY created_at, block_index').all(turnId, attemptId) as BlockRow[])
      : (this.db.prepare('SELECT * FROM reasoning_blocks WHERE turn_id = ? ORDER BY created_at, block_index').all(turnId) as BlockRow[]);
    return rows.map(rowToDto);
  }

  private emit(kind: 'reasoning.started' | 'reasoning.delta' | 'reasoning.snapshot' | 'reasoning.completed' | 'reasoning.status_changed', block: BlockRow, generation: number, payload: { delta?: string; text?: string; visibility?: ReasoningVisibility; state?: ReasoningState }): void {
    const body = {
      schema_version: 1,
      kind,
      conversation_id: block.conversation_id,
      turn_id: block.turn_id,
      attempt_id: block.attempt_id,
      block_id: block.id,
      block_revision: block.revision,
      generation,
      payload,
    };
    this.events.publish(kind, {
      conversationId: block.conversation_id,
      turnId: block.turn_id,
      attemptId: block.attempt_id,
      entityRef: block.id,
      entityRevision: block.revision,
      scope: 'private',
      payload: body,
    });
  }
}

function rowToDto(r: BlockRow): ReasoningBlockDto {
  // 展示文本：优先 final_text；redacted/omitted/no_block 恒为空串（签名不入 UI —— 本层根本不存签名）
  const text = r.visibility === 'redacted' || r.visibility === 'omitted' || r.visibility === 'no_block' ? '' : (r.final_text ?? r.received_text);
  return {
    id: r.id,
    turn_id: r.turn_id,
    attempt_id: r.attempt_id,
    sdk_message_id: r.sdk_message_id,
    block_index: r.block_index,
    origin: r.origin,
    visibility: r.visibility as ReasoningVisibility,
    state: r.state as ReasoningState,
    revision: r.revision,
    text,
    completeness: r.completeness,
    updated_at: r.updated_at,
  };
}
