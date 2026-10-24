// modules/voice/transcript-service.ts（P03.4）：转写分页读取用例。
// 原 HostToolExecutor.transcriptRead 逐字迁移。三道边界（R3″）保持：
// ① 源权限：转写必须挂在**本会话当前修订的已发布消息附件**上（voice presentation）；
//    未发送草稿、已被新修订移除附件的旧引用一律拒读。
// ② 字节预算：页按紧凑 JSON 序列化 UTF-8 字节切（含包装与游标）。
// ③ 快照游标：cursor 绑定转写内容身份（derived_text 的 sha256）+ 总字数——等长改写也能检出失效。
// 纯分页函数（sliceByByteBudget）已有单测；业务成功 fixture 必须真实完成发送（测试政策 §7）。
import type { Db } from '../../db/connection.ts';
import { sliceByByteBudget, TRANSCRIPT_PAGE_BUDGET_BYTES } from '../../media/model-input.ts';
import { sha256Hex } from '../../util/id.ts';
import type { CapabilityOutcome, ToolExecContext } from '../../capabilities/contracts.ts';

export type TranscriptReadInput = { audio_ref: string; cursor?: string };

export class VoiceTranscriptService {
  private readonly db: Db;

  constructor(deps: { db: Db }) {
    this.db = deps.db;
  }

  read(args: TranscriptReadInput, ctx: ToolExecContext): CapabilityOutcome<Record<string, unknown>> {
    const assetId = args.audio_ref.slice('est:'.length);
    const row = this.db.prepare(
      `SELECT t.derived_text, a.content_sha256 FROM voice_transcripts t
       JOIN media_assets a ON a.id = t.asset_id
       WHERE t.asset_id = ? AND t.conversation_id = ? AND t.state = 'ready' AND t.content_sha256 = a.content_sha256 AND a.state = 'available'
         AND EXISTS (SELECT 1 FROM message_attachments ma JOIN messages msg ON msg.id = ma.message_id AND msg.current_revision = ma.revision
                     WHERE ma.asset_id = a.id AND ma.presentation = 'voice' AND msg.conversation_id = ?)`,
    ).get(assetId, ctx.roomId, ctx.roomId) as { derived_text: string; content_sha256: string } | undefined;
    if (!row) return { ok: false, error: { error_code: 'TRANSCRIPT_NOT_FOUND', message: '本会话无此语音的可信转写（未就绪/已删除/不在本会话/未作为已发送消息附件）' } };
    const chars = [...row.derived_text];
    const transcriptSha = sha256Hex(row.derived_text);
    let offset = 0;
    if (args.cursor) {
      let parsed: { a?: string; o?: number; n?: number; h?: string };
      try { parsed = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')) as typeof parsed; } catch { return { ok: false, error: { error_code: 'TRANSCRIPT_CURSOR_INVALID' } }; }
      const o = parsed.o;
      if (parsed.a !== assetId || !Number.isInteger(o) || o === undefined || o < 0 || o > chars.length || parsed.n !== chars.length || parsed.h !== transcriptSha) {
        return { ok: false, error: { error_code: 'TRANSCRIPT_SOURCE_CHANGED', message: '转写与游标不一致（转写版本变化或游标过期）——请重读首页' } };
      }
      offset = o;
    }
    // 包装开销：audio_ref/page/total_pages/next_cursor(h=64hex) 等字段序列化上界（实测 <640B，取保守值）
    const WRAPPER_BUDGET = 700;
    const sliced = sliceByByteBudget(row.derived_text, offset, TRANSCRIPT_PAGE_BUDGET_BYTES, WRAPPER_BUDGET);
    if (sliced.pageText === '' && !sliced.done) return { ok: false, error: { error_code: 'TRANSCRIPT_PAGE_OVER_BUDGET', message: '单页预算内无进展（异常输入）' } };
    const done = sliced.done;
    return {
      ok: true,
      value: {
        audio_ref: args.audio_ref,
        page_text: sliced.pageText,
        page_chars: [...sliced.pageText].length,
        total_chars: chars.length,
        byte_budget: TRANSCRIPT_PAGE_BUDGET_BYTES,
        ...(done ? {} : { next_cursor: Buffer.from(JSON.stringify({ a: assetId, o: sliced.nextOffset, n: chars.length, h: transcriptSha }), 'utf8').toString('base64url') }),
      },
    };
  }
}
