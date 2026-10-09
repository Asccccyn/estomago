// WP3（MANUAL_HANDOFF_JUDGE_SWITCH_V1，她裁定 2026-10-08）：人工历史选集。
// 新窗携带历史的唯一来源=她确认的选集（引用既有消息：message_id+revision+
// content_hash），不复制正文、不产生新 messages/revisions/outbox；前端提交
// 的正文不进模型——服务端从真实修订读取、按 sequence 恢复顺序。
// awaiting(items=NULL，未提交≠空选) 与 confirmed+explicit_empty(items='[]')
// 严格区分（H01）；同一源窗至多一条活跃方案（部分唯一索引兜底）。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId, sha256Hex } from '../util/id.ts';

export type SelectionItem = {
  message_id: string;
  revision: number;
  sequence: number;
  speaker: 'owner' | 'assistant';
  content_hash: string;
  content_chars: number;
};

export type SelectionRow = {
  selection_id: string;
  conversation_id: string;
  source_window_id: string;
  expected_window_revision: number;
  source_cutoff_sequence: number;
  status: 'awaiting' | 'confirmed' | 'consumed' | 'cancelled';
  items: SelectionItem[] | null;
  selection_hash: string | null;
  target_window_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
};

export type GapSegment = { after_seq: number; before_seq: number; skipped: number };

export type SelectionValidationError =
  | { code: 'CONTEXT_SELECTION_STALE'; conflicts: Array<{ message_id: string; expected_revision: number; current_revision: number }> }
  | { code: 'CONTEXT_SELECTION_UNKNOWN_MESSAGE'; message_ids: string[] }
  | { code: 'CONTEXT_SELECTION_FORBIDDEN_KIND'; message_ids: string[] }
  | { code: 'CONTEXT_SELECTION_INCLUDES_PENDING_INPUT'; message_ids: string[] }
  | { code: 'CONTEXT_SELECTION_TOO_LARGE'; estimated_tokens: number; bound_tokens: number; deficit_tokens: number }
  | { code: 'CONTEXT_SELECTION_REVISION_CONFLICT'; detail: string }
  // WP-07（CX-08）：已确认方案不可重复确认/修改——结构化冲突（带既有方案定位）
  | { code: 'CONTEXT_SELECTION_ALREADY_CONFIRMED'; detail: string; selection_id: string; status: string };

export type EstimateContext = { charsPerToken: number; systemChars: number; tailInputChars: number };

type ItemRow = {
  id: string;
  sequence: number;
  speaker: string;
  current_revision: number;
  published_at: string | null;
  kind: string;
  revision: number;
  content_hash: string;
  content_chars: number;
};

export class ManualSelectionService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** 换窗需要选择而无确认方案时：建立/刷新 awaiting（幂等——同源窗已有
   *  活跃 awaiting 则原样返回；confirmed 不被覆盖）。 */
  ensureAwaiting(o: { conversationId: string; sourceWindowId: string; expectedWindowRevision: number; cutoffSequence: number }): SelectionRow {
    const existing = this.activeForWindow(o.conversationId, o.sourceWindowId);
    if (existing && existing.status === 'confirmed') return existing;
    if (existing && existing.status === 'awaiting') {
      // 刷新截止水位/期望修订（同一行，不重建）
      tx(this.db, () => {
        this.db.prepare('UPDATE context_selections SET expected_window_revision = ?, source_cutoff_sequence = ?, updated_at = ? WHERE selection_id = ? AND status = \'awaiting\'')
          .run(o.expectedWindowRevision, o.cutoffSequence, new Date().toISOString(), existing.selection_id);
      });
      return this.get(existing.selection_id)!;
    }
    const id = genId('csel');
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db.prepare(
        `INSERT INTO context_selections(selection_id, conversation_id, source_window_id, expected_window_revision, source_cutoff_sequence, status, items_json, created_at, updated_at)
         VALUES (?,?,?,?,?, 'awaiting', NULL, ?, ?)`,
      ).run(id, o.conversationId, o.sourceWindowId, o.expectedWindowRevision, o.cutoffSequence, now, now);
    });
    return this.get(id)!;
  }

  get(selectionId: string): SelectionRow | null {
    const row = this.db.prepare('SELECT * FROM context_selections WHERE selection_id = ?').get(selectionId) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  activeForWindow(conversationId: string, sourceWindowId: string): SelectionRow | null {
    const row = this.db.prepare(
      "SELECT * FROM context_selections WHERE conversation_id = ? AND source_window_id = ? AND status IN ('awaiting','confirmed') ORDER BY updated_at DESC LIMIT 1",
    ).get(conversationId, sourceWindowId) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  /** 当前会话的已确认方案（换窗消费目标）。 */
  confirmedFor(conversationId: string): SelectionRow | null {
    const row = this.db.prepare(
      "SELECT * FROM context_selections WHERE conversation_id = ? AND status = 'confirmed' ORDER BY updated_at DESC LIMIT 1",
    ).get(conversationId) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  /** 换窗已完成的目标窗选集（新窗装配/轨迹初始化读取）。 */
  forTargetWindow(targetWindowId: string): SelectionRow | null {
    const row = this.db.prepare(
      "SELECT * FROM context_selections WHERE target_window_id = ? AND status = 'consumed' LIMIT 1",
    ).get(targetWindowId) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  awaitingFor(conversationId: string): SelectionRow | null {
    const row = this.db.prepare(
      "SELECT * FROM context_selections WHERE conversation_id = ? AND status = 'awaiting' ORDER BY updated_at DESC LIMIT 1",
    ).get(conversationId) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  /** 校验引用并按 sequence 排序（服务端正本；前端顺序/正文不作依据）。
   *  cutoff 之后的待回答/排队输入不得作为历史带入（H04）。 */
  validateItems(conversationId: string, items: Array<{ message_id: string; revision?: number; content_hash?: string }>, cutoffSequence: number):
    { ok: true; items: SelectionItem[] } | { ok: false; error: SelectionValidationError } {
    const seen = new Set<string>();
    const unknown: string[] = [];
    const forbidden: string[] = [];
    const pendingInput: string[] = [];
    const conflicts: Array<{ message_id: string; expected_revision: number; current_revision: number }> = [];
    const valid: SelectionItem[] = [];
    for (const it of items) {
      if (!it || typeof it.message_id !== 'string' || seen.has(it.message_id)) continue;
      seen.add(it.message_id);
      const row = this.db.prepare(
        `SELECT m.id, m.sequence, m.speaker, m.current_revision, m.published_at, m.kind,
                r.revision, r.content_hash, LENGTH(r.content) AS content_chars
         FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
         WHERE m.id = ? AND m.conversation_id = ?`,
      ).get(it.message_id, conversationId) as ItemRow | undefined;
      if (!row) { unknown.push(it.message_id); continue; }
      // 只允许真实 owner 消息与已正式发布的助手消息；system/tool/草稿不可选
      if (row.speaker === 'owner') {
        if (row.kind !== 'text' && row.kind !== 'multimodal') { forbidden.push(it.message_id); continue; }
      } else if (row.speaker === 'assistant') {
        if (!row.published_at) { forbidden.push(it.message_id); continue; }
      } else { forbidden.push(it.message_id); continue; }
      // 待回答/排队输入不在历史选择面内
      if (row.sequence > cutoffSequence) { pendingInput.push(it.message_id); continue; }
      // 修订一致性：显式给了 revision/hash 必须匹配当前修订（H06 冲突定位）
      const wantRev = typeof it.revision === 'number' ? it.revision : row.current_revision;
      if (wantRev !== row.current_revision || (typeof it.content_hash === 'string' && it.content_hash !== row.content_hash)) {
        conflicts.push({ message_id: it.message_id, expected_revision: wantRev, current_revision: row.current_revision });
        continue;
      }
      valid.push({ message_id: row.id, revision: row.current_revision, sequence: row.sequence, speaker: row.speaker as 'owner' | 'assistant', content_hash: row.content_hash, content_chars: row.content_chars });
    }
    if (unknown.length > 0) return { ok: false, error: { code: 'CONTEXT_SELECTION_UNKNOWN_MESSAGE', message_ids: unknown } };
    if (forbidden.length > 0) return { ok: false, error: { code: 'CONTEXT_SELECTION_FORBIDDEN_KIND', message_ids: forbidden } };
    if (pendingInput.length > 0) return { ok: false, error: { code: 'CONTEXT_SELECTION_INCLUDES_PENDING_INPUT', message_ids: pendingInput } };
    if (conflicts.length > 0) return { ok: false, error: { code: 'CONTEXT_SELECTION_STALE', conflicts } };
    valid.sort((a, b) => a.sequence - b.sequence);
    return { ok: true, items: valid };
  }

  /** 间隙披露：不相邻段如实标注（不假装相邻）。 */
  gapsOf(items: SelectionItem[]): GapSegment[] {
    const gaps: GapSegment[] = [];
    for (let i = 1; i < items.length; i++) {
      const skipped = items[i]!.sequence - items[i - 1]!.sequence - 1;
      if (skipped > 0) gaps.push({ after_seq: items[i - 1]!.sequence, before_seq: items[i]!.sequence, skipped });
    }
    return gaps;
  }

  /** 粗估 token（§6.2：选集+A/B 系统段+待回答输入；未知 tokenizer 标 rough；
   *  预计装下仍由请求级容量终检兜底）。 */
  estimateTokens(items: SelectionItem[], est: EstimateContext): number {
    const selectedChars = items.reduce((s, it) => s + it.content_chars, 0);
    return Math.ceil((selectedChars + est.systemChars + est.tailInputChars) / est.charsPerToken);
  }

  /** preview：只读核验（不写库、不跑模型、不 hold、不换窗）。 */
  preview(o: {
    conversationId: string;
    sourceWindowId: string;
    expectedWindowRevision: number;
    items: Array<{ message_id: string; revision?: number; content_hash?: string }>;
    cutoffSequence: number;
    estimate: EstimateContext;
    capacityBoundTokens: number;
  }): { ok: true; result: Record<string, unknown> } | { ok: false; error: SelectionValidationError } {
    const v = this.validateItems(o.conversationId, o.items, o.cutoffSequence);
    if (!v.ok) return v;
    const est = this.estimateTokens(v.items, o.estimate);
    const over = est > o.capacityBoundTokens;
    return {
      ok: true,
      result: {
        items: v.items.map((it) => ({ message_id: it.message_id, revision: it.revision, sequence: it.sequence, speaker: it.speaker, content_hash: it.content_hash })),
        gaps: this.gapsOf(v.items),
        count: v.items.length,
        estimated_tokens: est,
        estimate_quality: 'rough',
        capacity_bound_tokens: o.capacityBoundTokens,
        fits: !over,
        deficit_tokens: over ? est - o.capacityBoundTokens : 0,
      },
    };
  }

  /** confirm：幂等键 + expected_window_revision CAS；空选必须 explicit_empty
   *  （缺 items、未提交、退出面板都不是空选）。confirmed 后由换窗事务消费。 */
  confirm(o: {
    conversationId: string;
    sourceWindowId: string;
    expectedWindowRevision: number;
    items: Array<{ message_id: string; revision?: number; content_hash?: string }>;
    explicitEmpty: boolean;
    idempotencyKey: string | null;
    cutoffSequence: number;
    estimate: EstimateContext;
    capacityBoundTokens: number;
  }): { ok: true; selection: SelectionRow } | { ok: false; error: SelectionValidationError } {
    if (o.items.length === 0 && !o.explicitEmpty) {
      return { ok: false, error: { code: 'CONTEXT_SELECTION_REVISION_CONFLICT', detail: '空选必须显式确认（explicit_empty=true）；未提交/退出面板不是空选' } };
    }
    // 幂等重放：同键已确认 → 原样返回（H09 重复请求只应用一次）
    if (o.idempotencyKey) {
      const hit = this.db.prepare('SELECT * FROM context_selections WHERE idempotency_key = ?').get(o.idempotencyKey) as RawRow | undefined;
      if (hit && hit.status === 'confirmed') return { ok: true, selection: toRow(hit) };
    }
    const window = this.db.prepare('SELECT revision FROM windows WHERE id = ?').get(o.sourceWindowId) as { revision: number } | undefined;
    if (!window && !o.sourceWindowId.startsWith('csel-src-')) return { ok: false, error: { code: 'CONTEXT_SELECTION_REVISION_CONFLICT', detail: '源窗口不存在' } };
    // 哨兵源（csel-src-*）：无活动窗的存量历史恢复锚——无窗口行可 CAS，
    // expectedWindowRevision 恒 0（ensureAwaiting 建立时的约定）
    const currentRevision = window ? window.revision : 0;
    if (currentRevision !== o.expectedWindowRevision) {
      return { ok: false, error: { code: 'CONTEXT_SELECTION_REVISION_CONFLICT', detail: `窗口修订已前进（期望 ${o.expectedWindowRevision}，当前 ${currentRevision}）；请刷新后重选` } };
    }
    let items: SelectionItem[] = [];
    if (o.items.length > 0) {
      const v = this.validateItems(o.conversationId, o.items, o.cutoffSequence);
      if (!v.ok) return v;
      items = v.items;
      const est = this.estimateTokens(items, o.estimate);
      if (est > o.capacityBoundTokens) {
        // H05：超限拒绝保留选择，不裁原文、不叫摘要代写
        return { ok: false, error: { code: 'CONTEXT_SELECTION_TOO_LARGE', estimated_tokens: est, bound_tokens: o.capacityBoundTokens, deficit_tokens: est - o.capacityBoundTokens } };
      }
    }
    const hash = sha256Hex(items.map((it) => `${it.message_id}@${it.revision}`).join(','));
    const existing = this.activeForWindow(o.conversationId, o.sourceWindowId);
    // WP-07（CX-08）：已 confirmed 的方案不可再次确认/修改——同幂等键
    // 重放已在上方命中返回；到这里仍是 confirmed=另一次提交（不同键/
    // 无键），返回结构化冲突（带既有 selection_id/status），不 UPDATE
    // 重建、不产生新 id 错配（旧链：genId 新 id + UPDATE 旧行 + get(新
    // id)=null → 上游 undefined 崩 500）
    if (existing && existing.status === 'confirmed') {
      return { ok: false, error: { code: 'CONTEXT_SELECTION_ALREADY_CONFIRMED', detail: '已有确认方案待换窗消费；如需改选，先在新窗确认后重新发起', selection_id: existing.selection_id, status: existing.status } };
    }
    const now = new Date().toISOString();
    const id = existing ? existing.selection_id : genId('csel');
    try {
      tx(this.db, () => {
        if (existing && existing.status === 'awaiting') {
          const c = this.db.prepare(
            "UPDATE context_selections SET status='confirmed', expected_window_revision=?, source_cutoff_sequence=?, items_json=?, selection_hash=?, idempotency_key=?, updated_at=? WHERE selection_id=? AND status='awaiting'",
          ).run(o.expectedWindowRevision, o.cutoffSequence, JSON.stringify(items), hash, o.idempotencyKey, now, id);
          if (Number(c.changes) !== 1) throw new Error('confirm_conflict: awaiting 方案已被并发变更');
        } else {
          this.db.prepare(
            `INSERT INTO context_selections(selection_id, conversation_id, source_window_id, expected_window_revision, source_cutoff_sequence, status, items_json, selection_hash, idempotency_key, created_at, updated_at)
             VALUES (?,?,?,?,?, 'confirmed', ?, ?, ?, ?, ?)`,
          ).run(id, o.conversationId, o.sourceWindowId, o.expectedWindowRevision, o.cutoffSequence, JSON.stringify(items), hash, o.idempotencyKey, now, now);
        }
      });
    } catch (err) {
      const msg = String((err as Error).message);
      if (msg.includes('idx_context_selections_idem')) {
        const hit = this.db.prepare('SELECT * FROM context_selections WHERE idempotency_key = ?').get(o.idempotencyKey) as RawRow | undefined;
        if (hit) return { ok: true, selection: toRow(hit) };
      }
      return { ok: false, error: { code: 'CONTEXT_SELECTION_REVISION_CONFLICT', detail: msg.slice(0, 120) } };
    }
    return { ok: true, selection: this.get(id)! };
  }

  /** 换窗切换事务内原子消费（由 WindowManager.rotate 的 switch 事务调用；
   *  CAS：只有仍处 confirmed 的方案可被消费，输家整体回滚）。 */
  consumeInTx(db: Db, selectionId: string, targetWindowId: string): void {
    const c = db.prepare(
      "UPDATE context_selections SET status='consumed', target_window_id=?, updated_at=? WHERE selection_id=? AND status='confirmed'",
    ).run(targetWindowId, new Date().toISOString(), selectionId);
    if (Number(c.changes) !== 1) throw new Error('selection_consume_conflict: 方案已非 confirmed（并发消费/取消）');
  }

  /** 读取已确认/已消费选集的正文（按真实修订，服务端正本）。 */
  loadContents(items: SelectionItem[]): Array<{ message_id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }> {
    const out: Array<{ message_id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string }> = [];
    for (const it of items) {
      const row = this.db.prepare('SELECT content FROM message_revisions WHERE message_id = ? AND revision = ?').get(it.message_id, it.revision) as { content: string } | undefined;
      if (!row) continue; // 修订被清理等极端情况：跳过并已在 manifest 缺席中体现
      out.push({ message_id: it.message_id, revision: it.revision, sequence: it.sequence, role: it.speaker === 'owner' ? 'user' : 'assistant', content: row.content });
    }
    return out.sort((a, b) => a.sequence - b.sequence);
  }
}

type RawRow = {
  selection_id: string;
  conversation_id: string;
  source_window_id: string;
  expected_window_revision: number;
  source_cutoff_sequence: number;
  status: string;
  items_json: string | null;
  selection_hash: string | null;
  target_window_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
};

function toRow(r: RawRow): SelectionRow {
  return {
    selection_id: r.selection_id,
    conversation_id: r.conversation_id,
    source_window_id: r.source_window_id,
    expected_window_revision: r.expected_window_revision,
    source_cutoff_sequence: r.source_cutoff_sequence,
    status: r.status as SelectionRow['status'],
    items: r.items_json === null ? null : (JSON.parse(r.items_json) as SelectionItem[]),
    selection_hash: r.selection_hash,
    target_window_id: r.target_window_id,
    idempotency_key: r.idempotency_key,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
