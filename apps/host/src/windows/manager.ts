// 窗口生命周期 v0.2.2（AUD-20/22 修复版）：prepare → 原子切换。
//  - 准备阶段旧窗保持 ACTIVE；candidate/handoff/receipt 任一失败 → 旧窗不动，绝不出现 active=null。
//  - 切换在一个事务内完成：旧窗 ACTIVE→CLOSED、candidate→ACTIVE、指针 CAS；失败整体回滚。
//  - window.receipt_id 引用 bootstrap_receipts 真实主键（AUD-22）。
//  - sdk_session_id 由 supervisor 在首轮后绑定（AUD-03），新窗创建时为 null（= 新 session）。
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId } from '../util/id.ts';
import type { EventService } from '../events/service.ts';
import { contextFingerprint, type BoundaryConfigInput, type GateResult, type IdentityService } from '../identity/service.ts';

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
  context_fingerprint: string | null;
  created_at: string;
  updated_at: string;
};

export class WindowManager {
  constructor(db: Db, events: EventService, identity: IdentityService, handoffsDir: string, config?: BoundaryConfigInput) {
    this.db = db;
    this.events = events;
    this.identity = identity;
    this.handoffsDir = handoffsDir;
    this.config = config ?? null;
  }
  private db: Db;
  private events: EventService;
  private identity: IdentityService;
  private handoffsDir: string;
  private config: BoundaryConfigInput | null;

  activeWindow(conversationId: string): WindowRow | null {
    const conv = this.db.prepare('SELECT active_window_id FROM conversations WHERE id = ?').get(conversationId) as
      | { active_window_id: string | null }
      | undefined;
    if (!conv?.active_window_id) return null;
    return (this.db.prepare("SELECT * FROM windows WHERE id = ? AND status = 'ACTIVE'").get(conv.active_window_id) as WindowRow | undefined) ?? null;
  }

  /** 把 SDK session 绑定到窗口（AUD-03）：同窗后续轮 resume 该 session */
  bindSession(windowId: string, sdkSessionId: string): void {
    tx(this.db, () => {
      this.db
        .prepare('UPDATE windows SET sdk_session_id = ?, updated_at = ? WHERE id = ? AND sdk_session_id IS NULL')
        .run(sdkSessionId, new Date().toISOString(), windowId);
    });
  }

  /** fresh_session 重跑完成后的改绑（CAS 旧值）：旧 session 含被替代输入，弃用并指向新 session */
  rebindSession(windowId: string, expectedOld: string | null, sdkSessionId: string): void {
    tx(this.db, () => {
      if (expectedOld === null) {
        this.db.prepare('UPDATE windows SET sdk_session_id = ?, updated_at = ? WHERE id = ? AND sdk_session_id IS NULL')
          .run(sdkSessionId, new Date().toISOString(), windowId);
      } else {
        this.db.prepare('UPDATE windows SET sdk_session_id = ?, updated_at = ? WHERE id = ? AND sdk_session_id = ?')
          .run(sdkSessionId, new Date().toISOString(), windowId, expectedOld);
      }
    });
  }

  // 创建并尝试激活新窗：NEW → PREPARING(+receipt) → READY → [tx 原子切换] ACTIVE | BLOCKED
  createWindow(o: { conversationId: string; gate: GateResult; assembledOptions?: Record<string, unknown> | null }): { window: WindowRow; blockedReason: string | null } {
    const id = genId('win');
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db
        .prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES (?,?, 'NEW', ?, ?)")
        .run(id, o.conversationId, now, now);
    });
    this.setStatus(id, 'PREPARING');
    // Receipt：即使 blocked 也留证据；写失败本身 → candidate 终态 BLOCKED（AUD-38，不悬挂 PREPARING）
    let fingerprint: string;
    try {
      fingerprint = contextFingerprint(this.identityConfig(), o.gate.manifest);
      const receipt = this.identity.buildAndStoreReceipt(this.db, {
        windowId: id,
        manifest: o.gate.manifest,
        gate: o.gate,
        assembledOptions: o.gate.state === 'READY' ? (o.assembledOptions ?? null) : null,
      });
      tx(this.db, () => {
        this.db.prepare('UPDATE windows SET receipt_id = ?, manifest_ref = ?, context_fingerprint = ?, updated_at = ? WHERE id = ?').run(receipt.id, receipt.manifest_ref, fingerprint, new Date().toISOString(), id);
      });
    } catch (err) {
      this.setStatus(id, 'BLOCKED', `receipt_write_failed: ${String((err as Error).message).slice(0, 60)}`);
      this.emitChanged(id, o.conversationId, 'BLOCKED', 'receipt_write_failed');
      return { window: this.get(id)!, blockedReason: 'receipt 写失败（candidate 已落终态 BLOCKED）' };
    }

    if (o.gate.state !== 'READY') {
      const reason = o.gate.reasons.join('; ');
      this.setStatus(id, 'BLOCKED', reason);
      this.emitChanged(id, o.conversationId, 'BLOCKED', reason);
      return { window: this.get(id)!, blockedReason: reason };
    }
    this.setStatus(id, 'IDENTITY_VERIFIED');
    this.setStatus(id, 'READY');
    // 原子切换：当前指针未变时才接管
    const prevId = tx(this.db, () => {
      const conv = this.db.prepare('SELECT active_window_id FROM conversations WHERE id = ?').get(o.conversationId) as { active_window_id: string | null };
      const prev = conv?.active_window_id ?? null;
      this.db.prepare("UPDATE windows SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      this.db.prepare('UPDATE conversations SET active_window_id = ? WHERE id = ?').run(id, o.conversationId);
      if (prev) this.db.prepare("UPDATE windows SET status = 'CLOSED', updated_at = ? WHERE id = ?").run(new Date().toISOString(), prev);
      return prev;
    });
    void prevId;
    this.emitChanged(id, o.conversationId, 'ACTIVE', null);
    return { window: this.get(id)!, blockedReason: null };
  }

  // 手动轮转（AUD-20 修复版）：prepare 全部成功 → 一个事务切换；任何失败旧窗保持 ACTIVE
  // F09：安全检查在 Manager 内部（数据库是真源）——生成中 turn 或待决路由票据都拒绝轮转，
  // 不依赖可选 HTTP callback；HTTP 与直接服务调用无法绕过
  rotate(o: { conversationId: string; gate: GateResult; maxSequence: number; assembledOptions?: Record<string, unknown> | null }): { ok: true; window: WindowRow } | { ok: false; reason: string } {
    const current = this.activeWindow(o.conversationId);
    if (!current) return { ok: false, reason: '无当前活动窗口' };
    if (o.gate.state !== 'READY') {
      return { ok: false, reason: `IDENTITY_BLOCKED：${o.gate.reasons.join('; ')}（旧窗保持 ACTIVE）` };
    }
    const running = (this.db.prepare("SELECT COUNT(*) n FROM turns WHERE conversation_id = ? AND state = 'running'").get(o.conversationId) as { n: number }).n;
    if (running > 0) {
      return { ok: false, reason: 'FENCE_ACTIVE：该房间有生成中的 turn，拒绝换窗（先停止或等待完成；旧窗保持 ACTIVE）' };
    }
    const pendingRoute = (this.db.prepare("SELECT COUNT(*) n FROM route_decisions WHERE conversation_id = ? AND state = 'pending'").get(o.conversationId) as { n: number }).n;
    if (pendingRoute > 0) {
      return { ok: false, reason: 'ROUTE_PENDING：该房间有待决路由票据，拒绝换窗（先处理票据；旧窗保持 ACTIVE）' };
    }

    // —— prepare：candidate + receipt + handoff（旧窗仍是 ACTIVE）——
    const candidateId = genId('win');
    const now = new Date().toISOString();
    tx(this.db, () => {
      this.db
        .prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES (?,?, 'PREPARING', ?, ?)")
        .run(candidateId, o.conversationId, now, now);
    });
    let handoffPath: string;
    try {
      const fingerprint = contextFingerprint(this.identityConfig(), o.gate.manifest);
      const receipt = this.identity.buildAndStoreReceipt(this.db, {
        windowId: candidateId,
        manifest: o.gate.manifest,
        gate: o.gate,
        assembledOptions: o.assembledOptions ?? null,
      });
      handoffPath = this.writeHandoff(current, o.maxSequence, candidateId);
      tx(this.db, () => {
        this.db.prepare('UPDATE windows SET receipt_id = ?, manifest_ref = ?, context_fingerprint = ?, updated_at = ? WHERE id = ?').run(receipt.id, receipt.manifest_ref, fingerprint, new Date().toISOString(), candidateId);
      });
      this.setStatus(candidateId, 'READY');
    } catch (err) {
      // handoff/receipt 写失败：candidate 标记失败，旧窗保持 ACTIVE，绝不 null
      this.setStatus(candidateId, 'BLOCKED', `prepare_failed: ${(err as Error).message.slice(0, 80)}`);
      return { ok: false, reason: `轮转准备失败（旧窗保持 ACTIVE）：${(err as Error).message.slice(0, 120)}` };
    }

    // —— switch：单事务 CAS ——
    try {
      tx(this.db, () => {
        const conv = this.db.prepare('SELECT active_window_id FROM conversations WHERE id = ?').get(o.conversationId) as { active_window_id: string | null };
        if (conv?.active_window_id !== current.id) throw new Error('switch_conflict: 活动指针已被并发修改');
        this.db.prepare("UPDATE windows SET status = 'CLOSED', cutoff_sequence = ?, updated_at = ? WHERE id = ?").run(o.maxSequence, new Date().toISOString(), current.id);
        this.db.prepare("UPDATE windows SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(new Date().toISOString(), candidateId);
        this.db.prepare('UPDATE conversations SET active_window_id = ? WHERE id = ?').run(candidateId, o.conversationId);
      });
    } catch (err) {
      this.setStatus(candidateId, 'BLOCKED', `switch_failed: ${(err as Error).message.slice(0, 80)}`);
      return { ok: false, reason: `切换失败已回滚（旧窗保持 ACTIVE）：${(err as Error).message.slice(0, 120)}` };
    }
    this.emitChanged(candidateId, o.conversationId, 'ACTIVE', null);
    return { ok: true, window: this.get(candidateId)! };
  }

  // 短交接（7.3）：只记录可核验事实；预算未配置时不灌历史；不引用思考摘要（硬规则）
  private writeHandoff(window: WindowRow, cutoff: number, candidateId: string): string {
    const dir = path.join(this.handoffsDir, candidateId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'handoff.json');
    const handoff = {
      window_id: window.id,
      candidate_window_id: candidateId,
      conversation_id: window.conversation_id,
      cutoff_sequence: cutoff,
      recent_dialogue_budget_tokens: null,
      includes_reasoning: false,
      unanswered_questions: [],
      unfinished_actions: [],
      sdk_session_id_of_old_window: window.sdk_session_id,
      note: 'v0.2.2：交接仅含元信息；正式 Mariposa 开窗包待契约接入（本轮不接）',
      written_at: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(handoff, null, 2));
    return file;
  }

  /** §7：人格/运行边界指纹变化 → 窗口 CONTEXT_STALE，禁止继续 resume 旧 session */
  markContextStale(windowId: string, reason: string): void {
    tx(this.db, () => {
      this.db
        .prepare("UPDATE windows SET status = 'CONTEXT_STALE', blocked_reason = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'")
        .run(reason, new Date().toISOString(), windowId);
    });
  }

  private identityConfig(): BoundaryConfigInput {
    if (!this.config) throw new Error('CONFIG_ERROR: WindowManager 未收到 config，无法计算上下文指纹');
    return this.config;
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
