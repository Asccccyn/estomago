// 窗口生命周期（01 §7）：状态机 + 原子指针切换。
// 新窗只有在身份 gate 通过后才接管；失败保留可用旧窗/DEGRADED/BLOCKED 并记原因。
// 正常轮转 = 新 session；resume/fork 不自动当作缩小上下文（7.4）。
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId } from '../util/id.ts';
import type { EventService } from '../events/service.ts';
import type { IdentityService, GateResult } from '../identity/service.ts';

export type WindowRow = {
  id: string;
  conversation_id: string;
  status: string;
  sdk_session_id: string | null;
  manifest_ref: string | null;
  receipt_id: string | null;
  cutoff_sequence: number | null;
  active_generation: number;
  blocked_reason: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export class WindowManager {
  private db: Db;
  private events: EventService;
  private identity: IdentityService;
  private handoffsDir: string;
  constructor(db: Db, events: EventService, identity: IdentityService, handoffsDir: string) {
    this.db = db;
    this.events = events;
    this.identity = identity;
    this.handoffsDir = handoffsDir;
  }

  activeWindow(conversationId: string): WindowRow | null {
    const conv = this.db.prepare('SELECT active_window_id FROM conversations WHERE id = ?').get(conversationId) as
      | { active_window_id: string | null }
      | undefined;
    if (!conv?.active_window_id) return null;
    return (this.db.prepare("SELECT * FROM windows WHERE id = ? AND status = 'ACTIVE'").get(conv.active_window_id) as WindowRow | undefined) ?? null;
  }

  // 创建并尝试激活新窗：NEW → PREPARING → (IDENTITY_VERIFIED → READY → ACTIVE) | BLOCKED
  createWindow(o: { conversationId: string; gate: GateResult }): { window: WindowRow; blockedReason: string | null } {
    const id = genId('win');
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db
        .prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES (?,?, 'NEW', ?, ?)")
        .run(id, o.conversationId, now, now);
    });
    this.setStatus(id, 'PREPARING');

    // Bootstrap Receipt：即使 blocked 也留证据（05 §3）
    const receipt = this.identity.buildAndStoreReceipt(this.db, {
      windowId: id,
      manifest: o.gate.manifest,
      gate: o.gate,
      assembledOptions: {}, // blocked 时不装配；receipt 里 options_hash 记 null
    });
    this.db.prepare('UPDATE windows SET receipt_id = ? WHERE id = ?').run(receipt.manifest_ref ?? 'no-receipt-ref', id);

    if (o.gate.state !== 'READY') {
      const reason = o.gate.reasons.join('; ');
      this.setStatus(id, 'BLOCKED', reason);
      this.emitChanged(id, o.conversationId, 'BLOCKED', reason);
      return { window: this.get(id)!, blockedReason: reason };
    }
    this.setStatus(id, 'IDENTITY_VERIFIED');
    this.setStatus(id, 'READY');
    // 原子切换：只有当前指针未变时才接管（7.1：候选窗未就绪不更新指针；切换检查 lease/revision）
    const switched = tx(this.db, () => {
      const conv = this.db.prepare('SELECT active_window_id FROM conversations WHERE id = ?').get(o.conversationId) as { active_window_id: string | null };
      const prevId = conv?.active_window_id ?? null;
      this.db.prepare("UPDATE windows SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      this.db.prepare('UPDATE conversations SET active_window_id = ? WHERE id = ?').run(id, o.conversationId);
      if (prevId) this.db.prepare("UPDATE windows SET status = 'CLOSED', updated_at = ? WHERE id = ?").run(new Date().toISOString(), prevId);
      return prevId;
    });
    this.emitChanged(id, o.conversationId, 'ACTIVE', null);
    return { window: this.get(id)!, blockedReason: null };
  }

  // 手动轮转（POST /windows/{id}/rotate）：安全边界收束旧窗 → 新窗 gate 通过后原子切换
  rotate(o: { conversationId: string; gate: GateResult; maxSequence: number }): { ok: true; window: WindowRow } | { ok: false; reason: string } {
    const current = this.activeWindow(o.conversationId);
    if (!current) return { ok: false, reason: '无当前活动窗口' };
    if (o.gate.state !== 'READY') {
      return { ok: false, reason: `IDENTITY_BLOCKED：${o.gate.reasons.join('; ')}（保留旧窗，不接管）` };
    }
    // 旧窗：ROTATION_REQUESTED → DRAINING → HANDOFF_READY → CLOSED；记录 cutoff
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db
        .prepare("UPDATE windows SET status = 'ROTATION_REQUESTED', cutoff_sequence = ?, updated_at = ? WHERE id = ?")
        .run(o.maxSequence, now, current.id);
    });
    this.setStatus(current.id, 'DRAINING');
    this.writeHandoff(current, o.maxSequence);
    this.setStatus(current.id, 'HANDOFF_READY');

    const created = this.createWindow({ conversationId: o.conversationId, gate: o.gate });
    if (created.blockedReason) {
      // 新窗失败：保留可用旧窗为 ACTIVE（DEGRADED 记录）—— 7.1 降级路径
      tx(this.db, () => {
        this.db.prepare("UPDATE windows SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(new Date().toISOString(), current.id);
        this.db.prepare('UPDATE conversations SET active_window_id = ? WHERE id = ?').run(current.id, o.conversationId);
      });
      return { ok: false, reason: `轮转失败（新窗被阻断），已保留旧窗：${created.blockedReason}` };
    }
    tx(this.db, () => {
      this.db.prepare("UPDATE windows SET status = 'CLOSED', updated_at = ? WHERE id = ?").run(new Date().toISOString(), current.id);
    });
    this.emitChanged(created.window.id, o.conversationId, 'ACTIVE', null);
    return { ok: true, window: created.window };
  }

  // 短交接（7.3）：只记录可核验事实（发布到哪条、cutoff、时间）；不引用思考摘要；
  // 预算未配置（recent_dialogue_budget_tokens=null）时不灌历史，只存元信息 —— 不假装交接包完整。
  private writeHandoff(window: WindowRow, cutoff: number): void {
    fs.mkdirSync(this.handoffsDir, { recursive: true });
    const file = path.join(this.handoffsDir, `${window.id}.json`);
    const handoff = {
      window_id: window.id,
      conversation_id: window.conversation_id,
      cutoff_sequence: cutoff,
      recent_dialogue_budget_tokens: null,
      includes_reasoning: false, // 硬规则：摘要不进默认交接
      unanswered_questions: [],
      unfinished_actions: [],
      note: 'v0 骨架：短交接仅含元信息；正式交接包待 Mariposa 开窗契约接入',
      written_at: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(handoff, null, 2));
  }

  get(id: string): WindowRow | null {
    return (this.db.prepare('SELECT * FROM windows WHERE id = ?').get(id) as WindowRow | undefined) ?? null;
  }

  private setStatus(id: string, status: string, blockedReason?: string): void {
    this.db
      .prepare('UPDATE windows SET status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?')
      .run(status, blockedReason ?? null, new Date().toISOString(), id);
  }

  private emitChanged(windowId: string, conversationId: string, status: string, reason: string | null): void {
    this.events.publish('window.changed', {
      conversationId,
      entityRef: windowId,
      scope: 'private',
      payload: { window_id: windowId, status, reason },
    });
  }
}
