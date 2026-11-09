// 相册重构 P4（GLM_ALBUM_REFACTOR_EXECUTION 20261108，03 存档章）：对话存档用例。
// 争吵/甜蜜存档的业务正本在 content（conversation_archives）；原文正本在 M（既有
// source 同步链），本服务不复制正文、不回读全文给模型。三类可精确定位：
// ①明确 message_ids 集合（连续/非连续均可，按会话序保序，不夹带未选消息）；
// ②最近一个已完成回合（排除当前运行中回合与后台回合——工具发起时当前回合必然在跑）。
// 无精确定位→如实拒绝，不猜范围、不扩大到整天/整段（03 §2.3）。
// 通知（03 §4）：工具发起=回执即通知；用户发起=排 host_notices，下次正常请求投递一次。
import type { Db } from '../../db/connection.ts';
import { genId } from '../../util/id.ts';
import { contentForward, type ContentClient } from '../../integrations/content/client.ts';

export type ArchiveKind = 'quarrel' | 'sweet';
export type ArchiveRef = { message_id: string; revision: number; sequence: number };

export type ArchiveResult =
  | { ok: true; archive: { id: string; kind: ArchiveKind; count: number }; notified: 'tool_receipt' | 'queued' | 'none' }
  | { ok: false; code: string; detail: string; retryable?: boolean };

/** R6（复审 2026-11-08）：M 附属元数据推送端口——存档事实经 source.attachments.sync
 *  （kind=observation）落 M，原文页"已存档"标记与存档总览读同一投影（ALB-03 链路）。 */
export type ArchiveAttachmentsPort = {
  attachmentsSync(args: { stream_id: string; origin_message_id: string; revision: number; kind: 'observation'; payload: Record<string, unknown>; operation_id: string }, signal?: AbortSignal): Promise<{ ok: boolean; code?: string }>;
};

export class ArchiveService {
  private readonly deps: { db: Db; contentClient: ContentClient | null; attachments: ArchiveAttachmentsPort | null; streamId: string; logger: { warn(ev: string, fields?: Record<string, string | number | boolean | null | undefined>): void } | null };
  constructor(deps: { db: Db; contentClient: ContentClient | null; attachments?: ArchiveAttachmentsPort | null; streamId?: string; logger?: { warn(ev: string, fields?: Record<string, string | number | boolean | null | undefined>): void } | null }) {
    this.deps = { db: deps.db, contentClient: deps.contentClient, attachments: deps.attachments ?? null, streamId: deps.streamId ?? 'estomago-primary-live', logger: deps.logger ?? null };
  }

  /** 引用校验：消息真实存在、修订真实存在、assistant 已发布（owner 消息天然是已发布
   *  输入；未发布草稿/工具内部消息不可存档）。按 sequence 排序去重。 */
  validateRefs(conversationId: string, raw: Array<{ message_id: string; revision?: number }>): { ok: true; refs: ArchiveRef[] } | { ok: false; code: string; detail: string } {
    const refs: ArchiveRef[] = [];
    const seen = new Set<string>();
    for (const it of raw) {
      if (!it || typeof it.message_id !== 'string' || !it.message_id) return { ok: false, code: 'ARCHIVE_REF_INVALID', detail: 'message_id 必填' };
      if (seen.has(it.message_id)) continue;
      seen.add(it.message_id);
      const row = this.deps.db.prepare(
        `SELECT m.sequence, m.speaker, m.kind, m.published_at, m.current_revision
         FROM messages m WHERE m.id = ? AND m.conversation_id = ?`,
      ).get(it.message_id, conversationId) as { sequence: number; speaker: string; kind: string; published_at: string | null; current_revision: number } | undefined;
      if (!row) return { ok: false, code: 'ARCHIVE_MESSAGE_UNKNOWN', detail: `消息不存在或不属于当前会话：${it.message_id}` };
      if (row.speaker === 'system') return { ok: false, code: 'ARCHIVE_FORBIDDEN_MESSAGE', detail: '系统/工具内部消息不可存档' };
      if (row.speaker === 'assistant' && !row.published_at) return { ok: false, code: 'ARCHIVE_FORBIDDEN_MESSAGE', detail: '未发布的助手输出不可存档（草稿不算已发布对话）' };
      const wantRev = typeof it.revision === 'number' ? it.revision : row.current_revision;
      const rev = this.deps.db.prepare('SELECT revision FROM message_revisions WHERE message_id = ? AND revision = ?').get(it.message_id, wantRev) as { revision: number } | undefined;
      if (!rev) return { ok: false, code: 'ARCHIVE_REVISION_UNKNOWN', detail: `修订不存在：${it.message_id}@${wantRev}` };
      refs.push({ message_id: it.message_id, revision: wantRev, sequence: row.sequence });
    }
    if (refs.length === 0) return { ok: false, code: 'ARCHIVE_EMPTY', detail: '存档必须引用至少一条消息' };
    refs.sort((a, b) => a.sequence - b.sequence);
    return { ok: true, refs };
  }

  /** 最近一个已完成回合的消息引用（模型工具定位②）。排除 excludeTurnId（当前回合）；
   *  只认 chat 触发的已完成回合；回合=输入消息+该回合全部已发布助手消息，按会话序。 */
  latestCompletedTurnRefs(conversationId: string, excludeTurnId: string | null): ArchiveRef[] | null {
    const turn = this.deps.db.prepare(
      `SELECT id FROM turns WHERE conversation_id = ? AND state = 'completed' AND id != ?
        AND trigger IN ('user_input','chat')
        ORDER BY completed_at DESC, rowid DESC LIMIT 1`,
    ).get(conversationId, excludeTurnId ?? '') as { id: string } | undefined;
    if (!turn) return null;
    const rows = this.deps.db.prepare(
      `SELECT m.id, m.current_revision, m.sequence, m.speaker, m.published_at
       FROM messages m WHERE m.conversation_id = ? AND m.turn_id = ? AND m.speaker IN ('owner','assistant')
       ORDER BY m.sequence`,
    ).all(conversationId, turn.id) as Array<{ id: string; current_revision: number; sequence: number; speaker: string; published_at: string | null }>;
    const refs: ArchiveRef[] = [];
    for (const r of rows) {
      if (r.speaker === 'assistant' && !r.published_at) continue; // 未发布尾巴不存
      refs.push({ message_id: r.id, revision: r.current_revision, sequence: r.sequence });
    }
    return refs.length > 0 ? refs : null;
  }

  /** 建档（人类/模型共用）。notifyModel：'event'=用户发起（排 host_notices，下次请求
   *  投递一次）；'none'=工具发起（调用方回执即通知，不排队，03 §4.2 单通道）。 */
  async createArchive(o: {
    conversationId: string; kind: ArchiveKind; rawRefs: Array<{ message_id: string; revision?: number }>;
    note?: string | null; actor: 'qiaosheng' | 'jiaming'; notifyModel: 'event' | 'none'; idempotencyKey: string | null;
  }): Promise<ArchiveResult> {
    const v = this.validateRefs(o.conversationId, o.rawRefs);
    if (!v.ok) return v;
    // R6（复审 2026-11-08）：M 原文同步收据门槛——存档的最终打开依赖 M 确定版本；
    // 任一引用无收据=待同步，明确拒绝并要求稍后原键重试（不提前显示存档成功）。
    const placeholders = v.refs.map(() => '?').join(',');
    const missing = (this.deps.db.prepare(
      `SELECT m.id FROM messages m WHERE m.id IN (${placeholders})
       AND NOT EXISTS (SELECT 1 FROM source_sync_receipts r WHERE r.origin_message_id = m.id)`,
    ).all(...v.refs.map((r) => r.message_id)) as Array<{ id: string }>).map((r) => r.id);
    if (missing.length > 0) {
      return { ok: false, code: 'ARCHIVE_SOURCE_NOT_SYNCED', detail: `${missing.length} 条消息尚未同步到 M 原文层（如刚发布）；稍后用原操作键重试`, retryable: true };
    }
    if (!this.deps.contentClient) return { ok: false, code: 'CONTENT_UNAVAILABLE', detail: '内容服务未启用（存档业务正本在 content）' };
    let res: { status: number; body: unknown };
    try {
      res = await contentForward(this.deps.contentClient, {
        method: 'POST', actor: o.actor, path: '/api/v1/content/archives',
        body: { conversation_id: o.conversationId, kind: o.kind, messages: v.refs, note: o.note ?? undefined },
        headers: o.idempotencyKey ? { 'idempotency-key': o.idempotencyKey } : undefined,
      });
    } catch {
      return { ok: false, code: 'CONTENT_UNREACHABLE', detail: '内容服务暂不可达；存档未完成，可原键重试' };
    }
    if (res.status !== 201 && res.status !== 200) {
      const err = (res.body as { error?: { code?: string; message?: string } }).error;
      return { ok: false, code: err?.code?.toUpperCase() ?? `HTTP_${res.status}`, detail: err?.message ?? String(res.status) };
    }
    const created = res.body as { id: string; kind: ArchiveKind; messages: unknown[] };
    // R6 双标记（R31/A44）：存档事实推 M 附属元数据（尽力而为，幂等 operation_id——
    // 与 ALB-03 附件元数据同款；失败记日志不回滚存档）。revision 取该消息实际已同步
    // 的收据版本（M 端只认已入库修订）。
    if (this.deps.attachments) void this.pushArchiveObservations(created.id, o.kind, o.actor, created.messages.length, v.refs).catch(() => undefined);
    let notified: 'tool_receipt' | 'queued' = 'tool_receipt';
    if (o.notifyModel === 'event') {
      this.enqueueNotice(o.conversationId, {
        kind: 'conversation_archived',
        text: `[系统通知] ${o.actor === 'qiaosheng' ? '乔乔' : 'char'}已将 ${created.messages.length} 条对话存入「${o.kind === 'quarrel' ? '争吵' : '甜蜜'}存档」。${o.kind === 'quarrel' ? '这个话题先到这里，除非乔乔主动重提，不继续争执。' : ''}`,
        archive_id: created.id, archived_kind: o.kind, by: o.actor,
      }, o.idempotencyKey ? `archive-notice:${o.idempotencyKey}` : null);
      notified = 'queued';
    }
    return { ok: true, archive: { id: created.id, kind: created.kind, count: created.messages.length }, notified };
  }

  /** ALB-13/R35：存档文本检索——content 存档消息集 → M source.search(include_ids)
   *  限定候选（FTS5 排序即 BM25）。命中按存档条目归并，返回有限摘录（03 §2.4：
   *  先返回说明与有限匹配原文，需要再读完整片段——深读走既有 conversation_read/原文工具，
   *  本工具不回读全文）。Qwen dense 不在 source 层（无对应索引）——如实只用 BM25，
   *  不伪造"语义检索已接"。 */
  async searchArchives(o: { conversationId: string; query: string; kind?: 'quarrel' | 'sweet'; mariposa: { sourceSearch(a: { query: string; include_ids?: string[]; limit?: number }, s?: AbortSignal): Promise<{ ok: boolean; result?: Record<string, unknown>; code?: string; httpStatus?: number }> } | null }): Promise<{ state: 'matches'; items: Array<{ archive_id: string; kind: string; note: string | null; snippet: string; message_id: string }> } | { state: 'no_match' } | { state: 'unavailable'; detail: string }> {
    if (!this.deps.contentClient) return { state: 'unavailable', detail: 'content 未配置（存档业务正本缺席）' };
    if (!o.mariposa) return { state: 'unavailable', detail: 'M 客户端未装配' };
    let entries: Array<{ id: string; kind: string; note: string | null; messages: Array<{ message_id: string }> }>;
    try {
      const res = await contentForward(this.deps.contentClient, { method: 'GET', actor: 'jiaming', path: `/api/v1/content/archives?${o.kind ? `kind=${o.kind}&` : ''}conversation_id=${encodeURIComponent(o.conversationId)}&limit=100` });
      if (res.status !== 200) return { state: 'unavailable', detail: `存档列表读取失败（${res.status}）` };
      entries = ((res.body as { items?: Array<{ id: string; kind: string; note: string | null; messages?: Array<{ message_id?: string }> }> }).items ?? [])
        .map((e) => ({ id: e.id, kind: e.kind, note: e.note, messages: (e.messages ?? []).filter((m): m is { message_id: string } => typeof m?.message_id === 'string') }));
    } catch {
      return { state: 'unavailable', detail: '存档列表暂不可达' };
    }
    const msgIds = entries.flatMap((e) => e.messages.map((m) => m.message_id));
    if (msgIds.length === 0) return { state: 'no_match' };
    const placeholders = msgIds.map(() => '?').join(',');
    const receiptRows = this.deps.db.prepare(`SELECT origin_message_id, source_message_id FROM source_sync_receipts WHERE origin_message_id IN (${placeholders}) AND source_message_id IS NOT NULL`).all(...msgIds) as Array<{ origin_message_id: string; source_message_id: string }>;
    const smToMsg = new Map(receiptRows.map((r) => [r.source_message_id, r.origin_message_id]));
    const msgToEntry = new Map<string, { archive_id: string; kind: string; note: string | null }>();
    for (const e of entries) for (const m of e.messages) if (!msgToEntry.has(m.message_id)) msgToEntry.set(m.message_id, { archive_id: e.id, kind: e.kind, note: e.note });
    let hits: Array<{ message_id?: string; excerpt?: string; text?: string }> = [];
    try {
      const r = await o.mariposa.sourceSearch({ query: o.query, include_ids: [...smToMsg.keys()], limit: 20 });
      if (!r.ok) return { state: 'unavailable', detail: `M 检索被拒（${r.code ?? r.httpStatus ?? 'unknown'}）` };
      hits = ((r.result as { hits?: unknown })?.hits ?? []) as Array<{ message_id?: string; excerpt?: string; text?: string }>;
    } catch {
      return { state: 'unavailable', detail: 'M 检索暂不可达' };
    }
    const out: Array<{ archive_id: string; kind: string; note: string | null; snippet: string; message_id: string }> = [];
    const seenArchive = new Set<string>();
    for (const h of hits) {
      const msgId = typeof h.message_id === 'string' ? smToMsg.get(h.message_id) : undefined;
      if (!msgId) continue;
      const entry = msgToEntry.get(msgId);
      if (!entry) continue;
      const snippetRaw = (h.excerpt ?? h.text ?? '').toString().slice(0, 160);
      if (!seenArchive.has(entry.archive_id) || out.length < 5) {
        const existing = out.find((x) => x.archive_id === entry.archive_id);
        if (existing && seenArchive.has(entry.archive_id)) { if (existing.snippet.length < 80 && snippetRaw) existing.snippet = snippetRaw; continue; }
        seenArchive.add(entry.archive_id);
        out.push({ archive_id: entry.archive_id, kind: entry.kind, note: entry.note, snippet: snippetRaw, message_id: msgId });
      }
      if (out.length >= 5) break;
    }
    if (out.length === 0) return { state: 'no_match' };
    return { state: 'matches', items: out };
  }

  /** R6：存档事实逐条消息推 M（每条一行 observation；同 operation_id 重放无新增副作用）。 */
  private async pushArchiveObservations(archiveId: string, kind: ArchiveKind, by: 'qiaosheng' | 'jiaming', count: number, refs: ArchiveRef[]): Promise<void> {
    const client = this.deps.attachments;
    if (!client) return;
    for (const ref of refs) {
      const receipt = this.deps.db.prepare('SELECT revision FROM source_sync_receipts WHERE origin_message_id = ? AND source_message_id IS NOT NULL ORDER BY revision DESC LIMIT 1').get(ref.message_id) as { revision: number } | undefined;
      if (!receipt) continue; // 建档门槛已保证有收据；此处迟到缺席=如实跳过（日志可查）
      try {
        const r = await client.attachmentsSync({
          stream_id: this.deps.streamId, origin_message_id: ref.message_id, revision: receipt.revision, kind: 'observation',
          payload: { type: 'conversation_archived', archive_id: archiveId, archive_kind: kind, count, by },
          operation_id: `att-arc:${archiveId}:${ref.message_id}`,
        });
        if (!r.ok) this.deps.logger?.warn('archive_observation_rejected', { archive_id: archiveId, message_id: ref.message_id, code: r.code ?? 'unknown' });
      } catch (err) {
        this.deps.logger?.warn('archive_observation_sync_failed', { archive_id: archiveId, message_id: ref.message_id, code: String((err as Error).message).slice(0, 80) });
      }
    }
  }

  /** ALB-10/R28：争吵封存的权威消息范围 → M source 引用集（sm_id）。
   *  R6 精确封存（复审 2026-11-08）：分页读全量存档（旧实现只取前 100 不续页，
   *  第 101 条起漏抑）；content 不可达=reachable:false——调用方决定降级（自动注入
   *  暂缓，聊天不受影响），不再空集冒充已核对。只返回 kind=quarrel（甜蜜不抑制）。 */
  async quarrelBlockedSourceRefs(conversationId: string): Promise<{ refs: Set<string>; reachable: boolean }> {
    if (!this.deps.contentClient) return { refs: new Set(), reachable: false };
    const msgIds: string[] = [];
    try {
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) { // 有界续页：10 页×100 条=1000 条封档上限，防无限循环
        const res = await contentForward(this.deps.contentClient, { method: 'GET', actor: 'jiaming', path: `/api/v1/content/archives?kind=quarrel&conversation_id=${encodeURIComponent(conversationId)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` });
        if (res.status !== 200) return { refs: new Set(), reachable: false };
        const body = res.body as { items?: Array<{ messages?: Array<{ message_id?: string }> }>; next_cursor?: string | null };
        for (const a of body.items ?? []) for (const m of a.messages ?? []) if (typeof m.message_id === 'string') msgIds.push(m.message_id);
        cursor = body.next_cursor ?? null;
        if (!cursor) break;
      }
    } catch {
      return { refs: new Set(), reachable: false };
    }
    if (msgIds.length === 0) return { refs: new Set(), reachable: true };
    const unique = [...new Set(msgIds)];
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.deps.db.prepare(`SELECT source_message_id FROM source_sync_receipts WHERE origin_message_id IN (${placeholders}) AND source_message_id IS NOT NULL`).all(...unique) as Array<{ source_message_id: string }>;
    return { refs: new Set(rows.map((r) => r.source_message_id)), reachable: true };
  }

  /** R6 存档打开链（R35）：存档详情的消息引用 → E 库固定版本正文（只读）。
   *  逐条按存档时钉住的 revision 取修订正文；正文缺席（极端：修订被清理）如实置
   *  null，不拿最新版本冒充固定版本。 */
  async archiveOriginals(conversationId: string, archiveId: string): Promise<{ ok: true; kind: string; note: string | null; items: Array<{ message_id: string; revision: number; sequence: number | null; speaker: string | null; text: string | null; occurred_at: string | null }> } | { ok: false; code: string; detail: string }> {
    if (!this.deps.contentClient) return { ok: false, code: 'CONTENT_UNAVAILABLE', detail: '内容服务未启用（存档业务正本在 content）' };
    let detail: { status: number; body: unknown };
    try {
      detail = await contentForward(this.deps.contentClient, { method: 'GET', actor: 'qiaosheng', path: `/api/v1/content/archives/${encodeURIComponent(archiveId)}` });
    } catch {
      return { ok: false, code: 'CONTENT_UNREACHABLE', detail: '内容服务暂不可达' };
    }
    if (detail.status !== 200) return { ok: false, code: `HTTP_${detail.status}`, detail: '存档不存在或不可读' };
    const dto = detail.body as { conversation_id?: string; kind?: string; note?: string | null; messages?: Array<{ message_id?: string; revision?: number; sequence?: number }> };
    if (dto.conversation_id !== conversationId) return { ok: false, code: 'ARCHIVE_CONVERSATION_MISMATCH', detail: '存档不属于当前会话' };
    const out: Array<{ message_id: string; revision: number; sequence: number | null; speaker: string | null; text: string | null; occurred_at: string | null }> = [];
    for (const m of dto.messages ?? []) {
      if (typeof m.message_id !== 'string' || typeof m.revision !== 'number') continue;
      const row = this.deps.db.prepare(
        'SELECT m.sequence, m.speaker, m.created_at, r.content FROM messages m LEFT JOIN message_revisions r ON r.message_id = m.id AND r.revision = ? WHERE m.id = ? AND m.conversation_id = ?',
      ).get(m.revision, m.message_id, conversationId) as { sequence: number; speaker: string; created_at: string; content: string | null } | undefined;
      if (!row) continue; // 引用校验在建档时已过；迟到缺席如实跳过
      out.push({ message_id: m.message_id, revision: m.revision, sequence: row.sequence ?? null, speaker: row.speaker ?? null, text: row.content ?? null, occurred_at: row.created_at ?? null });
    }
    out.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    return { ok: true, kind: dto.kind ?? 'quarrel', note: dto.note ?? null, items: out };
  }

  /** 排一次性通知（dedupe_key 幂等：同操作身份只投一次）。 */
  private enqueueNotice(conversationId: string, payload: Record<string, unknown>, dedupeKey: string | null): void {
    const now = new Date().toISOString();
    try {
      this.deps.db.prepare('INSERT INTO host_notices(id, conversation_id, kind, payload_json, dedupe_key, created_at) VALUES (?,?,?,?,?,?)')
        .run(genId('hn'), conversationId, String(payload['kind']), JSON.stringify(payload), dedupeKey, now);
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) return; // 同操作身份已有通知：幂等不重复
      throw err;
    }
  }

  /** 信封装配时取待投递通知。ALB-11（审计 2026-11-08）：默认（窗口初始化信封）取出即
   *  标记——接受"首请求失败即丢失"的窄窗口（换窗重试少）；正常轮次传 deferConfirm=true，
   *  由调用方在**实际投递证据**（该轮 provider_requests sent_at 非空）出现后经
   *  confirmNoticesDelivered 收口——取出即标记不能证明已投递。
   *  崩溃窗口内未确认→下次重取，宁可重复不静默丢。 */
  takePendingNotices(conversationId: string, deferConfirm = false): Array<{ id: string; text: string }> {
    const rows = this.deps.db.prepare('SELECT id, payload_json FROM host_notices WHERE conversation_id = ? AND delivered_at IS NULL ORDER BY created_at, rowid').all(conversationId) as Array<{ id: string; payload_json: string }>;
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    const out: Array<{ id: string; text: string }> = [];
    for (const r of rows) {
      if (!deferConfirm) this.deps.db.prepare('UPDATE host_notices SET delivered_at = ? WHERE id = ?').run(now, r.id);
      const p = JSON.parse(r.payload_json) as { text?: string };
      out.push({ id: r.id, text: typeof p.text === 'string' ? p.text : '[系统通知]' });
    }
    return out;
  }

  /** 投递证据出现后收口通知（幂等）。 */
  confirmNoticesDelivered(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(',');
    this.deps.db.prepare(`UPDATE host_notices SET delivered_at = ? WHERE id IN (${placeholders}) AND delivered_at IS NULL`).run(now, ...ids);
  }
}
