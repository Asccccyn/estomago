// Reasoning 服务 v0.2.2（AUD-13/14 + normalizer 新契约）：
//  - 投影更新与回放事件在同一事务提交（persistInTx），提交后 dispatch（AUD-14）。
//  - truncated 单向：普通 block_stop 不改 truncated；只有真实完整内容经核对才定稿（AUD-13）。
//  - 统一存储限额：增量与完整块同限；事件里只记录实际持久文本（AUD-13）。
//  - unmatched 完整块：独立身份（负 seq 索引），绝不覆盖流式块（AUD-11）。
//  - 签名不入库；redacted/omitted 不还原不代写。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId } from '../util/id.ts';
import type { EventService } from '../events/service.ts';
import { reconcile } from './reconciler.ts';
import type { ReasoningBlockDto, ReasoningState, ReasoningVisibility } from '../../../../packages/contracts/src/reasoning.ts';
import type { MatchedCompleteBlock, UnmatchedCompleteBlock } from '../../../../packages/contracts/src/sdk-events.ts';

// 统一硬限额（增量+完整块同限；正式上限待实测配置化）
const STORAGE_LIMIT = 256 * 1024;

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
    conversationId: string; turnId: string; attemptId: string; sdkMessageId: string; blockIndex: number;
    origin: 'stream' | 'complete_message' | 'snapshot'; visibility: ReasoningVisibility;
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

  startBlock(o: { conversationId: string; turnId: string; attemptId: string; sdkMessageId: string; blockIndex: number; generation: number }): void {
    if (this.getBlock(o.attemptId, o.sdkMessageId, o.blockIndex)) return;
    const block = this.ensureBlock({ ...o, origin: 'stream', visibility: 'summary' });
    this.emitAtomic(block, o.generation, 'reasoning.started', { visibility: block.visibility as ReasoningVisibility }, () => {});
  }

  appendDelta(o: { conversationId: string; turnId: string; attemptId: string; sdkMessageId: string; blockIndex: number; text: string; generation: number }): void {
    const emit = { delta: '' as string, state: '' as ReasoningState };
    tx(this.db, () => {
      const block = this.ensureBlock({ conversationId: o.conversationId, turnId: o.turnId, attemptId: o.attemptId, sdkMessageId: o.sdkMessageId, blockIndex: o.blockIndex, origin: 'stream', visibility: 'summary' });
      let nextText = block.received_text + o.text;
      let state: ReasoningState = block.state === 'truncated' ? 'truncated' : 'streaming';
      let limited = o.text;
      if (nextText.length > STORAGE_LIMIT) {
        nextText = nextText.slice(0, STORAGE_LIMIT);
        limited = nextText.slice(block.received_text.length); // 事件只记录实际持久部分（AUD-13）
        state = 'truncated';
      }
      if (limited.length === 0) return; // 已达限额：不再追加也不发事件（状态已 truncated）
      const rev = block.revision + 1;
      this.db
        .prepare('UPDATE reasoning_blocks SET received_text = ?, revision = ?, state = ?, updated_at = ? WHERE id = ?')
        .run(nextText, rev, state, new Date().toISOString(), block.id);
      emit.delta = limited;
      emit.state = state;
      const fresh = this.getBlock(o.attemptId, o.sdkMessageId, o.blockIndex)!;
      this.events.persistInTx('reasoning.delta', {
        conversationId: fresh.conversation_id, turnId: fresh.turn_id, attemptId: fresh.attempt_id,
        entityRef: fresh.id, entityRevision: fresh.revision, scope: 'private',
        payload: this.envelopeBody(fresh, o.generation, 'reasoning.delta', { delta: limited, state }),
      });
    });
    // 提交后统一补发（若 tx 内持久了事件则这里 dispatch 对应行）
    this.dispatchPending(o.attemptId, emit.delta, 'reasoning.delta');
  }

  markRedactedOrOmitted(o: { conversationId: string; turnId: string; attemptId: string; sdkMessageId: string; blockIndex: number; visibility: 'redacted' | 'omitted'; generation: number }): void {
    tx(this.db, () => {
      const block = this.ensureBlock({ conversationId: o.conversationId, turnId: o.turnId, attemptId: o.attemptId, sdkMessageId: o.sdkMessageId, blockIndex: o.blockIndex, origin: 'stream', visibility: o.visibility });
      this.db
        .prepare('UPDATE reasoning_blocks SET visibility = ?, state = ?, received_text = ?, updated_at = ? WHERE id = ?')
        .run(o.visibility, 'complete', '', new Date().toISOString(), block.id);
      const fresh = this.getBlock(o.attemptId, o.sdkMessageId, o.blockIndex)!;
      this.events.persistInTx('reasoning.status_changed', {
        conversationId: fresh.conversation_id, turnId: fresh.turn_id, attemptId: fresh.attempt_id,
        entityRef: fresh.id, entityRevision: fresh.revision, scope: 'private',
        payload: this.envelopeBody(fresh, o.generation, 'reasoning.status_changed', { visibility: o.visibility, state: 'complete' }),
      });
    });
    this.dispatchPending(o.attemptId, '', 'reasoning.status_changed');
  }

  // AUD-13：block_stop 只把 streaming 收尾为 complete；truncated/conflict 不动
  markStreamBlockComplete(o: { attemptId: string; sdkMessageId: string; blockIndex: number; generation: number }): void {
    const block = this.getBlock(o.attemptId, o.sdkMessageId, o.blockIndex);
    if (!block || block.state !== 'streaming') return;
    tx(this.db, () => {
      this.db
        .prepare("UPDATE reasoning_blocks SET state = 'complete', completeness = 'complete', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), block.id);
      const fresh = this.getBlock(o.attemptId, o.sdkMessageId, o.blockIndex)!;
      this.events.persistInTx('reasoning.completed', {
        conversationId: fresh.conversation_id, turnId: fresh.turn_id, attemptId: fresh.attempt_id,
        entityRef: fresh.id, entityRevision: fresh.revision, scope: 'private',
        payload: this.envelopeBody(fresh, o.generation, 'reasoning.completed', { state: 'complete' }),
      });
    });
    this.dispatchPending(o.attemptId, '', 'reasoning.completed');
  }

  // 完整块核对（AUD-11 契约）：matched 按索引核对；unmatched 走独立身份；统一限额
  reconcileCompleteMessage(o: {
    conversationId: string; turnId: string; attemptId: string; sdkMessageId: string;
    matched: MatchedCompleteBlock[]; unmatched: UnmatchedCompleteBlock[]; generation: number;
  }): void {
    for (const b of o.matched) {
      if (b.block_type === 'redacted_thinking') {
        this.markRedactedOrOmitted({ ...o, blockIndex: b.block_index, visibility: 'redacted', generation: o.generation });
        continue;
      }
      if (b.block_type !== 'thinking') continue; // text/tool 的完整块核对属正文/工具域
      this.reconcileThinkingBlock(o, b.block_index, b.text ?? '');
    }
    for (const u of o.unmatched) {
      if (u.block_type !== 'thinking' && u.block_type !== 'redacted_thinking') continue;
      // unmatched：独立身份（负索引），绝不覆盖任何流式块
      const idx = -1000 + u.seq; // seq 为负计数器
      const visibility: ReasoningVisibility = u.block_type === 'redacted_thinking' ? 'redacted' : u.text === '' ? 'omitted' : 'summary';
      tx(this.db, () => {
        const block = this.ensureBlock({ conversationId: o.conversationId, turnId: o.turnId, attemptId: o.attemptId, sdkMessageId: o.sdkMessageId, blockIndex: idx, origin: 'complete_message', visibility });
        const capped = (u.text ?? '').slice(0, STORAGE_LIMIT);
        this.db
          .prepare("UPDATE reasoning_blocks SET received_text = ?, final_text = ?, state = 'complete', completeness = ?, updated_at = ? WHERE id = ?")
          .run(capped, capped, capped.length < (u.text ?? '').length ? 'storage_limited' : 'unmatched_complete', new Date().toISOString(), block.id);
        const fresh = this.getBlock(o.attemptId, o.sdkMessageId, idx)!;
        this.events.persistInTx('reasoning.completed', {
          conversationId: fresh.conversation_id, turnId: fresh.turn_id, attemptId: fresh.attempt_id,
          entityRef: fresh.id, entityRevision: fresh.revision, scope: 'private',
          payload: this.envelopeBody(fresh, o.generation, 'reasoning.completed', { state: 'complete', origin: 'unmatched' }),
        });
      });
      this.dispatchPending(o.attemptId, '', 'reasoning.completed');
    }
  }

  private reconcileThinkingBlock(o: Parameters<ReasoningService['reconcileCompleteMessage']>[0], blockIndex: number, finalTextRaw: string): void {
    const finalText = finalTextRaw.slice(0, STORAGE_LIMIT); // 统一限额（AUD-13）
    const limited = finalTextRaw.length > STORAGE_LIMIT;
    const existing = this.getBlock(o.attemptId, o.sdkMessageId, blockIndex);
    if (!existing) {
      tx(this.db, () => {
        const block = this.ensureBlock({ conversationId: o.conversationId, turnId: o.turnId, attemptId: o.attemptId, sdkMessageId: o.sdkMessageId, blockIndex, origin: 'complete_message', visibility: finalText === '' ? 'omitted' : 'summary' });
        this.db
          .prepare("UPDATE reasoning_blocks SET received_text = ?, final_text = ?, state = 'complete', completeness = ?, updated_at = ? WHERE id = ?")
          .run(finalText, finalText, limited ? 'storage_limited' : 'complete', new Date().toISOString(), block.id);
        const fresh = this.getBlock(o.attemptId, o.sdkMessageId, blockIndex)!;
        this.events.persistInTx('reasoning.completed', {
          conversationId: fresh.conversation_id, turnId: fresh.turn_id, attemptId: fresh.attempt_id,
          entityRef: fresh.id, entityRevision: fresh.revision, scope: 'private',
          payload: this.envelopeBody(fresh, o.generation, 'reasoning.completed', { state: 'complete' }),
        });
      });
      this.dispatchPending(o.attemptId, '', 'reasoning.completed');
      return;
    }
    const outcome = reconcile(existing.received_text, finalText);
    tx(this.db, () => {
      const now = new Date().toISOString();
      let rev = existing.revision;
      if (outcome.action === 'already_complete') {
        this.db
          .prepare("UPDATE reasoning_blocks SET state = 'complete', completeness = ?, final_text = ?, updated_at = ? WHERE id = ?")
          .run(limited ? 'storage_limited' : 'complete', finalText, now, existing.id);
      } else if (outcome.action === 'append_tail') {
        rev += 1;
        this.db
          .prepare("UPDATE reasoning_blocks SET received_text = ?, final_text = ?, state = 'complete', completeness = ?, revision = ?, updated_at = ? WHERE id = ?")
          .run(finalText, finalText, limited ? 'storage_limited' : 'complete', rev, now, existing.id);
      } else {
        // 冲突：不拼接；snapshot 更正投影，标 reconciliation（事件文本=实际持久文本）
        rev += 1;
        this.db
          .prepare("UPDATE reasoning_blocks SET final_text = ?, state = 'conflict', completeness = 'reconciliation', revision = ?, updated_at = ? WHERE id = ?")
          .run(finalText, rev, now, existing.id);
      }
      // 单一收尾事件：append_tail→delta；conflict→snapshot；already_complete→completed
      const fresh = this.getBlock(o.attemptId, o.sdkMessageId, blockIndex)!;
      const kind = outcome.action === 'conflict' ? 'reasoning.snapshot' : outcome.action === 'append_tail' ? 'reasoning.delta' : 'reasoning.completed';
      const evPayload =
        outcome.action === 'conflict'
          ? { text: finalText, state: 'conflict' }
          : outcome.action === 'append_tail'
            ? { delta: outcome.tail, state: 'complete' }
            : { state: 'complete' };
      this.events.persistInTx(kind, {
        conversationId: fresh.conversation_id, turnId: fresh.turn_id, attemptId: fresh.attempt_id,
        entityRef: fresh.id, entityRevision: fresh.revision, scope: 'private',
        payload: this.envelopeBody(fresh, o.generation, kind, evPayload),
      });
      if (outcome.action === 'append_tail') {
        this.events.persistInTx('reasoning.completed', {
          conversationId: fresh.conversation_id, turnId: fresh.turn_id, attemptId: fresh.attempt_id,
          entityRef: fresh.id, entityRevision: fresh.revision, scope: 'private',
          payload: this.envelopeBody(fresh, o.generation, 'reasoning.completed', { state: 'complete' }),
        });
      }
    });
    this.dispatchPending(o.attemptId, '', 'reasoning.completed');
  }

  // turn 级 no_block（05 §4）：无思考块时如实记录
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

  // AUD-10：终态收尾——streaming 块全部落确定状态（interrupted/failed）
  markAttemptFinal(o: { attemptId: string; final: 'interrupted' | 'failed'; generation: number }): void {
    const rows = this.db.prepare("SELECT * FROM reasoning_blocks WHERE attempt_id = ? AND state = 'streaming'").all(o.attemptId) as BlockRow[];
    for (const b of rows) {
      tx(this.db, () => {
        this.db
          .prepare('UPDATE reasoning_blocks SET state = ?, updated_at = ? WHERE id = ?')
          .run(o.final, new Date().toISOString(), b.id);
        const fresh = this.getBlock(o.attemptId, b.sdk_message_id, b.block_index)!;
        this.events.persistInTx('reasoning.status_changed', {
          conversationId: fresh.conversation_id, turnId: fresh.turn_id, attemptId: fresh.attempt_id,
          entityRef: fresh.id, entityRevision: fresh.revision, scope: 'private',
          payload: this.envelopeBody(fresh, o.generation, 'reasoning.status_changed', { state: o.final }),
        });
      });
      this.dispatchPending(o.attemptId, '', 'reasoning.status_changed');
    }
  }

  listForTurn(turnId: string, attemptId?: string | null): ReasoningBlockDto[] {
    const rows = attemptId
      ? (this.db.prepare('SELECT * FROM reasoning_blocks WHERE turn_id = ? AND attempt_id = ? ORDER BY created_at, block_index').all(turnId, attemptId) as BlockRow[])
      : (this.db.prepare('SELECT * FROM reasoning_blocks WHERE turn_id = ? ORDER BY created_at, block_index').all(turnId) as BlockRow[]);
    return rows.map(rowToDto);
  }

  private envelopeBody(block: BlockRow, generation: number, kind: string, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      schema_version: 1, kind,
      conversation_id: block.conversation_id, turn_id: block.turn_id, attempt_id: block.attempt_id,
      block_id: block.id, block_revision: block.revision, generation,
      payload,
    };
  }

  // 原子路径统一补发：读取该 attempt 最新事件行并 dispatch（persistInTx 已在事务内落库）
  private dispatchPending(attemptId: string, _delta: string, _kind: string): void {
    const rows = this.db
      .prepare('SELECT * FROM runtime_stream_events WHERE attempt_id = ? ORDER BY sequence')
      .all(attemptId) as Array<import('../events/service.ts').StreamEventRow>;
    // 只 dispatch 尚未分发的（用序列游标内存记录）
    if (!this.dispatched) this.dispatched = new Map();
    const last = this.dispatched.get(attemptId) ?? 0;
    for (const r of rows) {
      if (r.sequence <= last) continue;
      this.events.dispatchRow(r);
      this.dispatched.set(attemptId, r.sequence);
    }
  }
  private dispatched: Map<string, number> | null = null;

  // startBlock 用的原子 emit（投影+事件同事务）
  private emitAtomic(block: BlockRow, generation: number, kind: string, payload: Record<string, unknown>, mutate: () => void): void {
    tx(this.db, () => {
      mutate();
      const fresh = this.getBlock(block.attempt_id, block.sdk_message_id, block.block_index)!;
      this.events.persistInTx(kind, {
        conversationId: fresh.conversation_id, turnId: fresh.turn_id, attemptId: fresh.attempt_id,
        entityRef: fresh.id, entityRevision: fresh.revision, scope: 'private',
        payload: this.envelopeBody(fresh, generation, kind, payload),
      });
    });
    this.dispatchPending(block.attempt_id, '', kind);
  }
}

function rowToDto(r: BlockRow): ReasoningBlockDto {
  const text = r.visibility === 'redacted' || r.visibility === 'omitted' || r.visibility === 'no_block' ? '' : (r.final_text ?? r.received_text);
  return {
    id: r.id, turn_id: r.turn_id, attempt_id: r.attempt_id, sdk_message_id: r.sdk_message_id,
    block_index: r.block_index, origin: r.origin, visibility: r.visibility as ReasoningVisibility,
    state: r.state as ReasoningState, revision: r.revision, text, completeness: r.completeness, updated_at: r.updated_at,
  };
}
