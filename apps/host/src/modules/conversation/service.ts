// modules/conversation/service.ts（P04.1）：conversation 域工具用例（conversation_read/chat_send_text/chat_send_attachment）。
// 原 HostToolExecutor 方法逐字迁移：保留实际已见范围与码点切片、正式发布 outbox、附件权限；
// memory 模块不复制聊天 SQL（D25：正本发布/读取走本域与 MessageService 窄端口）。
import type { Db } from '../../db/connection.ts';
import { sha256Hex } from '../../util/id.ts';
import type { SeenRef, ToolExecContext, ToolExecResult } from '../../capabilities/contracts.ts';

/** WP4：conversation_read 的可见消息行（owner 真实消息/已发布 assistant）——原 host-tools 局部类型随迁。 */
type ReadRow = { id: string; sequence: number; speaker: 'owner' | 'assistant'; revision: number; content: string; content_hash: string; occurred_at: string };

export class ConversationToolsService {
  private readonly db: Db;
  private readonly tz: string | null;
  private readonly messages: import('../../messages/service.ts').MessageService | null;
  private readonly media: import('../../media/assets.ts').MediaService | null;
  private readonly events: import('../../events/service.ts').EventService | null;
  private readonly archiveSync: { drainOnce(): Promise<unknown> } | null;

  constructor(deps: { db: Db; tz?: string | null; messages?: import('../../messages/service.ts').MessageService | null; media?: import('../../media/assets.ts').MediaService | null; events?: import('../../events/service.ts').EventService | null; archiveSync?: { drainOnce(): Promise<unknown> } | null }) {
    this.db = deps.db;
    this.tz = deps.tz ?? null;
    this.messages = deps.messages ?? null;
    this.media = deps.media ?? null;
    this.events = deps.events ?? null;
    this.archiveSync = deps.archiveSync ?? null;
  }

  conversationRead(args: Record<string, unknown>, ctx: ToolExecContext): ToolExecResult {
    const roomId = ctx.roomId;
    const limit = Math.min(Math.max(typeof args.limit === 'number' ? Math.floor(args.limit) : 20, 1), 50);
    // WP-04（JFA-C08）：owner 的 sticker/voice 同为可见面（占位条目+转写正文
    //  由条目形态承载）——锚点/回读不再对合法素材报"不存在"
    const VISIBLE = "(m.speaker = 'owner' AND m.kind IN ('text','multimodal','sticker','voice')) OR (m.speaker = 'assistant' AND m.published_at IS NOT NULL)";
    // 2026-10-19 她裁定（JSON 瘦身）：条目只留模型消费的字段——seq 寻址
    //（配 [N]）、rev、说话人、短时间（本地 MM-DD HH:MM，分钟精度）、
    // 正文。message_id/content_hash/sync_state 不出站（核对是系统的事）。
    const shortAt = (utcIso: string): string => {
      try {
        const f = new Intl.DateTimeFormat('en-CA', { timeZone: this.tz ?? 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        return f.format(new Date(utcIso)).replace(',', '');
      } catch { return utcIso.slice(5, 16); }
    };
    const entryOf = (row: ReadRow, fragment?: { start: number; end: number; total: number }): Record<string, unknown> => {
      const entry: Record<string, unknown> = {
        seq: row.sequence,
        rev: row.revision,
        speaker: row.speaker,
        at: shortAt(row.occurred_at),
        text: row.content,
      };
      if (fragment) {
        // 末片如实标 content_complete=true（不再发续片游标）——拼回与
        // 进度终止都依赖它，不得恒 false（曾致末片无游标死循环）
        entry.fragment = { start_char: fragment.start, end_char: fragment.end, total_chars: fragment.total, content_complete: fragment.end >= fragment.total };
        entry.text = [...row.content].slice(fragment.start, fragment.end).join('');
      }
      return entry;
    };
    const trackSeen = (row: ReadRow, fragment?: { start: number; end: number }): void => {
      if (fragment) seen.push({ id: row.id, revision: row.revision, char_start: fragment.start, char_end: fragment.end });
      else seen.push({ id: row.id, revision: row.revision });
    };
    // —— 长文分片与页预算（RRA-014 回访 2026-10-09）——
    // 分片按码点切片，拼回逐字一致；预算口径=**最终出站 JSON 真实
    // 字节（含转义）**——此前按 3B/字符估算，控制字符（\u0001 转义
    // 6B/字符）整页 18479B 击穿 16000；分片宽度从 FRAGMENT_CHARS 起
    // 折半直至放得下（最少 1 字符），信封骨架另留 ENVELOPE_RESERVE。
    const FRAGMENT_CHARS = 3000;
    const FRAGMENT_MIN_CHARS = 64;
    const OUTPUT_MAX_JSON_BYTES = 16000;
    const ENVELOPE_RESERVE_BYTES = 700;
    const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
    const seen: SeenRef[] = [];
    const entries: Array<Record<string, unknown>> = [];
    let budgetUsed = 0;
    const pageBudget = (): number => OUTPUT_MAX_JSON_BYTES - ENVELOPE_RESERVE_BYTES - budgetUsed;
    /** 装一条——**尺寸判定单口径=真实 JSON 字节**（RRA-014 根因修复，
     *  二次回访 2026-10-10：此前残留的 `cpLen<=FRAGMENT_CHARS` 码点门
     *  与整条顺延分支冲突，3001/4000 ASCII、4000 中文等"能放空页"的
     *  行既不整装也不分片——range 静默结束、older 同游标空页活锁）：
     *  ①整条放得下本页剩余 → 整装；②整条放得下空页预算 → 顺延下页
     *  整条交付（整行形状契约）；③单条超整页预算 → 分片折半。码点
     *  只作分片起始宽度（可读性上限），不再是尺寸判据。 */
    const pushEntry = (row: ReadRow): boolean => {
      const whole = entryOf(row);
      const wholeBytes = jsonBytes(whole);
      if (wholeBytes <= pageBudget()) {
        entries.push(whole);
        budgetUsed += wholeBytes;
        trackSeen(row);
        return true;
      }
      // ②整条放得下空页（单条未超整页预算）→ 顺延下页整条交付
      if (wholeBytes <= OUTPUT_MAX_JSON_BYTES - ENVELOPE_RESERVE_BYTES) {
        return false;
      }
      // ③单条超整页预算 → 分片：宽度折半至放得下；非页首时窄于
      // FRAGMENT_MIN_CHARS 的碎屑顺延（页首豁免——空页+同游标=活锁）
      const cpLen = [...row.content].length;
      let width = FRAGMENT_CHARS;
      while (width >= 1) {
        const end = Math.min(cpLen, width);
        const cand = entryOf(row, { start: 0, end, total: cpLen });
        if (end < cpLen) (cand.fragment as Record<string, unknown>).continue_cursor = { fragment: { seq: row.sequence, rev: row.revision, start_char: end } };
        if (jsonBytes(cand) <= pageBudget()) {
          if (entries.length > 0 && end < FRAGMENT_MIN_CHARS && cpLen > FRAGMENT_MIN_CHARS) return false;
          entries.push(cand);
          budgetUsed += jsonBytes(cand);
          trackSeen(row, { start: 0, end });
          return true;
        }
        width = Math.floor(width / 2);
      }
      return false;
    };

    // —— 续页游标：{older_than[+up_to]} | {newer_than[+up_to]} |
    //    {fragment:{message_id,revision,start_char}[+resume]} ——
    // RRA-014（回访 2026-10-09）：up_to 携带 range 起点的 to_sequence
    //（此前续页翻成无上界 newer_than，3..7 读到 12）；resume 携带分片
    // 所属的方向上下文（片尽后回到方向续页，链不断）。
    const cursor = (args.cursor && typeof args.cursor === 'object' && !Array.isArray(args.cursor)) ? args.cursor as Record<string, unknown> : null;
    // 二次回访（2026-10-10）：**显式空游标**（调用方回传上一页缺失的
    // next_cursor，值 null/undefined）=上一页已到末尾——返回诚实的空
    // 续页而不是"三选一必填"错误（翻尽即终止后链式调用方的最后一次
    // 探测不应 4xx；完全不带 cursor 键的调用仍走必填门）
    if ('cursor' in args && (args.cursor === null || args.cursor === undefined)) {
      return { ok: true, output: { note: '空续页（游标为空——上一页已到末尾）', entries, has_more: null }, seenAdditions: seen };
    }
    /** 条目是否携带**未完分片**（页终止标记——同页至多一个未完分片：
     *  第二个只有最后一个能进 next_cursor 链，先出现者尾段会被搁死，
     *  RRA-014 回访抓到的实际缺陷）。全文件唯一判定点。 */
    const isOpenFragment = (e: Record<string, unknown> | undefined): e is { seq: number; rev: number; fragment: { end_char: number } } => {
      const fr = (e as { fragment?: { content_complete?: boolean } } | undefined)?.fragment;
      return !!fr && fr.content_complete === false;
    };
    /** 未完分片的续页游标：先续片，片尽经 resume 回方向/范围上下文
     *  （链不断）。全文件唯一组装点。 */
    const openFragmentCursor = (
      e: { seq: number; rev: number; fragment: { end_char: number } },
      dir: 'older' | 'newer', upTo: number | null,
    ): Record<string, unknown> => ({
      fragment: { seq: e.seq, rev: e.rev, start_char: e.fragment.end_char },
      resume: { ...(dir === 'older' ? { older_than: e.seq } : { newer_than: e.seq }), ...(upTo !== null ? { up_to: upTo } : {}) },
    });
    const upToOf = (c: Record<string, unknown>): number | null =>
      typeof c.up_to === 'number' && Number.isFinite(c.up_to) && (c.up_to as number) >= 1 ? Math.floor(c.up_to as number) : null;
    if (cursor) {
      const frag = cursor.fragment as Record<string, unknown> | undefined;
      const resume = (cursor.resume && typeof cursor.resume === 'object' && !Array.isArray(cursor.resume)) ? cursor.resume as Record<string, unknown> : null;
      if (frag && typeof frag.seq === 'number' && typeof frag.rev === 'number' && typeof frag.start_char === 'number') {
        const row = this.db.prepare(
          `SELECT m.id, m.sequence, m.speaker, r.revision, r.content, r.content_hash, r.occurred_at FROM messages m
           JOIN message_revisions r ON r.message_id = m.id AND r.revision = ? WHERE m.sequence = ? AND m.conversation_id = ? AND (${VISIBLE})`,
        ).get(frag.rev, frag.seq, roomId) as ReadRow | undefined;
        if (!row) return { ok: false, output: { error_code: 'READ_CURSOR_INVALID', error: '分片游标指向的消息/修订不存在或不可读' } };
        const total = [...row.content].length;
        const start = Math.max(0, Math.min(frag.start_char, total));
        // RRA-014 回访：分片续取同样按真实 JSON 字节折半（空页预算）
        let width = FRAGMENT_CHARS;
        let e: Record<string, unknown> | null = null;
        let end = start;
        while (width >= 1) {
          end = Math.min(total, start + width);
          const cand = entryOf(row, { start, end, total });
          if (end < total) (cand.fragment as Record<string, unknown>).continue_cursor = { fragment: { seq: row.sequence, rev: row.revision, start_char: end } };
          if (jsonBytes(cand) <= OUTPUT_MAX_JSON_BYTES - ENVELOPE_RESERVE_BYTES) { e = cand; break; }
          width = Math.floor(width / 2);
        }
        if (e === null) return { ok: false, output: { error_code: 'READ_FRAGMENT_BUDGET', error: '分片在预算内放不下（异常输入）' } };
        entries.push(e);
        trackSeen(row, { start, end });
        const fragMore = end < total;
        const resumeDir = resume && typeof resume.older_than === 'number' ? 'older' : 'newer';
        const nextCursor = fragMore
          ? { fragment: { seq: row.sequence, rev: row.revision, start_char: end }, ...(resume ? { resume } : {}) }
          : resume;
        return { ok: true, output: {
          note: '同一消息的下一片（查询不变）', entries,
          has_more: fragMore ? 'fragment' : (resume ? resumeDir : null),
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
          seen_kind: 'fragment',
        }, seenAdditions: seen };
      }
      if (typeof cursor.older_than === 'number' || typeof cursor.newer_than === 'number') {
        const older = typeof cursor.older_than === 'number';
        const boundary = older ? cursor.older_than as number : cursor.newer_than as number;
        const upTo = upToOf(cursor);
        // RRA-014（回访 2026-10-09）：older 方向**按取序（降序）交付**——
        // 本页先交更靠近边界的行，交付前沿=本页最小 seq，前沿下方连续
        // 可达。此前页内升序+预算跳过后翻向无上界 newer_than：越过原
        // 边界（1..7 永不可达）且中段重复交付。
        const upToClause = upTo !== null && !older ? 'AND m.sequence <= ?' : '';
        const rows = this.db.prepare(
          `SELECT m.id, m.sequence, m.speaker, m.current_revision, r.revision, r.content, r.content_hash, r.occurred_at
           FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
           WHERE m.conversation_id = ? AND m.sequence ${older ? '<' : '>'} ? ${upToClause} AND (${VISIBLE})
           ORDER BY m.sequence ${older ? 'DESC' : 'ASC'} LIMIT ?`,
        ).all(...(upTo !== null && !older ? [roomId, boundary, upTo, limit] : [roomId, boundary, limit])) as ReadRow[];
        for (const row of rows) {
          if (!pushEntry(row) || isOpenFragment(entries[entries.length - 1])) break;
        }
        const note = `向${older ? '更早' : '更新'}方向续页（查询不变）`;
        const lastEntry = entries[entries.length - 1];
        if (isOpenFragment(lastEntry)) {
          // 本页终于未完分片：先续片，片尽回方向（resume 携带原上界）
          return { ok: true, output: {
            note, entries,
            has_more: older ? 'older' : 'newer',
            next_cursor: openFragmentCursor(lastEntry, older ? 'older' : 'newer', upTo),
          }, seenAdditions: seen };
        }
        const frontier = (lastEntry?.seq as number | undefined) ?? boundary;
        const beyond = this.db.prepare(
          `SELECT 1 AS x FROM messages m
           JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
           WHERE m.conversation_id = ? AND m.sequence ${older ? '<' : '>'} ? ${upToClause} AND (${VISIBLE})
           LIMIT 1`,
        ).get(...(upTo !== null && !older ? [roomId, frontier, upTo] : [roomId, frontier])) as { x: number } | undefined;
        const more = beyond !== undefined;
        const out: Record<string, unknown> = { note, entries, has_more: more ? (older ? 'older' : 'newer') : null };
        if (more) out.next_cursor = { ...(older ? { older_than: frontier } : { newer_than: frontier }), ...(upTo !== null ? { up_to: upTo } : {}) };
        return { ok: true, output: out, seenAdditions: seen };
      }
      return { ok: false, output: { error_code: 'READ_CURSOR_INVALID', error: '游标形状不认识（older_than/newer_than/fragment 三选一）' } };
    }

    // —— 锚点模式：around_seq ± before/after（锚点须在本房间；跨房间=找不到，不泄漏） ——
    const anchorSeqArg = typeof args.around_seq === 'number' && Number.isInteger(args.around_seq) ? args.around_seq : null;
    if (anchorSeqArg) {
      const anchor = this.db.prepare('SELECT id, sequence FROM messages WHERE sequence = ? AND conversation_id = ?').get(anchorSeqArg, roomId) as { id: string; sequence: number } | undefined;
      if (!anchor) return { ok: false, output: { error_code: 'READ_ANCHOR_NOT_FOUND', error: '锚点序号不存在（或不属于本房间）' } };
      const before = Math.min(Math.max(typeof args.before === 'number' ? Math.floor(args.before) : 5, 1), 50);
      const after = Math.min(Math.max(typeof args.after === 'number' ? Math.floor(args.after) : 5, 1), 50);
      // 指定历史修订：读不到如实报（不拿当前修订冒充）
      let anchorEntry: ReadRow | null = null;
      if (typeof args.revision === 'number') {
        const wantRev = args.revision;
        anchorEntry = this.db.prepare(
          `SELECT m.id, m.sequence, m.speaker, r.revision, r.content, r.content_hash, r.occurred_at FROM messages m
           JOIN message_revisions r ON r.message_id = m.id AND r.revision = ? WHERE m.sequence = ? AND m.conversation_id = ? AND (${VISIBLE})`,
        ).get(wantRev, anchorSeqArg, roomId) as ReadRow | null;
        if (!anchorEntry) return { ok: false, output: { error_code: 'READ_REVISION_UNAVAILABLE', error: `修订 ${wantRev} 读不到（不存在/不可读）——不以当前修订冒充` } };
      }
      const olderRows = this.db.prepare(
        `SELECT m.id, m.sequence, m.speaker, m.current_revision, r.revision, r.content, r.content_hash, r.occurred_at
         FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
         WHERE m.conversation_id = ? AND m.sequence < ? AND (${VISIBLE}) ORDER BY m.sequence DESC LIMIT ?`,
      ).all(roomId, anchor.sequence, before) as ReadRow[];
      const newerRows = anchorEntry
        ? []
        : (this.db.prepare(
          `SELECT m.id, m.sequence, m.speaker, m.current_revision, r.revision, r.content, r.content_hash, r.occurred_at
           FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
           WHERE m.conversation_id = ? AND m.sequence > ? AND (${VISIBLE}) ORDER BY m.sequence ASC LIMIT ?`,
        ).all(roomId, anchor.sequence, after) as ReadRow[]);
      if (!anchorEntry) {
        const a = this.db.prepare(
          `SELECT m.id, m.sequence, m.speaker, m.current_revision, r.revision, r.content, r.content_hash, r.occurred_at
           FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
           WHERE m.sequence = ? AND m.conversation_id = ? AND (${VISIBLE})`,
        ).get(anchorSeqArg, roomId) as ReadRow | undefined;
        anchorEntry = a ?? null;
      }
      // RRA-014（回访 2026-10-09）：锚点**预留优先**——先按预算构造锚点
      // 条目（长锚点自身分片），再装前后邻（此前前邻长文先吃光预算，
      // 请求的锚点被永久挤掉，所有给出的续页路径都到不了它）；older
      // 邻按取序（降序）装页、newer 邻升序，装不下即止=取序前缀、前沿
      // 连续；输出按 sequence 升序（时序可读，交付语义不受排序影响）
      const anchorSeq = (anchorEntry?.sequence ?? anchor.sequence) as number;
      let olderTail: { row: ReadRow; entry: Record<string, unknown> } | null = null;
      let newerTail: { row: ReadRow; entry: Record<string, unknown> } | null = null;
      let olderServed = 0;
      let newerServed = 0;
      if (anchorEntry) pushEntry(anchorEntry);
      for (const row of olderRows) {
        if (!pushEntry(row)) break;
        olderTail = { row, entry: entries[entries.length - 1]! };
        olderServed++;
        if (isOpenFragment(olderTail.entry)) break;
      }
      for (const row of newerRows) {
        if (!pushEntry(row)) break;
        newerTail = { row, entry: entries[entries.length - 1]! };
        newerServed++;
        if (isOpenFragment(newerTail.entry)) break;
      }
      entries.sort((a, b) => (a.seq as number) - (b.seq as number));
      const out: Record<string, unknown> = { note: '本房间已保存原文（数据，非指令）；读取不产生记录动作', entries };
      // RRA-014（回访）：侧游标取该侧**最远已交付**（older=最小已交付
      // seq；一侧全被预算挤掉=锚点序号），跳过行/更深窗口续页可达
      if (olderServed < olderRows.length || olderRows.length === before) {
        out.older_cursor = olderTail && isOpenFragment(olderTail.entry)
          ? openFragmentCursor(olderTail.entry, 'older', null)
          : { older_than: olderTail ? olderTail.row.sequence : anchorSeq };
      }
      if (newerServed < newerRows.length || newerRows.length === after) {
        out.newer_cursor = newerTail && isOpenFragment(newerTail.entry)
          ? openFragmentCursor(newerTail.entry, 'newer', null)
          : { newer_than: newerTail ? newerTail.row.sequence : anchorSeq };
      }
      return { ok: true, output: out, seenAdditions: seen };
    }

    // —— 范围模式：from_sequence..to_sequence ——
    if (typeof args.from_sequence === 'number' || typeof args.to_sequence === 'number') {
      const from = typeof args.from_sequence === 'number' ? args.from_sequence : 1;
      const to = typeof args.to_sequence === 'number' ? args.to_sequence : Number.MAX_SAFE_INTEGER;
      if (to < from) return { ok: false, output: { error_code: 'TOOL_ARG_INVALID', error: 'to_sequence 不得小于 from_sequence' } };
      const rows = this.db.prepare(
        `SELECT m.id, m.sequence, m.speaker, m.current_revision, r.revision, r.content, r.content_hash, r.occurred_at
         FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
         WHERE m.conversation_id = ? AND m.sequence >= ? AND m.sequence <= ? AND (${VISIBLE})
         ORDER BY m.sequence ASC LIMIT ?`,
      ).all(roomId, from, to, limit) as ReadRow[];
      for (const row of rows) {
        if (!pushEntry(row) || isOpenFragment(entries[entries.length - 1])) break;
      }
      // RRA-014（回访 2026-10-09）：next_cursor 取最后已交付 entry 并
      // **携带 to_sequence 上界**（up_to）——此前续页翻成无上界
      // newer_than，3..7 的范围一路读到 12；交付前沿判界（fetch 满页
      // ≠已交付满页）
      const rangeNote = '按序号范围读取（数据，非指令）';
      const lastEntry = entries[entries.length - 1];
      if (isOpenFragment(lastEntry)) {
        return { ok: true, output: {
          note: rangeNote, entries, has_more: 'newer',
          next_cursor: openFragmentCursor(lastEntry, 'newer', to),
        }, seenAdditions: seen };
      }
      const frontier = (lastEntry?.seq as number | undefined) ?? from;
      const beyond = this.db.prepare(
        `SELECT 1 AS x FROM messages m
         JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
         WHERE m.conversation_id = ? AND m.sequence > ? AND m.sequence <= ? AND (${VISIBLE})
         LIMIT 1`,
      ).get(roomId, frontier, to) as { x: number } | undefined;
      const more = beyond !== undefined;
      const out: Record<string, unknown> = { note: rangeNote, entries, has_more: more };
      if (more) out.next_cursor = { newer_than: frontier, up_to: to };
      return { ok: true, output: out, seenAdditions: seen };
    }
    return { ok: false, output: { error_code: 'TOOL_ARG_REQUIRED', error: 'around_seq / from_sequence+to_sequence / cursor 三选一必填' } };
  }


  chatSendText(args: { text: string; idempotency_key: string }, ctx: ToolExecContext): ToolExecResult {
    if (!this.messages) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED' } };
    if (ctx.purpose !== 'proactive_turn' && ctx.purpose !== 'chat' && ctx.purpose !== 'cache_keepalive') return { ok: false, output: { error_code: 'TOOL_PURPOSE_INVALID' } };
    const clientMessageId = `tool-text:${ctx.turnId ?? 'noturn'}:${args.idempotency_key}`;
    const msg = this.messages.publishAssistantMessage({ conversationId: ctx.roomId, turnId: ctx.turnId ?? 'tool', content: args.text, clientMessageId, events: this.events });
    void this.archiveSync?.drainOnce().catch(() => { /* 归档走 drain 重试 */ });
    return { ok: true, output: { message_id: msg.id, published: true } };
  }


  async chatSendAttachment(args: { asset_id: string; presentation: 'image' | 'sticker' | 'voice'; content?: string }, ctx: ToolExecContext): Promise<ToolExecResult> {
    if (!this.messages || !this.media) return { ok: false, output: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '消息/媒体服务未装配' } };
    try {
      this.media.validateForSend([{ asset_id: args.asset_id, presentation: args.presentation }]);
    } catch (err) {
      return { ok: false, output: { error_code: (err as { code?: string }).code ?? 'ASSET_NOT_FOUND' } };
    }
    const kind = args.presentation === 'voice' ? 'voice' : args.presentation === 'sticker' ? 'sticker' : 'text';
    const clientMessageId = `tool-send:${ctx.turnId ?? 'noturn'}:${args.asset_id}:${args.presentation}:${sha256Hex(args.content ?? '')}`;
    const msg = this.messages.publishAssistantMessage({
      conversationId: ctx.roomId, turnId: ctx.turnId ?? 'tool', content: args.content ?? '', kind, clientMessageId, events: this.events,
      attachments: [{ asset_id: args.asset_id, presentation: args.presentation }],
    });
    void this.archiveSync?.drainOnce().catch(() => { /* 归档失败走 drain 重试 */ });
    return { ok: true, output: { message_id: msg.id, published: true } };
  }

}
