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
import { classifySvg } from '../../media/static-svg.ts';
import type { Logger } from '../../observability/logging.ts';
import { stableErrorCode } from '../../observability/errors.ts';
import { sha256Hex } from '../../util/id.ts';
import { contentForward, fetchReferenceSnapshot, ownerTypeOf, resolveContentOperation, type ContentClient, type ContentReferenceSnapshot } from './client.ts';
import { isUserArchiveCreate, registerArchiveCreatedNotice } from './archive-notice.ts';
import { heartbeatContentKindAtPath, heartbeatContentKindForOwner, heartbeatContentSourcePath, invalidateHeartbeatContentSource } from '../../modules/heartbeat/service.ts';
import { bindHeartbeatContentOperation, settleHeartbeatContentReceipt, type HeartbeatContentBinding } from '../../modules/heartbeat/actions.ts';

export const CONTENT_OPERATION_TARGET = 'content.operation';
/** F3（复审 2026-11-09 二轮）：存档 M 投影意图 outbox target——content 权威快照确认的
 *  同一本地事务登记；由 ArchiveSyncService 既有周期消费（不加新 timer/领取器）。 */
export const ARCHIVE_PROJECTION_TARGET = 'mariposa.archive_projection';
const RECOVER_INTERVAL_MS = 15_000;
const RECOVER_BATCH = 5;
const MAX_ATTEMPTS = 20; // 超限保持 unknown_outcome（pin 继续保护），不自动释放

type IntentPayload = {
  actor: 'qiaosheng' | 'jiaming';
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  if_match?: string;
  commit_observed?: 1;
};

type OutboxRow = { id: string; operation_key: string; payload_ref: string; state: string; attempt: number };

export type ContentWriteResult = { status: number; body: unknown; /** Host-only original durable key of a model operation. */ operationKey?: string };
type ContentWriteRequest = {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  actor: 'qiaosheng' | 'jiaming';
  body?: Record<string, unknown>;
  headers: Record<string, string>;
};

const MODEL_OPERATION_PREFIX = 'content:jiaming:';
const LEGACY_MODEL_OPERATION_PREFIX = `${MODEL_OPERATION_PREFIX}tool:`;
const OPERATION_CONFLICT: ContentWriteResult = { status: 409, body: { error: {
  code: 'content_operation_conflict', message: '同一幂等键对应已受理的另一组参数。请用原参数核回，独立的新操作使用新键。',
} } };

function committedReceiptPending(status?: number): ContentWriteResult {
  return { status: 502, body: { error: {
    code: 'content_write_confirmation_pending',
    message: '提交已成功，回执暂缺。请用原幂等键及原参数核回。',
    ...(status === undefined ? {} : { raw_status: status }),
  } } };
}

export class ContentOperationCoordinator {
  private readonly db: Db;
  private readonly client: ContentClient;
  private readonly media: MediaService;
  private readonly logger: Logger;
  private recoverTimer: ReturnType<typeof setInterval> | null = null;
  private recoverInFlight: Promise<void> | null = null;
  private guardSourceMutation?: <T>(path: string, operation: () => Promise<T>) => Promise<T>;

  constructor(deps: { db: Db; client: ContentClient; media: MediaService; logger: Logger }) {
    this.db = deps.db;
    this.client = deps.client;
    this.media = deps.media;
    this.logger = deps.logger;
  }

  setSourceMutationGuard(guard: NonNullable<ContentOperationCoordinator['guardSourceMutation']>): void {
    this.guardSourceMutation = guard;
  }

  /** 模型重试建档时复用首次接纳已经钉住的成员和修订。 */
  getArchiveCreateIntent(conversationId: string, key: string): Record<string, unknown> | null {
    const intent = this.intentOf(`content:jiaming:${key}`);
    if (intent?.actor !== 'jiaming' || intent.method !== 'POST' || intent.path !== '/api/v1/content/archives'
      || intent.body?.conversation_id !== conversationId) return null;
    return intent.body;
  }

  /** 模型显式键按授权房间和写操作类型稳定。历史意图仍用旧 HTTP 键和现有 pin。 */
  async writeForModel(req: {
    roomId: string; turnId: string | null; path: string; body: Record<string, unknown>; idempotencyKey: string;
    heartbeat?: HeartbeatContentBinding;
  }): Promise<ContentWriteResult> {
    const kind = ownerTypeOf(req.path);
    let key = `tool-content-v2:${sha256Hex(JSON.stringify([req.roomId, kind, req.idempotencyKey]))}`;
    const stable = this.db.prepare('SELECT 1 FROM outbox WHERE target=? AND operation_key=?')
      .get(CONTENT_OPERATION_TARGET, MODEL_OPERATION_PREFIX + key);
    if (!stable) {
      const original = this.legacyModelKey(req, kind);
      if (original === false) return { status: 409, body: { error: {
        code: 'content_legacy_key_ambiguous', message: '该业务键在当前房间对应多笔历史操作，无法唯一核回。请按已知对象 ID 核对历史。',
      } } };
      if (original) key = original;
    }
    const result = await this.write({ method: 'POST', path: req.path, actor: 'jiaming', body: req.body,
      headers: { 'idempotency-key': key },
    }, true, req.heartbeat);
    if (result.status < 500 || (result.body as { error?: { code?: string } } | null)?.error?.code === 'content_write_confirmation_pending') {
      return { ...result, operationKey: MODEL_OPERATION_PREFIX + key };
    }
    const retained = this.db.prepare(`SELECT state, payload_ref FROM outbox
      WHERE target=? AND operation_key=? AND state IN ('pending','unknown_outcome','acked')`)
      .get(CONTENT_OPERATION_TARGET, MODEL_OPERATION_PREFIX + key) as { state: string; payload_ref: string } | undefined;
    if (!retained) return { ...result, operationKey: MODEL_OPERATION_PREFIX + key };
    if (retained.state === 'acked' || (JSON.parse(retained.payload_ref) as IntentPayload).commit_observed === 1) {
      return { ...committedReceiptPending(), operationKey: MODEL_OPERATION_PREFIX + key };
    }
    return { status: 504, body: { error: { code: 'content_write_unknown', message: '操作已受理，结果待核。请使用原键及原参数。' } }, operationKey: MODEL_OPERATION_PREFIX + key };
  }

  /** 返回原 HTTP 键；false 表示有多笔历史操作，不能自动选择。 */
  private legacyModelKey(req: { roomId: string; turnId: string | null; idempotencyKey: string }, kind: string): string | null | false {
    // 同一有效回合中曾受理的操作自身是最精确的旧身份。
    const exact = `tool:${req.turnId ?? 'noturn'}:${req.idempotencyKey}`;
    const foundInTurn = this.db.prepare(`SELECT json_extract(payload_ref,'$.path') AS path FROM outbox
      WHERE target=? AND operation_key=? AND state IN ('pending','unknown_outcome','acked')`)
      .get(CONTENT_OPERATION_TARGET, MODEL_OPERATION_PREFIX + exact) as { path: string } | undefined;
    if (foundInTurn && ownerTypeOf(foundInTurn.path) === kind) {
      if (!req.turnId && this.db.prepare('SELECT 1 FROM conversations WHERE id<>? LIMIT 1').get(req.roomId)) return false;
      return exact;
    }

    // 老键没有房间字段。沿旧键中的 turn ID 与宿主的回合归属关联；键值整体比较保留任何冒号。
    const entries = this.db.prepare(`SELECT o.operation_key, json_extract(o.payload_ref,'$.path') AS path
      FROM turns t JOIN outbox o ON o.target=? AND o.operation_key=? || t.id || ':' || ?
      WHERE t.conversation_id=? AND o.state IN ('pending','unknown_outcome','acked')`)
      .all(CONTENT_OPERATION_TARGET, LEGACY_MODEL_OPERATION_PREFIX, req.idempotencyKey, req.roomId) as Array<{ operation_key: string; path: string }>;
    const matching = entries.filter(entry => ownerTypeOf(entry.path) === kind);
    if (matching.length > 1) return false;
    return matching[0]?.operation_key.slice(MODEL_OPERATION_PREFIX.length) ?? null;
  }

  /** 浏览器代理与模型写工具共用入口。GET 不经此处（无写协调）。 */
  async write(req: ContentWriteRequest, preserveModelIdentity = false, heartbeat?: HeartbeatContentBinding): Promise<ContentWriteResult> {
    const key = req.headers['idempotency-key'];
    if (!key) return { status: 400, body: { error: { code: 'missing_idempotency', message: '写请求必须带 Idempotency-Key' } } };
    const opKey = `content:${req.actor}:${key}`;
    const currentIntent: IntentPayload = { actor: req.actor, method: req.method, path: req.path.split('?')[0]!, body: req.body, if_match: req.headers['if-match'] };
    const ownerType = ownerTypeOf(currentIntent.path);
    const bind = () => {
      if (preserveModelIdentity && req.actor === 'jiaming') bindHeartbeatContentOperation(this.db, heartbeat, opKey, ownerType);
    };

    // ⓪ 本地已接受身份边界（RF02，复审 20261106）：pending/unknown 意图=操作已被本宿主
    // 接受（意图+pin 已持久、结果未收口）。此时同键异参不得借“远端尚无回执”改写已
    // 接受操作——拒 409；同参重试与恢复 tick 走同一条“推进已接受操作”路径
    // （RF2-01，复审 20261106 第二轮：先核对原操作事实再重放/确认，不再有绕过
    // 结果核对的直达 dispatch 快速路径——HTTP 状态不是原操作事实）。
    const accepted = this.db.prepare(`SELECT state, payload_ref FROM outbox
      WHERE target=? AND operation_key=? AND (state IN ('pending','unknown_outcome') OR (? AND state='acked'))`)
      .get(CONTENT_OPERATION_TARGET, opKey, Number(preserveModelIdentity)) as { state: string; payload_ref: string } | undefined;
    if (accepted) {
      const persisted = JSON.parse(accepted.payload_ref) as IntentPayload;
      if (intentFingerprint(persisted, preserveModelIdentity) !== intentFingerprint(currentIntent, preserveModelIdentity)) return OPERATION_CONFLICT;
      bind(); // the exact command already owns a durable intent
      const advanced = await this.advanceAccepted(opKey);
      return advanced ?? { status: 504, body: { error: { code: 'content_write_unknown', message: '内容服务响应未知；操作已持久，将按原身份恢复收口（同键重试安全）' } } };
    }

    // ① 同操作回查：旧成功回放原回执——不做资产校验（HOST_REPLAY_ORDER：不能被旧 unavailable 挡住）
    let resolved;
    try {
      resolved = await resolveContentOperation(this.client, { actor: req.actor, method: req.method, path: req.path.split('?')[0]!, body: req.body, idempotencyKey: key, ifMatch: req.headers['if-match'] });
    } catch (err) {
      this.logger.warn('content_resolve_failed', { code: stableErrorCode(err), detail: String((err as Error).message ?? err).slice(0, 140) });
      return { status: 503, body: { error: { code: 'content_unreachable', message: '内容服务不可达，稍后重试（原操作未提交）', detail: String((err as Error).message ?? err).slice(0, 140) } } };
    }
    if (resolved.outcome !== 'new') {
      if (preserveModelIdentity && resolved.outcome === 'replay' && resolved.status >= 200 && resolved.status < 300) {
        tx(this.db, () => {
          bind();
          settleHeartbeatContentReceipt(this.db, opKey, ownerType, hasObjectId(resolved.body) ? 'committed' : 'partial', resolved.body);
        });
      }
      if (preserveModelIdentity && resolved.outcome === 'replay' && resolved.status >= 200 && resolved.status < 300 && !hasObjectId(resolved.body)) {
        return committedReceiptPending(resolved.status);
      }
      // RR4-W3：同操作成功重放（本宿主此前已收口，或崩溃前 content 已提交）——用户
      // 发起的存档创建经同一登记入口幂等补齐（多数路径已登记，UNIQUE 吞并）。
      this.registerArchiveNoticeIfUserCreate(currentIntent, key, resolved.status, resolved.body);
      if (resolved.outcome === 'replay') this.recordHeartbeatDeletion(currentIntent, resolved.status, resolved.body,opKey);
      return { status: resolved.status, body: resolved.body };
    }

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
    const invalidCreation = await this.validateCreationWork(currentIntent);
    if (invalidCreation) return invalidCreation;

    // ③ HTTP 前持久意图 + pin（同一本地事务；失败=操作未被接受，不提交 content）。
    //    R3-C01：同键异参在事务内权威判定——并发下第二个异参请求在此处得到 409，
    //    不再回放第一个命令的回执。
    let accept: 'new' | 'kept' | 'conflict';
    try {
      accept = tx(this.db, () => {
        const decision = this.upsertIntent(opKey, currentIntent, candidates, preserveModelIdentity);
        if (decision !== 'conflict') bind();
        return decision;
      });
    } catch (err) {
      this.logger.warn('content_intent_persist_failed', { code: stableErrorCode(err), detail: String((err as Error).message ?? err).slice(0, 140) });
      return { status: 503, body: { error: { code: 'content_intent_persist_failed', message: '本地意图登记失败，操作未提交（可原键重试）' } } };
    }
    if (accept === 'conflict') return OPERATION_CONFLICT;
    if (accept === 'kept' && preserveModelIdentity) {
      return await this.advanceAccepted(opKey) ?? { status: 504, body: { error: { code: 'content_write_unknown' } } };
    }

    // ④ 提交——只执行已持久且匹配的原意图（upsert 对 failed/acked 重开时即当前请求）
    return this.dispatchPinned(opKey, this.intentOf(opKey) ?? currentIntent);
  }

  /** Host is the authority for actual asset MIME/content; Content owns the collection rule.
   * Check only a new write, after receipt resolution, so old work references still replay unchanged. */
  private async validateCreationWork(intent: IntentPayload): Promise<ContentWriteResult | null> {
    if (intent.method === 'DELETE' || !/^\/api\/v1\/content\/creations(?:\/[^/]+)?$/.test(intent.path)) return null;
    const body = intent.body ?? {};
    if (typeof body.work_asset_id !== 'string' && typeof body.work_kind !== 'string') return null;
    let workAsset = body.work_asset_id;
    let workKind = body.work_kind;
    let hasBucket = typeof body.bucket_id === 'string' && !!body.bucket_id && intent.method === 'POST';
    try {
      if (intent.method === 'PUT') {
        const current = await contentForward(this.client, { method: 'GET', path: intent.path, actor: intent.actor });
        if (current.bodyFailed) return { status: 503, body: { error: { code: 'creation_unconfirmed', message: '暂不能确认原作品关系' } } };
        if (current.status !== 200) return { status: current.status, body: current.body };
        const original = current.body as { work_asset_id?: unknown; work_kind?: unknown; bucket_ref?: unknown };
        if (typeof workAsset !== 'string' || !workAsset) workAsset = original.work_asset_id;
        if (typeof workKind !== 'string') workKind = original.work_kind;
        hasBucket = original.bucket_ref != null;
        if (workAsset === original.work_asset_id && workKind === original.work_kind) return null;
      }
      // Explicit memorial buckets retain the pre-existing work contract.
      if (hasBucket || typeof workAsset !== 'string' || typeof workKind !== 'string') return null;
      const asset = this.media.getAsset(workAsset);
      const reject = (code: string, message: string): ContentWriteResult => ({ status: 422, body: { error: { code, message } } });
      if (['image/png','image/jpeg','image/webp','image/gif'].includes(asset.mime_type)) return reject('image_belongs_in_album', '纯图片请通过相册成员接口入库');
      if (asset.mime_type === 'text/html' && workKind === 'html') return null;
      if (asset.mime_type === 'image/svg+xml' && workKind === 'svg') {
        const { bytes } = await this.media.readContentResolvingMaster(workAsset);
        const classification = classifySvg(bytes);
        if (classification === 'code') return null;
        return reject(classification === 'image' ? 'image_belongs_in_album' : 'svg_classification_unavailable',
          classification === 'image' ? '静态 SVG 请归入相册，不重复创建作品关系' : '无法确认 SVG 是可运行代码作品');
      }
      return reject('work_kind_mismatch', '作品类型与实际资产格式不一致');
    } catch (err) {
      if (err instanceof MediaError) return { status: err.httpStatus, body: { error: { code: err.code.toLowerCase(), message: err.message } } };
      return { status: 503, body: { error: { code: 'creation_unconfirmed', message: '暂不能确认作品实际类型' } } };
    }
  }

  /** RF2-01（复审 20261106 第二轮）：推进一个已接受操作——HTTP 同参重试与恢复 tick
   *  共用同一条路径：先核对原操作事实（resolve），回执在则确认收口、确无回执才重放；
   *  身份不一致标待核；本次传输/鉴权失败只推进 attempt，不改变原操作状态。
   *  返回推进结果供 HTTP 调用方如实回执；null=意图已不在（被并发收口）。 */
  private async advanceAccepted(opKey: string): Promise<ContentWriteResult | null> {
    const row = this.db.prepare('SELECT id, state, payload_ref, last_error FROM outbox WHERE target = ? AND operation_key = ?')
      .get(CONTENT_OPERATION_TARGET, opKey) as { id: string; state: string; payload_ref: string; last_error: string | null } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload_ref) as IntentPayload;
    const previouslyCommitted = row.state === 'acked' || p.commit_observed === 1
      || row.last_error === 'incomplete_success_receipt' || row.last_error === 'snapshot_unavailable';
    const idem = opKey.slice(`content:${p.actor}:`.length);
    try {
      const resolved = await resolveContentOperation(this.client, { actor: p.actor, method: p.method, path: p.path, body: p.body, idempotencyKey: idem, ifMatch: p.if_match });
      if (resolved.outcome === 'replay') {
        if (resolved.status >= 200 && resolved.status < 300 && !hasObjectId(resolved.body)) {
          this.markUnknown(opKey, new Error('incomplete_success_receipt'), true);
          return committedReceiptPending(resolved.status);
        }
        // RR4-W3：恢复确认成功（回执在=content 保存成功的可信证据）——补登记原本
        // 漏掉的那份用户通知。登记在快照确认**之前**（快照/M 投影不拖延已确定的
        // 成功通知）；登记失败抛出→本 catch 标 unknown，恢复链沿原键再来。
        this.registerArchiveNoticeIfUserCreate(p, idem, resolved.status, resolved.body);
        this.recordHeartbeatDeletion(p, resolved.status, resolved.body,opKey);
        // 原操作已提交：确认映射收口（快照不可达=保留，下轮再试）
        await this.confirmOperation(opKey, { status: resolved.status, body: resolved.body });
        return { status: resolved.status, body: resolved.body };
      }
      if (resolved.outcome === 'new') {
        // 本宿主已看见提交成功时，远端暂缺回执不构成重新提交的授权。
        if (previouslyCommitted) return committedReceiptPending();
        return await this.dispatchPinned(opKey, p);
      }
      // conflict/legacy_unresolved：身份与原意图不一致——保留意图与 pin，标错误待人工
      this.db.prepare("UPDATE outbox SET last_error = ?, updated_at = ? WHERE id = ?").run(`resolve:${resolved.outcome}`, new Date().toISOString(), row.id);
      return { status: resolved.status, body: resolved.body };
    } catch (err) {
      // 本次核对不可达/鉴权失败＝推进失败，不是原操作事实：保持原状态（unknown 由
      // 恢复消费者按原身份继续收口），有界累计 attempt
      this.markUnknown(opKey, err as Error, previouslyCommitted);
      this.logger.warn('content_advance_failed', { operation: opKey, code: stableErrorCode(err) });
      if (previouslyCommitted) return committedReceiptPending();
      return { status: 503, body: { error: { code: 'content_unreachable', message: '内容服务本次不可达/拒绝凭据；原操作已持久并将按原身份恢复收口（同键重试安全）', detail: String((err as Error).message ?? err).slice(0, 140) } } };
    }
  }

  /** 已有意图的提交与收口（advanceAccepted 与恢复消费者共用）。调用前提：意图+pin 已持久。 */
  private async dispatchPinned(opKey: string, intent: IntentPayload): Promise<ContentWriteResult> {
    const idemKey = opKey.slice(`content:${intent.actor}:`.length);
    let result: Awaited<ReturnType<typeof contentForward>>;
    try {
      const write = async () => {
        const response = await contentForward(this.client, {
          method: intent.method, path: intent.path, actor: intent.actor, body: intent.body,
          headers: { ...(intent.if_match !== undefined ? { 'If-Match': intent.if_match } : {}), 'Idempotency-Key': idemKey },
        });
        if (!response.bodyFailed) this.recordHeartbeatDeletion(intent, response.status, response.body,opKey);
        return response;
      };
      result = this.guardSourceMutation && intent.method !== 'POST'
        ? await this.guardSourceMutation(intent.path, write)
        : await write();
    } catch (err) {
      this.markUnknown(opKey, err as Error);
      return { status: 504, body: { error: { code: 'content_write_unknown', message: '内容服务响应未知；操作已持久，将按原身份恢复收口（同键重试安全）' } } };
    }
    if (result.status >= 500) {
      this.markUnknown(opKey, new Error(`content ${result.status}`));
      return result;
    }
    if (result.status === 401 || result.status === 403) {
      // RF2-01：鉴权层失败≠业务回执——本次请求未获准不证明原操作未提交（resolve 与
      // dispatch 之间凭据可失效）。保持 unknown 与 pin，由恢复消费者按原身份收口。
      this.markUnknown(opKey, new Error(`content auth ${result.status}`));
      return { status: 503, body: { error: { code: 'content_auth_rejected', message: '内容服务拒绝本次请求凭据；原操作状态未变（已持久，将按原身份恢复收口）', detail: JSON.stringify(result.body).slice(0, 140) } } };
    }
    if (result.status >= 400) {
      // content 业务 4xx=业务未提交（业务与回执同事务，失败零副作用）→ 定局：释放本次 pin。
      // 仅达此处的前提是 resolve 刚确认无回执（advanceAccepted/新写①），非鉴权层失败。
      this.finishFailed(opKey, `content ${result.status}`);
      return result;
    }
    const ownerType = ownerTypeOf(intent.path);
    const recoverReceipt = ownerType === 'post' || ownerType === 'comment' || ownerType === 'album_entry';
    if (result.status >= 200 && result.status < 300
        && (result.bodyFailed || (recoverReceipt && !hasObjectId(result.body)))) {
      this.markUnknown(opKey, new Error('incomplete_success_receipt'), true);
      if (recoverReceipt) {
        try {
          const resolved = await resolveContentOperation(this.client, {
            actor: intent.actor, method: intent.method, path: intent.path, body: intent.body,
            idempotencyKey: idemKey, ifMatch: intent.if_match,
          });
          if (resolved.outcome === 'replay' && resolved.status >= 200 && resolved.status < 300 && hasObjectId(resolved.body)) {
            await this.confirmOperation(opKey, resolved).catch(err => {
              this.logger.warn('content_confirm_deferred', { code: stableErrorCode(err) });
            });
            return { status: resolved.status, body: resolved.body };
          }
        } catch (err) {
          this.logger.warn('content_receipt_recheck_failed', { code: stableErrorCode(err) });
        }
      }
      return committedReceiptPending(result.status);
    }
    // RR4-W3：content 2xx=保存成功回执——用户发起的存档创建在快照确认**之前**登记
    // 通知（快照失败只拖延映射/M 投影，不拖延已确定的成功通知）。登记失败向上抛
    // （同键重试安全；不吞——否则该通知失去恢复机会）。
    this.registerArchiveNoticeIfUserCreate(intent, idemKey, result.status, result.body);
    // 成功：读权威快照确认映射。确认失败不吞——pin 仍在保护，恢复消费者收口；
    // 业务已成功，向调用方如实返回 content 结果。
    await this.confirmOperation(opKey, result).catch((err) => {
      this.logger.warn('content_confirm_deferred', { code: stableErrorCode(err) });
    });
    return result;
  }

  /** RR4-W3：用户发起存档创建的成功通知登记（唯一正本在 archive-notice.ts；
   *  非 2xx/非该形态=无动作）。 */
  private registerArchiveNoticeIfUserCreate(intent: IntentPayload, idemKey: string, status: number, body: unknown): void {
    if (status < 200 || status >= 300) return;
    if (!isUserArchiveCreate(intent.actor, intent.method, intent.path)) return;
    const b = body as { id?: string; kind?: string; messages?: unknown[] } | null;
    const convId = (intent.body as { conversation_id?: string } | undefined)?.conversation_id;
    if (typeof b?.id !== 'string' || (b.kind !== 'quarrel' && b.kind !== 'sweet') || !Array.isArray(b.messages) || typeof convId !== 'string' || !convId) return;
    registerArchiveCreatedNotice(this.db, { conversationId: convId, archiveId: b.id, kind: b.kind, count: b.messages.length, idempotencyKey: idemKey });
  }

  /** 成功后确认：快照→（单调准入）→content_owner_state+映射+ack 同一本地事务。
   *  F3：存档快照带固定消息引用/业务身份——投影意图随确认同事务登记。 */
  private async confirmOperation(opKey: string, contentResult: ContentWriteResult): Promise<boolean> {
    const intent = this.intentOf(opKey);
    if (!intent) return false;
    this.recordHeartbeatDeletion(intent, contentResult.status, contentResult.body,opKey);
    const ownerId = (contentResult.body as { id?: string } | null)?.id;
    if (typeof ownerId !== 'string' || !ownerId) { this.markUnknown(opKey, new Error('no_object_id'), true); return false; }
    const ownerType = ownerTypeOf(intent.path);
    tx(this.db, () => {
      this.db.prepare(`UPDATE outbox SET payload_ref=json_set(payload_ref,'$.commit_observed',1)
        WHERE target=? AND operation_key=? AND state IN ('pending','unknown_outcome')`).run(CONTENT_OPERATION_TARGET, opKey);
      if (intent.actor === 'jiaming' && contentResult.status >= 200 && contentResult.status < 300) {
        settleHeartbeatContentReceipt(this.db, opKey, ownerType, 'committed', contentResult.body);
      }
    });
    const snapshot = await fetchReferenceSnapshot(this.client, ownerType, ownerId);
    if (!snapshot) { this.markUnknown(opKey, new Error('snapshot_unavailable'), true); return false; } // 404/不可达≠可释放
    const archive = ownerType === 'conversation_archive' && snapshot.archive
      ? { kind: snapshot.archive.kind, by: intent.actor, count: snapshot.archive.messages.length, refs: snapshot.archive.messages.map((m) => ({ message_id: m.message_id, revision: m.revision })) }
      : undefined;
    this.confirmSnapshot(opKey, ownerType, ownerId, { ownerRevision: snapshot.owner_revision, deleted: snapshot.deleted, assetIds: snapshot.asset_ids, archive });
    return true;
  }

  /** 单调准入的快照确认：旧快照（≤已应用版本）只完成回执处理与 pin 收口，
   *  不降低 owner 版本、不撤销新关系（迟到旧确认不能复活删除/撤保护）。
   *  F3：conversation_archive 的确认在同一事务登记/更新 M 投影意图（payload 只含
   *  archive_id/类型/操作者/固定引用/删除事实，不复制正文；稳定 op 键由档案身份派生）。
   *  已 ack 且同 payload 不重开（幂等重确认不制造重复推送）。 */
  private confirmSnapshot(opKey: string, ownerType: string, ownerId: string, snapshot: { ownerRevision: number; deleted: boolean; assetIds: string[]; archive?: { kind: string; by: string; count: number; refs: Array<{ message_id: string; revision: number }> } }): void {
    const nowIso = new Date().toISOString();
    tx(this.db, () => {
      const applied = this.db.prepare('SELECT applied_revision, deleted, asset_ids_json FROM content_owner_state WHERE owner_type = ? AND owner_id = ?').get(ownerType, ownerId) as { applied_revision: number; deleted: number; asset_ids_json: string } | undefined;
      const stale = applied !== undefined && applied.applied_revision >= snapshot.ownerRevision;
      if (!stale) {
        this.media.commitContentSnapshot({ type: ownerType, id: ownerId }, { ownerRevision: snapshot.ownerRevision, assetIds: snapshot.assetIds }, opKey);
        this.db.prepare(`INSERT INTO content_owner_state(owner_type, owner_id, applied_revision, deleted, asset_ids_json, updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(owner_type, owner_id) DO UPDATE SET applied_revision = excluded.applied_revision, deleted = excluded.deleted, asset_ids_json = excluded.asset_ids_json, updated_at = excluded.updated_at`)
          .run(ownerType, ownerId, snapshot.ownerRevision, snapshot.deleted ? 1 : 0, JSON.stringify(snapshot.assetIds), nowIso);
        const heartbeatKind = snapshot.deleted ? heartbeatContentKindForOwner(ownerType) : undefined;
        if (heartbeatKind) invalidateHeartbeatContentSource(this.db, heartbeatKind, ownerId);
      } else {
        // 迟到旧确认：不动正式关系与版本锚，只收口本次操作 pin
        this.media.releaseOperationPins(opKey);
      }
      if (snapshot.archive !== undefined && !stale) {
        const opType = snapshot.deleted ? 'conversation_archived_revoked' : 'conversation_archived';
        const payload = JSON.stringify({ archive_id: ownerId, kind: snapshot.archive.kind, type: opType, by: snapshot.archive.by, count: snapshot.archive.count, refs: snapshot.archive.refs });
        this.db.prepare(
          `INSERT INTO outbox(id, operation_key, target, payload_ref, state, attempt, last_error, created_at, updated_at) VALUES (?,?,?,?,?,0,NULL,?,?)
           ON CONFLICT(target, operation_key) DO UPDATE SET
             payload_ref = excluded.payload_ref,
             state = CASE WHEN outbox.state = 'acked' AND outbox.payload_ref = excluded.payload_ref THEN 'acked' ELSE 'pending' END,
             attempt = CASE WHEN outbox.state = 'acked' AND outbox.payload_ref = excluded.payload_ref THEN outbox.attempt ELSE 0 END,
             last_error = NULL, updated_at = excluded.updated_at`,
        ).run(`cap_${ownerId.length}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, `archive-projection:${ownerId}:${opType}`, ARCHIVE_PROJECTION_TARGET, payload, 'pending', nowIso, nowIso);
      }
      this.ackIntent(opKey, stale ? applied!.applied_revision : snapshot.ownerRevision, ownerId);
    });
  }

  /** When a source DELETE already returned an authoritative business receipt,
   * invalidate the exact frozen reference before releasing its dispatch gate.
   * Snapshot reconciliation remains independently recoverable. */
  private recordHeartbeatDeletion(intent: IntentPayload, status: number, body: unknown, opKey: string): void {
    if (intent.method !== 'DELETE' || status < 200 || status >= 300) return;
    const kind = heartbeatContentKindAtPath(intent.path);
    const receipt = body as { id?: unknown; removed?: unknown; deleted?: unknown } | null;
    if (!kind || typeof receipt?.id !== 'string' || heartbeatContentSourcePath({ kind, namespace: 'content', id: receipt.id }) !== intent.path
      || !(receipt.removed === true || receipt.deleted === true)) return;
    const sourceId = receipt.id;
    tx(this.db,()=>{
      // The source receipt is already authoritative even when the media
      // snapshot remains pending. Preserve that existing commit fact across
      // the gap so a just-finishing candidate enumeration cannot re-freeze it.
      this.db.prepare(`UPDATE outbox SET payload_ref=json_set(payload_ref,'$.commit_observed',1)
        WHERE target=? AND operation_key=? AND state IN ('pending','unknown_outcome')`).run(CONTENT_OPERATION_TARGET,opKey);
      invalidateHeartbeatContentSource(this.db, kind, sourceId);
    });
  }

  /** 存量对账（G3/G5）：按 owner 当前权威快照走同一确认路径（无 pin、不重放业务写）。 */
  async reconcileOwner(ownerType: string, ownerId: string): Promise<boolean> {
    const snapshot = await fetchReferenceSnapshot(this.client, ownerType, ownerId);
    if (!snapshot) return false;
    this.reconcileKnownOwnerSnapshot(ownerType, ownerId, snapshot);
    return true;
  }

  /** Used by isolated migrations that already have the content-owned snapshot. */
  reconcileKnownOwnerSnapshot(ownerType: string, ownerId: string, snapshot: ContentReferenceSnapshot): void {
    this.confirmSnapshot(`reconcile:${ownerType}:${ownerId}`, ownerType, ownerId, { ownerRevision: snapshot.owner_revision, deleted: snapshot.deleted, assetIds: snapshot.asset_ids });
  }

  /** 接纳一个意图：'new'=新接受；'kept'=同键同参沿用既有未收口意图；'conflict'=同键异参。
   *  R3-C01（第三轮复审）：同键异参判定在**本事务内**权威执行——此前只在 write() 的
   *  await 前预检，两个并发同 key 异参请求可同时通过预检、先后进入接纳，后者静默沿用
   *  前者 payload 并回放前者的命令（受控时序复现 [201,201] 单对象）。 */
  private upsertIntent(opKey: string, intent: IntentPayload, candidates: string[], preserveModelIdentity: boolean): 'new' | 'kept' | 'conflict' {
    const nowIso = new Date().toISOString();
    const payload = JSON.stringify({ ...intent, candidate_assets: candidates });
    const existing = this.db.prepare('SELECT id, state, payload_ref FROM outbox WHERE target = ? AND operation_key = ?').get(CONTENT_OPERATION_TARGET, opKey) as { id: string; state: string; payload_ref: string } | undefined;
    let outcome: 'new' | 'kept' | 'conflict' = 'new';
    if (!existing) {
      this.db.prepare('INSERT INTO outbox(id, operation_key, target, payload_ref, state, attempt, last_error, created_at, updated_at) VALUES (?,?,?,?,?,0,NULL,?,?)')
        .run(`cout_${opKey.length}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, opKey, CONTENT_OPERATION_TARGET, payload, 'pending', nowIso, nowIso);
    } else if (existing.state === 'acked' && preserveModelIdentity) {
      const persisted = JSON.parse(existing.payload_ref) as IntentPayload;
      return intentFingerprint(persisted, true) === intentFingerprint(intent, true) ? 'kept' : 'conflict';
    } else if (existing.state === 'failed' || existing.state === 'acked') {
      // 同键再来（此前定局失败后重试，或 ack 后 content 回执已被外部清理）：以当前请求为准重开
      this.db.prepare('UPDATE outbox SET payload_ref = ?, state = ?, attempt = 0, last_error = NULL, updated_at = ? WHERE id = ?').run(payload, 'pending', nowIso, existing.id);
    } else {
      // pending/unknown_outcome：事务内权威判定——同参保留原意图；异参冲突（不得静默沿用）
      const persisted = JSON.parse(existing.payload_ref) as IntentPayload;
      if (intentFingerprint(persisted, preserveModelIdentity) !== intentFingerprint(intent, preserveModelIdentity)) return 'conflict';
      outcome = 'kept';
    }
    for (const assetId of candidates) this.media.pinAssetForOperation({ assetId, operationKey: opKey });
    return outcome;
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

  private markUnknown(opKey: string, err: Error, commitObserved = false): void {
    tx(this.db, () => {
      const changed = this.db.prepare(`UPDATE outbox SET state='unknown_outcome', attempt=attempt + 1, last_error=?, updated_at=?,
        payload_ref=CASE WHEN ? THEN json_set(payload_ref,'$.commit_observed',1) ELSE payload_ref END
        WHERE target=? AND operation_key=? AND state NOT IN ('acked','failed')`)
        .run(String(err.message ?? err).slice(0, 120), new Date().toISOString(), Number(commitObserved), CONTENT_OPERATION_TARGET, opKey);
      if (commitObserved && Number(changed.changes) > 0) {
        const intent = this.intentOf(opKey);
        if (intent?.actor === 'jiaming') settleHeartbeatContentReceipt(this.db, opKey, ownerTypeOf(intent.path), 'partial');
      }
    });
  }

  private finishFailed(opKey: string, reason: string): void {
    const nowIso = new Date().toISOString();
    tx(this.db, () => {
      this.media.releaseOperationPins(opKey);
      const changed = this.db.prepare("UPDATE outbox SET state = 'failed', attempt = attempt + 1, last_error = ?, updated_at = ? WHERE target = ? AND operation_key = ? AND state NOT IN ('acked')")
        .run(reason.slice(0, 120), nowIso, CONTENT_OPERATION_TARGET, opKey);
      if (Number(changed.changes) > 0) {
        const intent = this.intentOf(opKey);
        if (intent?.actor === 'jiaming') settleHeartbeatContentReceipt(this.db, opKey, ownerTypeOf(intent.path), 'failed');
      }
    });
  }

  // —— 恢复消费者：启动清一遍 + 周期有界处理（运行中不调用模型、不碰归档消费者） ——
  start(recoverHeartbeatProjections?: (limit: number) => Promise<void>): void {
    if (this.recoverTimer) return;
    const tick = (): void => {
      void this.recoverOnce(RECOVER_BATCH, recoverHeartbeatProjections)
        .catch((err) => this.logger.warn('content_recover_failed', { code: stableErrorCode(err) }));
    };
    tick();
    this.recoverTimer = setInterval(tick, RECOVER_INTERVAL_MS);
    this.recoverTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.recoverTimer) { clearInterval(this.recoverTimer); this.recoverTimer = null; }
    await this.recoverInFlight?.catch(() => {});
  }

  async recoverOnce(limit = RECOVER_BATCH, recoverHeartbeatProjections?: (limit: number) => Promise<void>): Promise<number> {
    if (this.recoverInFlight) return 0;
    const task = (async () => {
      // MAX_ATTEMPTS 筛选在候选 SQL 里完成：超限行不再占用批次（保留意图与 pin 等待人工/对账）
      const rows = this.db.prepare("SELECT id, operation_key, payload_ref, state, attempt FROM outbox WHERE target = ? AND state IN ('pending','unknown_outcome') AND attempt <= ? ORDER BY created_at LIMIT ?")
        .all(CONTENT_OPERATION_TARGET, MAX_ATTEMPTS, limit) as Array<OutboxRow>;
      for (const row of rows) {
        // RF2-01：恢复 tick 与 HTTP 同参重试共用同一条推进路径（advanceAccepted）
        await this.advanceAccepted(row.operation_key);
      }
      if (recoverHeartbeatProjections) {
        await recoverHeartbeatProjections(Math.min(limit, 5))
          .catch((error) => this.logger.warn('heartbeat_projection_recover_failed', { code: stableErrorCode(error) }));
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

function hasObjectId(body: unknown): boolean {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id.length > 0;
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
function intentFingerprint(intent: IntentPayload, modelOwned = false): string {
  let businessBody = intent.body;
  if (modelOwned && intent.body && ownerTypeOf(intent.path) === 'album_entry') {
    // content_sha256 由宿主从资产正本派生。回放沿用首次受理的值，即便现在无法重新取到。
    const { content_sha256: _derived, ...params } = intent.body;
    businessBody = params;
  }
  return JSON.stringify({ m: intent.method, p: intent.path, im: intent.if_match ?? null, b: canonicalJson(businessBody) ?? null });
}
