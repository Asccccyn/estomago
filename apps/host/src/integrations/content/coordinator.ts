// P1（四仓合并审计 20261106，F06/F07）：est→content 写路径的持久协调器。
// 一次内容写 = ⓪ 本地已接受身份边界（pending/unknown 意图下同键异参拒 409，同参按
// 已持久原意图继续——RF02，复审 20261106）→ ① 同操作回查（旧成功只回放原回执）→
// ② 新操作先核候选资产可用 →
// ③ Host 本地事务持久意图（outbox target=content.operation）+ 逐资产 protected pin →
// ④ HTTP 提交 content（业务与回执同事务）→ ⑤ 成功后按 content 权威快照在另一本地事务
// 确认映射（正式 committed 关系按 owner+asset 唯一；版本单调准入；释放已退出成员；
// 收口本次 pin）→ ⑥ 未知结果（超时/5xx/不可解析/快照不可达）保留意图与 pin，由
// 恢复消费者按原身份有界重放收口；确定未提交（content 4xx）才释放本次 pin。
// 恢复消费者启动清一遍+周期有界处理共用一条单飞链（完成后 finally 释放标记——RF01），
// 不新增第二个 timer。不新建任务平台：outbox 现有 state 机（pending/unknown_outcome/
// acked/failed）即意图状态；owner 已应用版本锚存 content_owner_state（含零集合/删除——
// 不从活跃引用行推算）。
import type { Db } from '../../db/connection.ts';
import { tx } from '../../db/connection.ts';
import type { MediaService } from '../../media/assets.ts';
import { MediaError } from '../../media/assets.ts';
import type { Logger } from '../../observability/logging.ts';
import { stableErrorCode } from '../../observability/errors.ts';
import { contentForward, fetchReferenceSnapshot, ownerTypeOf, resolveContentOperation, type ContentClient } from './client.ts';

export const CONTENT_OPERATION_TARGET = 'content.operation';
const RECOVER_INTERVAL_MS = 15_000;
const RECOVER_BATCH = 5;
const MAX_ATTEMPTS = 20; // 超限保持 unknown_outcome（pin 继续保护），不自动释放

type IntentPayload = {
  actor: 'qiaosheng' | 'jiaming';
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  if_match?: string;
};

type OutboxRow = { id: string; operation_key: string; payload_ref: string; state: string; attempt: number };

export type ContentWriteResult = { status: number; body: unknown };

export class ContentOperationCoordinator {
  private readonly db: Db;
  private readonly client: ContentClient;
  private readonly media: MediaService;
  private readonly logger: Logger;
  private recoverTimer: ReturnType<typeof setInterval> | null = null;
  private recoverInFlight: Promise<void> | null = null;

  constructor(deps: { db: Db; client: ContentClient; media: MediaService; logger: Logger }) {
    this.db = deps.db;
    this.client = deps.client;
    this.media = deps.media;
    this.logger = deps.logger;
  }

  /** 浏览器代理与模型写工具共用入口。GET 不经此处（无写协调）。 */
  async write(req: {
    method: 'POST' | 'PUT' | 'DELETE';
    path: string; // /api/v1/content/...
    actor: 'qiaosheng' | 'jiaming';
    body?: Record<string, unknown>;
    headers: Record<string, string>; // idempotency-key 必带；if-match 可选
  }): Promise<ContentWriteResult> {
    const key = req.headers['idempotency-key'];
    if (!key) return { status: 400, body: { error: { code: 'missing_idempotency', message: '写请求必须带 Idempotency-Key' } } };
    const opKey = `content:${req.actor}:${key}`;
    const currentIntent: IntentPayload = { actor: req.actor, method: req.method, path: req.path.split('?')[0]!, body: req.body, if_match: req.headers['if-match'] };

    // ⓪ 本地已接受身份边界（RF02，复审 20261106）：pending/unknown 意图=操作已被本宿主
    // 接受（意图+pin 已持久、结果未收口）。此时同键异参不得借“远端尚无回执”改写已
    // 接受操作——拒 409；同参重试按已持久原意图继续（不经资产重检：原 pin 仍在保护，
    // 不因资产状态变化阻挡已接受操作的重放）。
    const accepted = this.db.prepare("SELECT state, payload_ref FROM outbox WHERE target = ? AND operation_key = ? AND state IN ('pending','unknown_outcome')").get(CONTENT_OPERATION_TARGET, opKey) as { state: string; payload_ref: string } | undefined;
    if (accepted) {
      const persisted = JSON.parse(accepted.payload_ref) as IntentPayload;
      if (intentFingerprint(persisted) !== intentFingerprint(currentIntent)) {
        return { status: 409, body: { error: { code: 'content_operation_conflict', message: '该幂等键已有未收口的已接受操作（参数不同）。原操作已持久并将按原身份收口；新操作请换幂等键。' } } };
      }
      return this.dispatchPinned(opKey, persisted);
    }

    // ① 同操作回查：旧成功回放原回执——不做资产校验（HOST_REPLAY_ORDER：不能被旧 unavailable 挡住）
    let resolved;
    try {
      resolved = await resolveContentOperation(this.client, { actor: req.actor, method: req.method, path: req.path.split('?')[0]!, body: req.body, idempotencyKey: key, ifMatch: req.headers['if-match'] });
    } catch (err) {
      this.logger.warn('content_resolve_failed', { code: stableErrorCode(err), detail: String((err as Error).message ?? err).slice(0, 140) });
      return { status: 503, body: { error: { code: 'content_unreachable', message: '内容服务不可达，稍后重试（原操作未提交）', detail: String((err as Error).message ?? err).slice(0, 140) } } };
    }
    if (resolved.outcome !== 'new') return { status: resolved.status, body: resolved.body };

    // ② 新操作：候选资产存在且 available（字段集合=请求引用，不是领域完整成员——
    //    正式成员由 content 快照决定，Host 不拼领域集合）
    const candidates = candidateAssetIds(req.body);
    for (const assetId of candidates) {
      try {
        const a = this.media.getAsset(assetId);
        if (a.state !== 'available') return { status: 422, body: { error: { code: 'asset_not_ready', message: `资产 ${assetId} 状态 ${a.state}` } } };
      } catch (err) {
        if (err instanceof MediaError) return { status: err.httpStatus, body: { error: { code: err.code.toLowerCase(), message: err.message } } };
        throw err;
      }
    }

    // ③ HTTP 前持久意图 + pin（同一本地事务；失败=操作未被接受，不提交 content）
    try {
      tx(this.db, () => this.upsertIntent(opKey, currentIntent, candidates));
    } catch (err) {
      this.logger.warn('content_intent_persist_failed', { code: stableErrorCode(err), detail: String((err as Error).message ?? err).slice(0, 140) });
      return { status: 503, body: { error: { code: 'content_intent_persist_failed', message: '本地意图登记失败，操作未提交（可原键重试）' } } };
    }

    // ④ 提交——只执行已持久且匹配的原意图（upsert 对 failed/acked 重开时即当前请求）
    return this.dispatchPinned(opKey, this.intentOf(opKey) ?? currentIntent);
  }

  /** 已有意图的提交与收口（write ④-⑥ 与恢复消费者共用）。调用前提：意图+pin 已持久。 */
  private async dispatchPinned(opKey: string, intent: IntentPayload): Promise<ContentWriteResult> {
    const idemKey = opKey.slice(`content:${intent.actor}:`.length);
    let result: ContentWriteResult;
    try {
      result = await contentForward(this.client, {
        method: intent.method, path: intent.path, actor: intent.actor, body: intent.body,
        headers: { ...(intent.if_match !== undefined ? { 'If-Match': intent.if_match } : {}), 'Idempotency-Key': idemKey },
      });
    } catch (err) {
      this.markUnknown(opKey, err as Error);
      return { status: 504, body: { error: { code: 'content_write_unknown', message: '内容服务响应未知；操作已持久，将按原身份恢复收口（同键重试安全）' } } };
    }
    if (result.status >= 500) {
      this.markUnknown(opKey, new Error(`content ${result.status}`));
      return result;
    }
    if (result.status >= 400) {
      // content 4xx=业务未提交（业务与回执同事务，失败零副作用）→ 定局：释放本次 pin
      this.finishFailed(opKey, `content ${result.status}`);
      return result;
    }
    // 成功：读权威快照确认映射。确认失败不吞——pin 仍在保护，恢复消费者收口；
    // 业务已成功，向调用方如实返回 content 结果。
    await this.confirmOperation(opKey, result).catch((err) => {
      this.logger.warn('content_confirm_deferred', { code: stableErrorCode(err) });
    });
    return result;
  }

  /** 成功后确认：快照→（单调准入）→content_owner_state+映射+ack 同一本地事务。 */
  private async confirmOperation(opKey: string, contentResult: ContentWriteResult): Promise<boolean> {
    const intent = this.intentOf(opKey);
    if (!intent) return false;
    const ownerId = (contentResult.body as { id?: string } | null)?.id;
    if (typeof ownerId !== 'string' || !ownerId) { this.markUnknown(opKey, new Error('no_object_id')); return false; }
    const ownerType = ownerTypeOf(intent.path);
    const snapshot = await fetchReferenceSnapshot(this.client, ownerType, ownerId);
    if (!snapshot) { this.markUnknown(opKey, new Error('snapshot_unavailable')); return false; } // 404/不可达≠可释放
    this.confirmSnapshot(opKey, ownerType, ownerId, { ownerRevision: snapshot.owner_revision, deleted: snapshot.deleted, assetIds: snapshot.asset_ids });
    return true;
  }

  /** 单调准入的快照确认：旧快照（≤已应用版本）只完成回执处理与 pin 收口，
   *  不降低 owner 版本、不撤销新关系（迟到旧确认不能复活删除/撤保护）。 */
  private confirmSnapshot(opKey: string, ownerType: string, ownerId: string, snapshot: { ownerRevision: number; deleted: boolean; assetIds: string[] }): void {
    const nowIso = new Date().toISOString();
    tx(this.db, () => {
      const applied = this.db.prepare('SELECT applied_revision, deleted, asset_ids_json FROM content_owner_state WHERE owner_type = ? AND owner_id = ?').get(ownerType, ownerId) as { applied_revision: number; deleted: number; asset_ids_json: string } | undefined;
      const stale = applied !== undefined && applied.applied_revision >= snapshot.ownerRevision;
      if (!stale) {
        this.media.commitContentSnapshot({ type: ownerType, id: ownerId }, { ownerRevision: snapshot.ownerRevision, assetIds: snapshot.assetIds }, opKey);
        this.db.prepare(`INSERT INTO content_owner_state(owner_type, owner_id, applied_revision, deleted, asset_ids_json, updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(owner_type, owner_id) DO UPDATE SET applied_revision = excluded.applied_revision, deleted = excluded.deleted, asset_ids_json = excluded.asset_ids_json, updated_at = excluded.updated_at`)
          .run(ownerType, ownerId, snapshot.ownerRevision, snapshot.deleted ? 1 : 0, JSON.stringify(snapshot.assetIds), nowIso);
      } else {
        // 迟到旧确认：不动正式关系与版本锚，只收口本次操作 pin
        this.media.releaseOperationPins(opKey);
      }
      this.ackIntent(opKey, stale ? applied!.applied_revision : snapshot.ownerRevision, ownerId);
    });
  }

  /** 存量对账（G3/G5）：按 owner 当前权威快照走同一确认路径（无 pin、不重放业务写）。 */
  async reconcileOwner(ownerType: string, ownerId: string): Promise<boolean> {
    const snapshot = await fetchReferenceSnapshot(this.client, ownerType, ownerId);
    if (!snapshot) return false;
    this.confirmSnapshot(`reconcile:${ownerType}:${ownerId}`, ownerType, ownerId, { ownerRevision: snapshot.owner_revision, deleted: snapshot.deleted, assetIds: snapshot.asset_ids });
    return true;
  }

  private upsertIntent(opKey: string, intent: IntentPayload, candidates: string[]): void {
    const nowIso = new Date().toISOString();
    const payload = JSON.stringify({ ...intent, candidate_assets: candidates });
    const existing = this.db.prepare('SELECT id, state, payload_ref FROM outbox WHERE target = ? AND operation_key = ?').get(CONTENT_OPERATION_TARGET, opKey) as { id: string; state: string; payload_ref: string } | undefined;
    if (!existing) {
      this.db.prepare('INSERT INTO outbox(id, operation_key, target, payload_ref, state, attempt, last_error, created_at, updated_at) VALUES (?,?,?,?,?,0,NULL,?,?)')
        .run(`cout_${opKey.length}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, opKey, CONTENT_OPERATION_TARGET, payload, 'pending', nowIso, nowIso);
    } else if (existing.state === 'failed' || existing.state === 'acked') {
      // 同键再来（此前定局失败后重试，或 ack 后 content 回执已被外部清理）：以当前请求为准重开
      this.db.prepare('UPDATE outbox SET payload_ref = ?, state = ?, attempt = 0, last_error = NULL, updated_at = ? WHERE id = ?').run(payload, 'pending', nowIso, existing.id);
    }
    // pending/unknown_outcome：保留原始意图与身份，不覆盖
    for (const assetId of candidates) this.media.pinAssetForOperation({ assetId, operationKey: opKey });
  }

  private intentOf(opKey: string): IntentPayload | null {
    const row = this.db.prepare('SELECT payload_ref FROM outbox WHERE target = ? AND operation_key = ?').get(CONTENT_OPERATION_TARGET, opKey) as { payload_ref: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.payload_ref) as IntentPayload;
  }

  private ackIntent(opKey: string, appliedRevision: number, ownerId: string): void {
    const row = this.db.prepare('SELECT payload_ref FROM outbox WHERE target = ? AND operation_key = ?').get(CONTENT_OPERATION_TARGET, opKey) as { payload_ref: string } | undefined;
    if (!row) return;
    const payload = JSON.parse(row.payload_ref) as Record<string, unknown>;
    payload.owner_id = ownerId;
    payload.applied_revision = appliedRevision;
    this.db.prepare("UPDATE outbox SET state = 'acked', payload_ref = ?, attempt = attempt + 1, last_error = NULL, updated_at = ? WHERE target = ? AND operation_key = ?")
      .run(JSON.stringify(payload), new Date().toISOString(), CONTENT_OPERATION_TARGET, opKey);
  }

  private markUnknown(opKey: string, err: Error): void {
    this.db.prepare("UPDATE outbox SET state = 'unknown_outcome', attempt = attempt + 1, last_error = ?, updated_at = ? WHERE target = ? AND operation_key = ? AND state NOT IN ('acked','failed')")
      .run(String(err.message ?? err).slice(0, 120), new Date().toISOString(), CONTENT_OPERATION_TARGET, opKey);
  }

  private finishFailed(opKey: string, reason: string): void {
    const nowIso = new Date().toISOString();
    tx(this.db, () => {
      this.media.releaseOperationPins(opKey);
      this.db.prepare("UPDATE outbox SET state = 'failed', attempt = attempt + 1, last_error = ?, updated_at = ? WHERE target = ? AND operation_key = ? AND state NOT IN ('acked')")
        .run(reason.slice(0, 120), nowIso, CONTENT_OPERATION_TARGET, opKey);
    });
  }

  // —— 恢复消费者：启动清一遍 + 周期有界处理（运行中不调用模型、不碰归档消费者） ——
  start(): void {
    void this.recoverOnce().catch((err) => this.logger.warn('content_recover_failed', { code: stableErrorCode(err) }));
    this.recoverTimer = setInterval(() => { void this.recoverOnce().catch((err) => this.logger.warn('content_recover_failed', { code: stableErrorCode(err) })); }, RECOVER_INTERVAL_MS);
    this.recoverTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.recoverTimer) { clearInterval(this.recoverTimer); this.recoverTimer = null; }
    await this.recoverInFlight?.catch(() => {});
  }

  async recoverOnce(limit = RECOVER_BATCH): Promise<number> {
    if (this.recoverInFlight) return 0;
    const task = (async () => {
      // MAX_ATTEMPTS 筛选在候选 SQL 里完成：超限行不再占用批次（保留意图与 pin 等待人工/对账）
      const rows = this.db.prepare("SELECT id, operation_key, payload_ref, state, attempt FROM outbox WHERE target = ? AND state IN ('pending','unknown_outcome') AND attempt <= ? ORDER BY created_at LIMIT ?")
        .all(CONTENT_OPERATION_TARGET, MAX_ATTEMPTS, limit) as Array<OutboxRow>;
      for (const row of rows) {
        const p = JSON.parse(row.payload_ref) as IntentPayload;
        const idem = row.operation_key.slice(`content:${p.actor}:`.length);
        try {
          const resolved = await resolveContentOperation(this.client, { actor: p.actor, method: p.method, path: p.path, body: p.body, idempotencyKey: idem, ifMatch: p.if_match });
          if (resolved.outcome === 'replay') {
            // 原操作已提交：确认映射收口（快照不可达=保留，下轮再试）
            await this.confirmOperation(row.operation_key, { status: resolved.status, body: resolved.body });
          } else if (resolved.outcome === 'new') {
            // 原操作确未提交（content 业务与回执同事务）→ 按原身份重放一次并走同一收口
            await this.dispatchPinned(row.operation_key, p);
          } else {
            // conflict/legacy_unresolved：身份与原意图不一致——保留意图与 pin，标错误待人工
            this.db.prepare("UPDATE outbox SET last_error = ?, updated_at = ? WHERE id = ?").run(`resolve:${resolved.outcome}`, new Date().toISOString(), row.id);
          }
        } catch (err) {
          this.db.prepare("UPDATE outbox SET attempt = attempt + 1, last_error = ?, updated_at = ? WHERE id = ?").run(String((err as Error).message).slice(0, 120), new Date().toISOString(), row.id);
        }
      }
      return rows.length;
    })();
    // RF01（复审 20261106）：单飞标记必须随本次完成真正释放（finally），否则 15 秒定时
    // 消费者自第一批后永久被已完成的 promise 挡住——启动空批后的运行中故障无人收口。
    this.recoverInFlight = task.then(() => undefined, () => undefined);
    void this.recoverInFlight.finally(() => { this.recoverInFlight = null; });
    return task;
  }
}

/** 请求引用的候选资产（数组 asset_ids 与单值 asset_id/icon_asset_id/work_asset_id）。
 *  仅用于前置可用性核对与 pin；正式成员集合以 content 快照为准。 */
export function candidateAssetIds(body: Record<string, unknown> | undefined): string[] {
  const refs: string[] = [];
  if (body && typeof body === 'object') {
    if (Array.isArray(body.asset_ids)) for (const a of body.asset_ids) if (typeof a === 'string' && a) refs.push(a);
    for (const k of ['asset_id', 'icon_asset_id', 'work_asset_id'] as const) {
      if (typeof body[k] === 'string' && body[k]) refs.push(body[k] as string);
    }
  }
  return [...new Set(refs)];
}

/** 已接受意图与当前请求是否同一命令（RF02）：method/path/if_match 逐字，body 按键排序
 *  规范化比较（JSON 往返丢 undefined，两侧统一 ?? null 归一）。 */
function canonicalJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalJson);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonicalJson((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
function intentFingerprint(intent: IntentPayload): string {
  return JSON.stringify({ m: intent.method, p: intent.path, im: intent.if_match ?? null, b: canonicalJson(intent.body) ?? null });
}
