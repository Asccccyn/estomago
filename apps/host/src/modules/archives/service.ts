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

  /** 信封装配时取走待投递通知（读+标记同调用；SDK 会话前缀保留已发内容→重试不重复）。 */
  takePendingNotices(conversationId: string): string[] {
    const rows = this.deps.db.prepare('SELECT id, payload_json FROM host_notices WHERE conversation_id = ? AND delivered_at IS NULL ORDER BY created_at, rowid').all(conversationId) as Array<{ id: string; payload_json: string }>;
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    const out: string[] = [];
    for (const r of rows) {
      this.deps.db.prepare('UPDATE host_notices SET delivered_at = ? WHERE id = ?').run(now, r.id);
      const p = JSON.parse(r.payload_json) as { text?: string };
      out.push(typeof p.text === 'string' ? p.text : '[系统通知]');
    }
    return out;
  }
}
