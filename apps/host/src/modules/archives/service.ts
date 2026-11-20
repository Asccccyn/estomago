// 相册重构 P4（GLM_ALBUM_REFACTOR_EXECUTION 20261108，03 存档章）：对话存档用例。
// 争吵/甜蜜存档的业务正本在 content（conversation_archives）；原文正本在 M（既有
// source 同步链），本服务不复制正文、不回读全文给模型。三类可精确定位：
// ①明确 message_ids 集合（连续/非连续均可，按会话序保序，不夹带未选消息）；
// ②最近一个已完成回合（排除当前运行中回合与后台回合——工具发起时当前回合必然在跑）。
// 无精确定位→如实拒绝，不猜范围、不扩大到整天/整段（03 §2.3）。
// 通知（03 §4）：工具发起=回执即通知；用户发起=排 host_notices，下次正常请求投递一次。
// F2/F3（复审 2026-11-09 二轮）：读写两侧都按存档钉住的 (message_id, revision) 对键；
// 建档经 ContentOperationCoordinator（接受→提交→墓碑快照确认→同事务登记 M 投影
// outbox），观察推送由既有周期消费者收口——不再 void 尽力而为。
import type { Db } from '../../db/connection.ts';
import { contentForward, readAllContentPages, type ContentClient } from '../../integrations/content/client.ts';
import { effectiveRevisionText } from '../../messages/effective-text.ts';

export type ArchiveKind = 'quarrel' | 'sweet';
export type ArchiveRef = { message_id: string; revision: number; sequence: number };

/** DBG-04（包2 11-16 版）：双边界锚点——说话人（人可读名）+ 短逐字原话。 */
export type ArchiveAnchor = { speaker: '宿主用户' | 'char'; quote: string };

/** 消歧候选：可见序位 + 少量边界文字（不回读整段）。 */
export type AnchorCandidate = { speaker: '宿主用户' | 'char'; position: number; excerpt: string };

export type AnchorRangeResolution =
  | {
      ok: true;
      refs: Array<{ message_id: string; revision: number }>;
      segments: number; // 实际段数（缺口保留，不自动补齐）
      skipped_unseen: number; // 起止之间未进入本次视野的序列数（未携带/滚窗缺口）
      excluded_excerpt_only: number; // 起止之间只见节选的消息数（存档只收整条，如实排除）
      boundary_excerpts: { start: string; end: string }; // 范围摘要：少量边界文字（不回显整段）
    }
  | {
      ok: false;
      code: 'ARCHIVE_ANCHOR_NOT_FOUND' | 'ARCHIVE_ANCHOR_AMBIGUOUS' | 'ARCHIVE_ANCHOR_EXCERPT_ONLY' | 'ARCHIVE_ANCHOR_STALE' | 'ARCHIVE_ANCHOR_REVERSED';
      detail: string;
      boundary?: 'start' | 'end';
      candidates?: AnchorCandidate[];
      conflicts?: Array<{ message_id: string; seen_revision: number; current_revision: number }>;
    };

export type ArchiveResult =
  | { ok: true; archive: { id: string; kind: ArchiveKind; count: number }; notified: 'tool_receipt' | 'queued' | 'none' }
  | { ok: false; code: string; detail: string; retryable?: boolean };

export type ArchiveOriginal = {
  message_id: string;
  revision: number;
  sequence: number | null;
  speaker: string | null;
  text: string | null;
  occurred_at: string | null;
  attachments: Array<{ asset_id: string; presentation: string; caption: string | null }>;
};

export type ArchiveOriginalsResult =
  | { ok: true; kind: string; note: string | null; items: ArchiveOriginal[] }
  | { ok: false; code: string; detail: string };

/** F3：建档写路径经既有协调器（同浏览器/模型写工具一个接受/确认/恢复面）。 */
export type ContentWritePort = {
  write(req: { method: 'POST' | 'PUT' | 'DELETE'; path: string; actor: 'qiaosheng' | 'jiaming'; body?: Record<string, unknown>; headers: Record<string, string> }): Promise<{ status: number; body: unknown }>;
};

export class ArchiveService {
  private readonly deps: { db: Db; contentClient: ContentClient | null; contentOps: ContentWritePort | null; logger: { warn(ev: string, fields?: Record<string, string | number | boolean | null | undefined>): void } | null };
  constructor(deps: { db: Db; contentClient: ContentClient | null; contentOps?: ContentWritePort | null; logger?: { warn(ev: string, fields?: Record<string, string | number | boolean | null | undefined>): void } | null }) {
    this.deps = { db: deps.db, contentClient: deps.contentClient, contentOps: deps.contentOps ?? null, logger: deps.logger ?? null };
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

  /** DBG-04 定位③：双边界锚点解析。作用域=ctx.seenMessages（发起请求**实际装载**的
   *  (消息,修订) 清单，D13 口径——模型不能靠自报"我看过"扩大范围）；边界=说话人+短
   *  逐字原话，只在真实原文（含语音可信转写，与引语核对同一 effectiveRevisionText
   *  口径）中匹配；记忆概述/模型转述中的相似句子不是原文，天然不参与。
   *  - 同消息取最新已见修订；片段区间合并，任一整条装载=完整已见（同 resolveQuoteRefs）。
   *  - 边界消息完整正文已见→锚点定位整条消息（含首尾）；只见节选=如实报告合同差异
   *    （存档只收整条），不默取隐藏正文、不静默扩范围。
   *  - 成员=起止之间（含首尾）完整已见的合格消息；只见节选的如实排除计数；未进入
   *    视野的序列保留为缺口（段数如实），不按库连续性补齐。
   *  - 多处命中/边界倒置/所见版本已被编辑：给具体原因与最小消歧候选，不静默选、
   *    不默认最新/第一项、不写入。
   *  内部读原文仅为定位核验，不产生任何已读记录（D19：回执也不把来源标为已读）。 */
  resolveAnchorRange(roomId: string, seenMessages: ReadonlyArray<{ id: string; revision: number; char_start?: number; char_end?: number }>, start: ArchiveAnchor, end: ArchiveAnchor): AnchorRangeResolution {
    type Visible = { message_id: string; sequence: number; speaker: 'owner' | 'assistant'; revision: number; text: string; currentRevision: number; full: boolean; ranges: Array<[number, number]> };
    const byId = new Map<string, Visible>();
    for (const s of seenMessages) {
      if (!s || typeof s.id !== 'string' || typeof s.revision !== 'number') continue;
      const row = this.deps.db.prepare(
        'SELECT sequence, speaker, current_revision FROM messages WHERE id = ? AND conversation_id = ?',
      ).get(s.id, roomId) as { sequence: number; speaker: string; current_revision: number } | undefined;
      if (!row || (row.speaker !== 'owner' && row.speaker !== 'assistant')) continue;
      const prev = byId.get(s.id);
      if (prev && s.revision < prev.revision) continue; // 旧修订片段不把权限拼到新正文上
      const rev = this.deps.db.prepare('SELECT content FROM message_revisions WHERE message_id = ? AND revision = ?').get(s.id, s.revision) as { content: string } | undefined;
      if (!rev) continue;
      const text = effectiveRevisionText(this.deps.db, s.id, s.revision, rev.content);
      if (text.trim().length === 0) continue;
      const pair: [number, number] | null = typeof s.char_start === 'number' && typeof s.char_end === 'number' ? [s.char_start, s.char_end] : null;
      if (!prev || s.revision > prev.revision) {
        byId.set(s.id, { message_id: s.id, sequence: row.sequence, speaker: row.speaker as 'owner' | 'assistant', revision: s.revision, text, currentRevision: row.current_revision, full: pair === null, ranges: pair ? [pair] : [] });
      } else if (pair === null) {
        prev.full = true;
      } else {
        prev.ranges.push(pair);
      }
    }
    const visible = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
    if (visible.length === 0) return { ok: false, code: 'ARCHIVE_ANCHOR_NOT_FOUND', boundary: 'start', detail: '本次请求没有实际装载的对话视野，锚点无从解析' };

    const mergedRanges = (v: Visible): Array<[number, number]> => {
      const sorted = [...v.ranges].sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const r of sorted) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
        else merged.push([r[0], r[1]]);
      }
      return merged;
    };
    const matchBoundary = (which: 'start' | 'end', anchor: ArchiveAnchor, label: string): { ok: true; hit: Visible } | { ok: false; res: AnchorRangeResolution } => {
      const wantSpeaker: 'owner' | 'assistant' = anchor.speaker === '宿主用户' ? 'owner' : 'assistant';
      const hits: Array<{ v: Visible; occStart: number }> = [];
      for (const v of visible) {
        if (v.speaker !== wantSpeaker) continue;
        let idx = v.text.indexOf(anchor.quote);
        while (idx >= 0) {
          if (v.full) { hits.push({ v, occStart: idx }); break; }
          const startCp = utf16IndexToCodepoints(v.text, idx);
          const endCp = startCp + Array.from(anchor.quote).length;
          if (mergedRanges(v).some(([rs, re]) => startCp >= rs && endCp <= re)) { hits.push({ v, occStart: idx }); break; }
          idx = v.text.indexOf(anchor.quote, idx + 1);
        }
      }
      if (hits.length === 0) {
        return { ok: false, res: { ok: false, code: 'ARCHIVE_ANCHOR_NOT_FOUND', boundary: which, detail: `${label}锚点在本次已见范围内没有匹配的原文（说话人：${anchor.speaker}；引语必须是该消息正文的连续逐字片段）` } };
      }
      if (hits.length > 1) {
        // P1-12（Codex 审计）：候选摘录必须裁在各自已见区间内（partial 消息的邻文在节选外
        // 不可外发），并给展示一个实际上限（命中数如实报，列表截断）。
        const shown = hits.slice(0, 5).map((h) => ({ speaker: anchor.speaker, position: visible.indexOf(h.v) + 1, excerpt: excerptWithinSeen(h, anchor.quote) }));
        return { ok: false, res: { ok: false, code: 'ARCHIVE_ANCHOR_AMBIGUOUS', boundary: which, detail: `${label}引语命中 ${hits.length} 条已见消息（示前 ${shown.length} 条），未唯一定位不写入；请用更长的原话或前后文区分`, candidates: shown } };
      }
      const hit = hits[0]!.v;
      if (!hit.full) {
        return { ok: false, res: { ok: false, code: 'ARCHIVE_ANCHOR_EXCERPT_ONLY', boundary: which, detail: `${label}边界消息只见节选；当前存档只收整条消息，不能默取节选之外正文——请改用完整已见的边界消息（或明确 message_ids）` } };
      }
      if (hit.revision !== hit.currentRevision) {
        return { ok: false, res: { ok: false, code: 'ARCHIVE_ANCHOR_STALE', boundary: which, detail: `${label}边界消息在你所见版本之后已被编辑（引用失效）；请按当前版本重新定位`, conflicts: [{ message_id: hit.message_id, seen_revision: hit.revision, current_revision: hit.currentRevision }] } };
      }
      return { ok: true, hit };
    };
    const s = matchBoundary('start', start, '起点');
    if (!s.ok) return s.res;
    const e = matchBoundary('end', end, '终点');
    if (!e.ok) return e.res;
    if (s.hit.sequence > e.hit.sequence) {
      return { ok: false, code: 'ARCHIVE_ANCHOR_REVERSED', detail: `边界倒置：起点消息（第 ${visible.indexOf(s.hit) + 1} 条已见）在终点（第 ${visible.indexOf(e.hit) + 1} 条）之后` };
    }
    const inRange = visible.filter((v) => v.sequence >= s.hit.sequence && v.sequence <= e.hit.sequence);
    const members = inRange.filter((v) => v.full);
    const excerptOnly = inRange.length - members.length;
    if (members.length === 0) return { ok: false, code: 'ARCHIVE_ANCHOR_NOT_FOUND', boundary: 'start', detail: '起止之间没有可存档的完整已见消息' };
    let segments = 1;
    for (let i = 1; i < members.length; i++) {
      if (members[i]!.sequence - members[i - 1]!.sequence > 1) segments++;
    }
    return {
      ok: true,
      refs: members.map((m) => ({ message_id: m.message_id, revision: m.revision })),
      segments,
      skipped_unseen: (e.hit.sequence - s.hit.sequence + 1) - members.length - excerptOnly,
      excluded_excerpt_only: excerptOnly,
      boundary_excerpts: { start: clipExcerpt(s.hit.text), end: clipExcerpt(e.hit.text) },
    };
  }

  /** F2：已同步存档引用解析（三个读者共享的单一口径）——按存档钉住的
   *  (message_id, revision) 对键精确匹配 source_sync_receipts，返回
   *  `${message_id}@${revision}` → source_message_id（**只含请求对键**的解析结果，
   *  同消息其他修订不外溢）。旧口径只按 message_id 查全部修订：检索面把消息
   *  后续修订也当存档内容（新词命中 v2 冒充 v1 存档）、封存面把未选修订一并封存。 */
  private syncedSourceIdsForRefs(refs: Array<{ message_id: string; revision: number }>): Map<string, string> {
    const byPair = new Map<string, string>();
    const want = new Set(refs.map((r) => `${r.message_id}@${r.revision}`));
    const uniqueIds = [...new Set(refs.map((r) => r.message_id))];
    for (let i = 0; i < uniqueIds.length; i += 400) { // SQLite 绑定参数上界内分块
      const chunk = uniqueIds.slice(i, i + 400)!;
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.deps.db.prepare(
        `SELECT origin_message_id, revision, source_message_id FROM source_sync_receipts WHERE origin_message_id IN (${placeholders}) AND source_message_id IS NOT NULL`,
      ).all(...chunk) as Array<{ origin_message_id: string; revision: number; source_message_id: string }>;
      for (const r of rows) {
        const key = `${r.origin_message_id}@${r.revision}`;
        if (want.has(key)) byPair.set(key, r.source_message_id);
      }
    }
    return byPair;
  }

  /** 建档（人类/模型共用）。RR4-W3（2026-11-10 修正稿）：用户发起（actor=qiaosheng）
   *  的成功通知由协调器在**写入成功回执**处经 archive-notice.ts 幂等登记（前台/恢复/
   *  重放同一入口；本方法不再排队——单一事实源）；工具发起（jiaming）回执即通知。 */
  async createArchive(o: {
    conversationId: string; kind: ArchiveKind; rawRefs: Array<{ message_id: string; revision?: number }>;
    note?: string | null; actor: 'qiaosheng' | 'jiaming'; idempotencyKey: string | null;
  }): Promise<ArchiveResult> {
    const v = this.validateRefs(o.conversationId, o.rawRefs);
    if (!v.ok) return v;
    // R6/RR3（复审 2026-11-09）：M 原文同步收据门槛按**本次钉住的修订**精确匹配——
    // 旧实现只查 origin_message_id 存在任意收据，消息编辑出 v2 而 M 只同步过 v1 时
    // 存档凭 v1 收据成功、标记也推到 v1（选 v2 标 v1）。缺该版收据=待同步，
    // 明确拒绝并要求稍后原键重试（不提前显示存档成功）。
    const synced = this.syncedSourceIdsForRefs(v.refs);
    const missing = v.refs.filter((ref) => !synced.has(`${ref.message_id}@${ref.revision}`)).map((ref) => ref.message_id);
    if (missing.length > 0) {
      return { ok: false, code: 'ARCHIVE_SOURCE_NOT_SYNCED', detail: `${missing.length} 条消息尚未同步到 M 原文层（如刚发布）；稍后用原操作键重试`, retryable: true };
    }
    if (!this.deps.contentClient || !this.deps.contentOps) return { ok: false, code: 'CONTENT_UNAVAILABLE', detail: '内容服务未启用（存档业务正本在 content）' };
    if (!o.idempotencyKey) return { ok: false, code: 'ARCHIVE_IDEMPOTENCY_REQUIRED', detail: '建档必须带幂等键（可原键重试）' };
    // F3：经既有协调器提交——接受（意图+pin）→ 提交 → 按权威快照确认；确认的同一
    // 本地事务登记 M 投影 outbox（见 coordinator.confirmSnapshot），M observation
    // 由既有周期消费者收口。响应丢失/进程退出沿原键恢复，不再 void 尽力而为。
    const res = await this.deps.contentOps.write({
      method: 'POST', actor: o.actor, path: '/api/v1/content/archives',
      body: { conversation_id: o.conversationId, kind: o.kind, messages: v.refs, note: o.note ?? undefined },
      headers: { 'idempotency-key': o.idempotencyKey },
    });
    if (res.status !== 201 && res.status !== 200) {
      const err = (res.body as { error?: { code?: string; message?: string } }).error;
      return { ok: false, code: err?.code?.toUpperCase() ?? `HTTP_${res.status}`, detail: err?.message ?? String(res.status) };
    }
    const created = res.body as { id?: string; kind?: ArchiveKind; messages?: unknown[] };
    // RR4-A：2xx 但正文传输失败（截断/坏 JSON→body 缺字段）不冒充建档成功——协调器
    // 已按 unknown 收口，原键重试经 resolve replay 取回真实结果。
    if (typeof created.id !== 'string' || !created.id || (created.kind !== 'quarrel' && created.kind !== 'sweet')) {
      return { ok: false, code: 'CONTENT_UNPARSEABLE', detail: '存档服务响应不完整（正文传输失败）；可原键重试', retryable: true };
    }
    const messages = created.messages ?? [];
    return { ok: true, archive: { id: created.id, kind: created.kind, count: messages.length }, notified: o.actor === 'qiaosheng' ? 'queued' : 'tool_receipt' };
  }

  /** content 存档列表分页读到底——RR4-F4：改用共享读取器 readAllContentPages（取消/
   *  游标停滞/非 200 语义单点定义）；本方法只做 DTO 收窄。signal 由调用方传入（工具
   *  上下文/准备流程的取消会贯穿每页与后续 M 检索）。 */
  private async readAllArchivePages(o: { kind?: 'quarrel' | 'sweet'; conversationId: string; signal?: AbortSignal }): Promise<{ ok: true; entries: Array<{ id: string; kind: string; note: string | null; messages: Array<{ message_id: string; revision: number }> }> } | { ok: false; reason: 'cancelled' | 'failed'; status?: number }> {
    const r = await readAllContentPages<{ id: string; kind: string; note: string | null; messages?: Array<{ message_id?: string; revision?: number }> }>(this.deps.contentClient!, {
      buildPath: (cursor) => `/api/v1/content/archives?${o.kind ? `kind=${o.kind}&` : ''}conversation_id=${encodeURIComponent(o.conversationId)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      signal: o.signal,
    });
    if (!r.ok) return r;
    return {
      ok: true,
      entries: r.items.map((e) => ({ id: e.id, kind: e.kind, note: e.note, messages: (e.messages ?? []).filter((m): m is { message_id: string; revision: number } => typeof m?.message_id === 'string' && typeof m?.revision === 'number') })),
    };
  }

  /** ALB-13/R35：存档文本检索——content 存档消息集 → M source.search(include_ids)
   *  限定候选（FTS5 排序即 BM25）。命中按存档条目归并，返回有限摘录（03 §2.4：
   *  先返回说明与有限匹配原文，需要再读完整片段——深读走既有 conversation_read/原文工具，
   *  本工具不回读全文）。Qwen dense 不在 source 层（无对应索引）——如实只用 BM25，
   *  不伪造"语义检索已接"。
   *  F2（复审 2026-11-09 二轮）：①引用按存档钉住的 (message_id,revision) 对键解析——
   *  消息后续修订不进检索面，新词命中 v2 不会冒充 v1 存档；②content 存档分页读全量；
   *  ③M include_ids 上限 500——分批检索后合并命中。
   *  RR4-W2c（2026-11-10 修正稿）：分页到底（见 readAllArchivePages），无总量上限。 */
  async searchArchives(o: { conversationId: string; query: string; kind?: 'quarrel' | 'sweet'; signal?: AbortSignal; mariposa: { sourceSearch(a: { query: string; include_ids?: string[]; limit?: number }, s?: AbortSignal): Promise<{ ok: boolean; result?: Record<string, unknown>; code?: string; httpStatus?: number }> } | null }): Promise<{ state: 'matches'; items: Array<{ archive_id: string; kind: string; note: string | null; snippet: string; message_id: string }> } | { state: 'no_match' } | { state: 'unavailable'; detail: string }> {
    if (!this.deps.contentClient) return { state: 'unavailable', detail: 'content 未配置（存档业务正本缺席）' };
    if (!o.mariposa) return { state: 'unavailable', detail: 'M 客户端未装配' };
    const all = await this.readAllArchivePages({ kind: o.kind, conversationId: o.conversationId, signal: o.signal });
    if (!all.ok) return { state: 'unavailable', detail: all.reason === 'cancelled' ? '已取消' : `存档列表分页读取失败${all.status !== undefined ? `（${all.status}）` : ''}` };
    const entries = all.entries;
    const pairToSource = this.syncedSourceIdsForRefs(entries.flatMap((e) => e.messages));
    const smToEntry = new Map<string, { archive_id: string; kind: string; note: string | null }>();
    for (const e of entries) {
      for (const m of e.messages) {
        const sm = pairToSource.get(`${m.message_id}@${m.revision}`);
        if (sm !== undefined && !smToEntry.has(sm)) smToEntry.set(sm, { archive_id: e.id, kind: e.kind, note: e.note });
      }
    }
    if (smToEntry.size === 0) return { state: 'no_match' };
    const includeIds = [...smToEntry.keys()];
    let hits: Array<{ message_id?: string; excerpt?: string; text?: string }> = [];
    try {
      for (let i = 0; i < includeIds.length; i += 500) { // M include_ids 合同上限 500
        if (o.signal?.aborted) return { state: 'unavailable', detail: '已取消' };
        const r = await o.mariposa.sourceSearch({ query: o.query, include_ids: includeIds.slice(i, i + 500), limit: 20 }, o.signal);
        if (!r.ok) return { state: 'unavailable', detail: `M 检索被拒（${r.code ?? r.httpStatus ?? 'unknown'}）` };
        hits = hits.concat(((r.result as { hits?: unknown })?.hits ?? []) as Array<{ message_id?: string; excerpt?: string; text?: string }>);
      }
    } catch {
      return { state: 'unavailable', detail: o.signal?.aborted ? '已取消' : 'M 检索暂不可达' };
    }
    const out: Array<{ archive_id: string; kind: string; note: string | null; snippet: string; message_id: string }> = [];
    const seenArchive = new Set<string>();
    for (const h of hits) {
      const sm = typeof h.message_id === 'string' ? h.message_id : null;
      const entry = sm !== null ? smToEntry.get(sm) : undefined;
      if (!entry || !sm) continue;
      const snippetRaw = (h.excerpt ?? h.text ?? '').toString().slice(0, 160);
      if (!seenArchive.has(entry.archive_id) || out.length < 5) {
        const existing = out.find((x) => x.archive_id === entry.archive_id);
        if (existing && seenArchive.has(entry.archive_id)) { if (existing.snippet.length < 80 && snippetRaw) existing.snippet = snippetRaw; continue; }
        seenArchive.add(entry.archive_id);
        out.push({ archive_id: entry.archive_id, kind: entry.kind, note: entry.note, snippet: snippetRaw, message_id: sm });
      }
      if (out.length >= 5) break;
    }
    if (out.length === 0) return { state: 'no_match' };
    return { state: 'matches', items: out };
  }

  /** ALB-10/R28：争吵封存的权威消息范围 → M source 引用集（sm_id）。
   *  R6 精确封存（复审 2026-11-08）：content 不可达=reachable:false——调用方决定降级
   *  （自动注入暂缓，聊天不受影响），不再空集冒充已核对。只返回 kind=quarrel。
   *  F2：封存面按 (message_id,revision) 对键解析——封存 v1 不把未选的 v2 一并封存。
   *  RR4-W2d（2026-11-10 修正稿）：分页读到底（无总量上限）；complete=服务可达**且**
   *  范围已读全——与 reachable 分开，两个消费者（prepare 下推 + supervisor 终投递
   *  复核）都按 complete:false 暂缓受影响的自动注入。 */
  async quarrelBlockedSourceRefs(conversationId: string, signal?: AbortSignal): Promise<{ refs: Set<string>; reachable: boolean; complete: boolean }> {
    if (!this.deps.contentClient) return { refs: new Set(), reachable: false, complete: false };
    const all = await this.readAllArchivePages({ kind: 'quarrel', conversationId, signal }).catch(() => null);
    if (all === null || !all.ok) return { refs: new Set(), reachable: false, complete: false };
    const refs = all.entries.flatMap((e) => e.messages);
    if (refs.length === 0) return { refs: new Set(), reachable: true, complete: true };
    const pairToSource = this.syncedSourceIdsForRefs(refs);
    return { refs: new Set(pairToSource.values()), reachable: true, complete: true };
  }

  /** R6 存档打开链（R35）：存档详情的消息引用 → E 库固定版本正文（只读）。
   *  逐条按存档时钉住的 revision 取修订正文；正文缺席（极端：修订被清理）如实置
   *  null，不拿最新版本冒充固定版本。
   *  F2（复审 2026-11-09 二轮）：同修订的附件引用一并返回（message_attachments 按
   *  (message,revision,position) 固定）——前端用既有 /assets/:id/content 媒体代理
   *  渲染图片；不取当前修订附件替代存档版，不因只回文字丢图。 */
  async archiveOriginals(conversationId: string, archiveId: string, opts: {
    actor?: 'qiaosheng' | 'jiaming'; signal?: AbortSignal;
  } = {}): Promise<ArchiveOriginalsResult> {
    if (!this.deps.contentClient) return { ok: false, code: 'CONTENT_UNAVAILABLE', detail: '内容服务未启用（存档业务正本在 content）' };
    let detail: Awaited<ReturnType<typeof contentForward>>;
    try {
      detail = await contentForward(this.deps.contentClient, {
        method: 'GET', actor: opts.actor ?? 'qiaosheng',
        path: `/api/v1/content/archives/${encodeURIComponent(archiveId)}`, signal: opts.signal,
      });
    } catch {
      return { ok: false, code: 'CONTENT_UNREACHABLE', detail: '内容服务暂不可达' };
    }
    if (detail.status !== 200) return { ok: false, code: `HTTP_${detail.status}`, detail: '存档不存在或不可读' };
    if (detail.bodyFailed) return { ok: false, code: 'CONTENT_UNREACHABLE', detail: '存档详情响应不完整' };
    const dto = detail.body as { conversation_id?: string; kind?: string; note?: string | null; messages?: Array<{ message_id?: string; revision?: number; sequence?: number }> };
    if (dto.conversation_id !== conversationId) return { ok: false, code: 'ARCHIVE_CONVERSATION_MISMATCH', detail: '存档不属于当前会话' };
    const out: ArchiveOriginal[] = [];
    for (const m of dto.messages ?? []) {
      if (typeof m.message_id !== 'string' || typeof m.revision !== 'number') continue;
      const row = this.deps.db.prepare(
        'SELECT m.sequence, m.speaker, m.created_at, r.content FROM messages m LEFT JOIN message_revisions r ON r.message_id = m.id AND r.revision = ? WHERE m.id = ? AND m.conversation_id = ?',
      ).get(m.revision, m.message_id, conversationId) as { sequence: number; speaker: string; created_at: string; content: string | null } | undefined;
      if (!row) {
        // 模型游标按存档成员顺序续页。缺失消息仍占原来的位置，但没有正文或说话人。
        if (opts.actor === 'jiaming') out.push({
          message_id: m.message_id, revision: m.revision, sequence: m.sequence ?? null,
          speaker: null, text: null, occurred_at: null, attachments: [],
        });
        continue;
      }
      const atts = this.deps.db.prepare(
        'SELECT asset_id, presentation, caption FROM message_attachments WHERE message_id = ? AND revision = ? ORDER BY position',
      ).all(m.message_id, m.revision) as Array<{ asset_id: string; presentation: string; caption: string | null }>;
      out.push({ message_id: m.message_id, revision: m.revision, sequence: row.sequence ?? null, speaker: row.speaker ?? null, text: row.content ?? null, occurred_at: row.created_at ?? null, attachments: atts });
    }
    out.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    return { ok: true, kind: dto.kind ?? 'quarrel', note: dto.note ?? null, items: out };
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

/** UTF-16 下标→码点数（与 memory/service.ts 的引语核对同一换算口径：已见片段
 *  范围 SeenRef.char_* 是码点半开区间）。 */
function utf16IndexToCodepoints(s: string, utf16Index: number): number {
  let cp = 0;
  let i = 0;
  while (i < utf16Index) {
    const code = s.charCodeAt(i);
    i += code >= 0xd800 && code <= 0xdbff && i + 1 < s.length ? 2 : 1;
    cp++;
  }
  return cp;
}

/** 消歧候选摘录：命中处前后少量文字（不回读整段）。P1-12（Codex 审计）：只见节选的
 *  消息必须裁在其已见区间内取邻文——旧实现从完整修订取左右文，把节选外文字送进候选。
 *  full 消息窗口照旧；partial 消息窗口=包含命中的那个已见区间内的裁剪。 */
function excerptWithinSeen(h: { v: { text: string; full: boolean; ranges: Array<[number, number]> }; occStart: number }, quote: string): string {
  const text = h.v.text;
  if (h.v.full) {
    const from = Math.max(0, h.occStart - 10);
    const to = h.occStart + quote.length + 14;
    const raw = text.slice(from, to).replace(/\s+/g, ' ').trim();
    return `${from > 0 ? '…' : ''}${raw}${to < text.length ? '…' : ''}`.slice(0, 60);
  }
  // 码点区间 → 区间文本；在区间文本内定位命中并取窗口（窗口天然不越出已见范围）
  const cps = Array.from(text);
  const occCpStart = utf16IndexToCodepoints(text, h.occStart);
  const occCpEnd = occCpStart + Array.from(quote).length;
  const range = h.v.ranges.map(([a, b]) => [a, b] as [number, number]).find(([rs, re]) => occCpStart >= rs && occCpEnd <= re);
  if (!range) return quote.slice(0, 60); // 命中区间缺失（构造上不应发生）：只回引语本身，不外发未核实邻文
  const segText = cps.slice(range[0], range[1]).join('');
  const occInSeg = Array.from(text.slice(0, h.occStart)).length - range[0]; // 命中在区间文本内的码点偏移
  const from = Math.max(0, occInSeg - 10);
  const to = occInSeg + Array.from(quote).length + 14;
  const raw = Array.from(segText).slice(from, to).join('').replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${raw}${to < Array.from(segText).length ? '…' : ''}`.slice(0, 60);
}

/** 回执范围摘要：边界消息开头少量文字（成功回执不回显整段）。 */
function clipExcerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 24);
}
