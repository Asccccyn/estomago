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
  | { ok: false; code: string; detail: string };

export class ArchiveService {
  private readonly deps: { db: Db; contentClient: ContentClient | null };
  constructor(deps: { db: Db; contentClient: ContentClient | null }) {
    this.deps = deps;
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

  /** ALB-10/R28：争吵封存的权威消息范围 → M source 引用集（sm_id）。
   *  供 E 自动浮现最终投递资格检查：命中来源的候选扣留，主动查看/手选不受影响。
   *  content 不可达=空集+如实 fail-open（聊天不受相册检索故障拖累；日志可查）。
   *  只返回 kind=quarrel（甜蜜不抑制，03 §6）。 */
  async quarrelBlockedSourceRefs(conversationId: string): Promise<Set<string>> {
    if (!this.deps.contentClient) return new Set();
    try {
      const res = await contentForward(this.deps.contentClient, { method: 'GET', actor: 'jiaming', path: `/api/v1/content/archives?kind=quarrel&conversation_id=${encodeURIComponent(conversationId)}&limit=100` });
      if (res.status !== 200) return new Set();
      const items = (res.body as { items?: Array<{ messages?: Array<{ message_id?: string }> }> }).items ?? [];
      const msgIds = items.flatMap((a) => (a.messages ?? []).map((m) => m.message_id)).filter((x): x is string => typeof x === 'string');
      if (msgIds.length === 0) return new Set();
      const placeholders = msgIds.map(() => '?').join(',');
      const rows = this.deps.db.prepare(`SELECT source_message_id FROM source_sync_receipts WHERE origin_message_id IN (${placeholders}) AND source_message_id IS NOT NULL`).all(...msgIds) as Array<{ source_message_id: string }>;
      return new Set(rows.map((r) => r.source_message_id));
    } catch {
      return new Set(); // fail-open：封存抑制不阻塞聊天（如实：本轮未过滤，日志层可查）
    }
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
