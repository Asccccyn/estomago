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
import type { ManualSelectionService } from '../context/manual-selection.ts';
import type { WindowTrajectoryService } from '../runtime/window-trajectory.ts';

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
  // handoffsDir 参数已随 handoff.json 退役移除（她 2026-10-24 裁定：交接文件零读者）
  constructor(db: Db, events: EventService, identity: IdentityService, config?: BoundaryConfigInput | (() => BoundaryConfigInput), selections?: ManualSelectionService, trajectory?: WindowTrajectoryService | null) {
    this.db = db;
    this.events = events;
    this.identity = identity;
    // config 可为静态对象或 provider 函数（2026-10-08：运行时 override——
    // 新窗创建时按生效型号/边界存指纹；既有调用方传对象照常工作）
    this.config = typeof config === 'function' ? null : (config ?? null);
    this.configProvider = typeof config === 'function' ? config : null;
    this.selections = selections ?? null;
    // WP-07（CX-09）：初始轨迹写入切换事务所需（可空——既有调用方兼容）
    this.trajectorySvc = trajectory ?? null;
  }
  private db: Db;
  private events: EventService;
  private identity: IdentityService;
  private config: BoundaryConfigInput | null;
  private configProvider: (() => BoundaryConfigInput) | null;
  private selections: ManualSelectionService | null;
  private trajectorySvc: import('../runtime/window-trajectory.ts').WindowTrajectoryService | null;

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
  // WP3：selectionId 给出时，选集消费与激活同一事务（E07 原子提交）
  createWindow(o: { conversationId: string; gate: GateResult; assembledOptions?: Record<string, unknown> | null; selectionId?: string; initialTrajectory?: { messages: import('../runtime/or-payload.ts').OrMessage[]; manifest: import('../context/review-policy.ts').ManifestEntry[] } | null }): { window: WindowRow; blockedReason: string | null } {
    const id = genId('win');
    const now = new Date().toISOString();
    // F25 教训（2026-10-24）：selectionId 给出而选集服务未接线=装配漂移——
    // 静默跳过消费会让 confirmed 永不 consumed、恢复链重复要求选集。fail fast。
    if (o.selectionId && !this.selections) throw new Error('WINDOW_SELECTIONS_NOT_WIRED:selectionId 已给出但 WindowManager 未注入选集服务（对照 app-context 装配）');
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
      if (prev && this.get(prev)?.status === 'ACTIVE') throw new Error('ROTATION_SOURCE_CHANGED');
      this.assertNoUnresolvedRotation(o.conversationId);
      if (this.db.prepare("SELECT 1 FROM turns WHERE conversation_id=? AND state='running' LIMIT 1").get(o.conversationId) || this.db.prepare("SELECT 1 FROM route_decisions WHERE conversation_id=? AND state='pending' LIMIT 1").get(o.conversationId)) throw new Error('ROTATION_BUSY');
      this.db.prepare("UPDATE windows SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      this.db.prepare('UPDATE conversations SET active_window_id = ? WHERE id = ?').run(id, o.conversationId);
      if (prev) this.db.prepare("UPDATE windows SET status = 'CLOSED', updated_at = ? WHERE id = ?").run(new Date().toISOString(), prev);
      // WP3（E07）：选集 consumed+target 绑定与窗口激活同一事务；
      // WP-07（CX-09）：初始轨迹同事务写入——激活返回时新窗已具备
      // 完整可发送快照，不依赖下一轮懒初始化
      if (o.selectionId && this.selections) this.selections.consumeInTx(this.db, o.selectionId, id);
      if (o.initialTrajectory && this.trajectorySvc) {
        this.trajectorySvc.initInTx(this.db, id, o.initialTrajectory.messages, o.initialTrajectory.manifest);
      }
      return prev;
    });
    void prevId;
    this.emitChanged(id, o.conversationId, 'ACTIVE', null);
    return { window: this.get(id)!, blockedReason: null };
  }

  // 手动轮转（AUD-20 修复版）：prepare 全部成功 → 一个事务切换；任何失败旧窗保持 ACTIVE
  // F09：安全检查在 Manager 内部（数据库是真源）——生成中 turn 或待决路由票据都拒绝轮转，
  // 不依赖可选 HTTP callback；HTTP 与直接服务调用无法绕过
  // WP3（E07）：selectionId 给出时，选集消费（consumed+target_window_id）
  // 与窗口指针切换同一事务——新窗未就绪则选集不被消费，失败整体回滚
  rotate(o: { expectedWindowId?: string; conversationId: string; gate: GateResult; maxSequence: number; assembledOptions?: Record<string, unknown> | null; selectionId?: string; initialTrajectory?: { messages: import('../runtime/or-payload.ts').OrMessage[]; manifest: import('../context/review-policy.ts').ManifestEntry[] } | null }): { ok: true; window: WindowRow } | { ok: false; reason: string } {
    const current = this.activeWindow(o.conversationId);
    if (!current) return { ok: false, reason: '无当前活动窗口' };
    if (o.expectedWindowId && current.id !== o.expectedWindowId) return { ok: false, reason: 'ROTATION_SUPERSEDED' };
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
    // F25 教训（2026-10-24）：同 createWindow——selectionId 给出而服务未接线=装配漂移，fail fast
    if (o.selectionId && !this.selections) throw new Error('WINDOW_SELECTIONS_NOT_WIRED:selectionId 已给出但 WindowManager 未注入选集服务（对照 app-context 装配）');
    tx(this.db, () => {
      this.db
        .prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES (?,?, 'PREPARING', ?, ?)")
        .run(candidateId, o.conversationId, now, now);
    });
    try {
      const fingerprint = contextFingerprint(this.identityConfig(), o.gate.manifest);
      const receipt = this.identity.buildAndStoreReceipt(this.db, {
        windowId: candidateId,
        manifest: o.gate.manifest,
        gate: o.gate,
        assembledOptions: o.assembledOptions ?? null,
      });
      // handoff.json 交接文件已按她 2026-10-24 裁定退役（零读者、契约从未接入）；
      // receipt 写失败仍整体回滚（prepare_failed 路径不变，AUD-38 不悬挂 PREPARING）
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
        // WP-05（JFA-E06）：FENCE 事务内复检——prepare 期间（网络/IO）
        // 可能有新 turn 进入 running 或新路由票据 pending；锁内重查非零
        // → 整体回滚（旧窗保持 ACTIVE），封掉 prepare 前检查的 TOCTOU 窗口
        const runningNow = (this.db.prepare("SELECT COUNT(*) n FROM turns WHERE conversation_id = ? AND state = 'running'").get(o.conversationId) as { n: number }).n;
        if (runningNow > 0) throw new Error('FENCE_ACTIVE: 切换事务内发现生成中 turn（prepare 期间新进入），回滚');
        const pendingRouteNow = (this.db.prepare("SELECT COUNT(*) n FROM route_decisions WHERE conversation_id = ? AND state = 'pending'").get(o.conversationId) as { n: number }).n;
        if (pendingRouteNow > 0) throw new Error('ROUTE_PENDING: 切换事务内发现待决路由票据，回滚');
        this.assertNoUnresolvedRotation(o.conversationId);
        this.db.prepare("UPDATE windows SET status = 'CLOSED', cutoff_sequence = ?, updated_at = ? WHERE id = ?").run(o.maxSequence, new Date().toISOString(), current.id);
        this.db.prepare("UPDATE windows SET status = 'ACTIVE', updated_at = ? WHERE id = ?").run(new Date().toISOString(), candidateId);
        this.db.prepare('UPDATE conversations SET active_window_id = ? WHERE id = ?').run(candidateId, o.conversationId);
        // WP3（E07）：选集消费与指针切换原子——输家整体回滚，不出现
        // "选集已耗但新窗未激活"（或反之）的半状态；
        // WP-07（CX-09）：初始轨迹同事务写入（选集消费+窗口指针+轨迹
        // 三位一体；调用方在事务外先行完成 bootstrap 获取与容量检查）
        if (o.selectionId && this.selections) this.selections.consumeInTx(this.db, o.selectionId, candidateId);
        if (o.initialTrajectory && this.trajectorySvc) {
          this.trajectorySvc.initInTx(this.db, candidateId, o.initialTrajectory.messages, o.initialTrajectory.manifest);
        }
      });
    } catch (err) {
      this.setStatus(candidateId, 'BLOCKED', `switch_failed: ${(err as Error).message.slice(0, 80)}`);
      return { ok: false, reason: `切换失败已回滚（旧窗保持 ACTIVE）：${(err as Error).message.slice(0, 120)}` };
    }
    this.emitChanged(candidateId, o.conversationId, 'ACTIVE', null);
    return { ok: true, window: this.get(candidateId)! };
  }

  /** §7：人格/运行边界指纹变化 → 窗口 CONTEXT_STALE，禁止继续 resume 旧 session */
  markContextStale(windowId: string, reason: string): void {
    tx(this.db, () => {
      this.db
        .prepare("UPDATE windows SET status = 'CONTEXT_STALE', blocked_reason = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'")
        .run(reason, new Date().toISOString(), windowId);
    });
  }

  private assertNoUnresolvedRotation(conversationId: string): void {
    if (this.db.prepare("SELECT 1 FROM rotation_reviews WHERE room_id=? AND status='active' LIMIT 1").get(conversationId)) throw new Error('REVIEW_IN_PROGRESS');
    if (this.db.prepare("SELECT 1 FROM tool_side_effects e JOIN windows w ON w.id=e.window_id WHERE w.conversation_id=? AND e.state IN ('pending','running','unknown','failed_unresolved') LIMIT 1").get(conversationId)) throw new Error('WRITES_UNRESOLVED');
  }

  private identityConfig(): BoundaryConfigInput {
    if (this.configProvider) return this.configProvider();
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
