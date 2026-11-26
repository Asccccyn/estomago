// modules/voice/voice-send.ts（GLM_VOICE_UNIFICATION 04§5.3，A05）：模型主动语音。
// P08：普通文字不自动 TTS；char**主动选择**用语音说某句时经本工具真实可达。
// 阶段回执（generated/attached/published）如实——合成成功≠消息发布成功：
//   1 generated：Siren /v1/voice/synthesize 真实音频字节（付费 TTS 边界在 Siren）
//   2 attached：字节落 est 媒体资产（稳定 asset_id，非短效 URL）
//   3 published：publishAssistantMessage 唯一 assistant 语音消息（正文=他说的话，
//     附件=合成音频；同 tool_call 重试同 clientMessageId 幂等——不重复产出同文语音+文字）
// 归档：assistant 语音消息走既有 outbox（archive-sync 正文投影 rev.content 非空=原样）。
// 失败保留可恢复关联：合成失败=工具错误（可重试）；发布失败=资产已存（如实报错，资产不删）。
import type { Db } from '../../db/connection.ts';
import type { SirenAdapter } from '../../integrations/siren/adapter.ts';
import type { CapabilityOutcome, ToolExecContext } from '../../capabilities/contracts.ts';
import { sha256Hex } from '../../util/id.ts';

export type ChatSendVoiceInput = { text: string; tts_script?: string; emotion?: string; speed?: number };

type SendDeps = {
  db: Db; sirenCall: SirenAdapter | null;
  media: { saveBuffer(b: { bytes: Buffer; purpose: 'chat_voice'; operationId: string; createdBy: string; origin: 'import' | 'upload' | 'generated' | 'service'; originService?: string; originRef?: string }): Promise<{ id: string; content_sha256: string }>; validateForSend(a: Array<{ asset_id: string; presentation: string }>): void };
  publish: (opts: { conversationId: string; turnId: string; content: string; kind: 'voice'; clientMessageId: string; attachments: Array<{ asset_id: string; presentation: 'voice' }> }) => { id: string; sequence: number; current_revision?: number };
};

export class VoiceSendService {
  private readonly deps: SendDeps;
  constructor(deps: SendDeps) { this.deps = deps; }

  async send(input: ChatSendVoiceInput, ctx: ToolExecContext): Promise<CapabilityOutcome<Record<string, unknown>>> {
    const text = input.text.trim();
    if (!text) return { ok: false, error: { error_code: 'TOOL_ARG_INVALID', detail: 'text 必填（语音内容=你原话的正文）' } };
    // 2026-11-02 生产实测根因修复：emotion 是 Siren 合同闭集枚举；工具定义曾示例
    // "softly"——模型照用即 invalid_body。此处预检兜底（定义层枚举已拦，直调也拦）。
    const EMOTIONS = ['neutral', 'warm', 'happy', 'sad', 'angry', 'teasing', 'sleepy', 'excited', 'surprised'];
    if (input.emotion !== undefined && !EMOTIONS.includes(input.emotion)) {
      return { ok: false, error: { error_code: 'TOOL_ARG_INVALID', detail: `emotion 须为闭集枚举之一：${EMOTIONS.join(' / ')}（收到：${input.emotion}）` } };
    }
    if (text.length > 4000) return { ok: false, error: { error_code: 'TOOL_ARG_INVALID', detail: 'text 上限 4000 字（与合成服务输入合同一致）' } };
    // 幂等身份：同 tool_call 重试同键（复用 (conversation, client_message_id) 唯一索引）
    const clientMessageId = `voice-say:${ctx.turnId ?? ctx.requestId}:${ctx.toolCallId ?? 'direct'}`;
    // RR-05（费用边界前置幂等）：已完成操作直接返回同一发布事实（不再二次合成）；
    // 合成前先查本操作是否已产生资产（operationId 稳定派生），有=复用该阶段结果。
    const existing = this.deps.db.prepare('SELECT id FROM messages WHERE conversation_id=? AND client_message_id=?').get(ctx.roomId, clientMessageId) as { id: string } | undefined;
    if (existing) {
      const prevAtt = this.deps.db.prepare("SELECT asset_id FROM message_attachments WHERE message_id=? AND presentation='voice' LIMIT 1").get(existing.id) as { asset_id: string } | undefined;
      return { ok: true, value: { state: 'published', message_id: existing.id, audio_asset_id: prevAtt?.asset_id ?? null, replayed: true, note: '同一操作已完成（幂等重放）' } };
    }
    const opKey = `voice-say:${sha256Hex(clientMessageId).slice(0, 24)}`;
    const existingAsset = this.deps.db.prepare("SELECT id FROM media_assets WHERE creation_operation_id=?").get(opKey) as { id: string } | undefined;
    if (existingAsset) return this.publishSavedVoice(existingAsset.id, clientMessageId, text, ctx, 'reused');
    if (!this.deps.sirenCall || this.deps.sirenCall.status !== 'available') {
      return { ok: false, error: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '语音合成服务未接入（能力缺口，如实拒绝）' } };
    }
    try {
      const audio = await this.deps.sirenCall.synthesize({
        text,
        ttsScript: input.tts_script,
        emotion: input.emotion,
        speed: input.speed,
        operationId: opKey,
        signal: ctx.signal,
      });
      if (!audio) return { ok: false, error: { error_code: 'SIREN_NOT_CONFIGURED' } };
      const saved = await this.deps.media.saveBuffer({
        bytes: Buffer.from(audio.bytes), purpose: 'chat_voice',
        operationId: opKey,
        createdBy: 'assistant-voice', origin: 'import', originService: 'siren',
      });
      return this.publishSavedVoice(saved.id, clientMessageId, text, ctx, 'generated');
    } catch (err) {
      const code = String((err as Error).message ?? err);
      if (ctx.signal?.aborted) return { ok: false, error: { error_code: 'CANCELLED', detail: '本轮已停止；语音未发布' } };
      // 结果不明（超时/连接中断）：Siren 可能已收费合成并持久化——先按操作身份找回同一资产，
      // 找不回才如实报告。恢复不是重试：不重新合成、不重新收费。
      if (code === 'SIREN_OUTCOME_UNKNOWN') {
        const recoveredAssetId = await this.recoverFromSirenAsset(opKey, ctx.signal);
        if (recoveredAssetId) return this.publishSavedVoice(recoveredAssetId, clientMessageId, text, ctx, 'recovered');
        if (ctx.signal?.aborted) return { ok: false, error: { error_code: 'CANCELLED', detail: '本轮已停止；语音未发布' } };
        return { ok: false, error: { error_code: code, detail: '合成结果不明（可能已生成但未取回）；语音未发布。再次调用会重新合成并计费，不要为补发立即重复调用' } };
      }
      // 同操作键但参数不一致（Siren 409）：不是可重试失败，需以新意图发起
      if (code === 'SIREN_OPERATION_CONFLICT') return { ok: false, error: { error_code: code, detail: '同一操作身份携带了与已生成音频不一致的参数；如确要不同语音请作为新的一次发言重新调用' } };
      // 服务明确拒绝/失败：未取得音频，可重试。P6 §10.2：带上 Siren 的安全
      // 分类（adapter.detail），模型可见结果保持简洁、后台可排障
      if (code.startsWith('SIREN_')) {
        const sirenClass = (err as { detail?: string }).detail;
        return { ok: false, error: { error_code: code.slice(0, 40), detail: '语音合成失败——可重试；文字消息未受影响' + (sirenClass ? `（服务分类：${sirenClass}）` : '') } };
      }
      throw err;
    }
  }

  /** 已有音频时，只补发布。失败回执使用已冻结窗口也支持的附件工具。 */
  private publishSavedVoice(assetId: string, clientMessageId: string, text: string, ctx: ToolExecContext, source: 'generated' | 'reused' | 'recovered'): CapabilityOutcome<Record<string, unknown>> {
    const liveGate = ctx.checkChatPublishAllowed?.();
    if (liveGate && !liveGate.allowed) {
      return { ok: false, error: {
        error_code: liveGate.code,
        saved: true, published: false, asset_id: assetId,
        detail: `${liveGate.detail}。音频已保存，消息未发布。她要求只补发时，用 chat_send_attachment，传本回执的 asset_id、presentation=voice，content 沿用本次的 text。`,
      } };
    }
    if (!ctx.signal?.aborted) {
      try {
        this.deps.media.validateForSend([{ asset_id: assetId, presentation: 'voice' }]);
        const msg = this.deps.publish({
          conversationId: ctx.roomId, turnId: ctx.turnId ?? '', content: text, kind: 'voice',
          clientMessageId, attachments: [{ asset_id: assetId, presentation: 'voice' }],
        });
        return { ok: true, value: {
          state: 'published', message_id: msg.id, sequence: msg.sequence, audio_asset_id: assetId,
          ...(source === 'reused' ? { reused_asset: true, note: '复用已生成音频发布（不二次合成）' }
            : source === 'recovered' ? { recovered: true, note: '响应丢失后按同一操作找回已生成音频发布（未重新合成）' }
              : { note: '语音已生成并发布；正文是你说的这句话' }),
        } };
      } catch {
        // 发布事务可能已提交，仅事件投递或回执读取失败。检查同一消息身份再给补发指引。
        const published = this.deps.db.prepare(`
          SELECT m.id, m.sequence FROM messages m
            JOIN message_attachments a ON a.message_id=m.id AND a.revision=m.current_revision
           WHERE m.conversation_id=? AND m.client_message_id=? AND a.asset_id=? AND a.presentation='voice'
        `).get(ctx.roomId, clientMessageId, assetId) as { id: string; sequence: number } | undefined;
        if (published) return { ok: true, value: {
          state: 'published', message_id: published.id, sequence: published.sequence,
          audio_asset_id: assetId, note: '已核回同一条发布消息',
        } };
      }
    }
    return { ok: false, error: {
      error_code: ctx.signal?.aborted ? 'CANCELLED' : 'VOICE_PUBLISH_FAILED',
      saved: true, published: false, asset_id: assetId,
      detail: '音频已保存，消息未发布。她要求只补发时，用 chat_send_attachment，传本回执的 asset_id、presentation=voice，content 沿用本次的 text。她明确要求重录时，再调用 chat_send_voice。',
    } };
  }

  /** A01：按原操作身份取回 Siren 的完整音频，落地后由统一的发布边界继续。 */
  private async recoverFromSirenAsset(opKey: string, signal?: AbortSignal): Promise<string | null> {
    if (!this.deps.sirenCall) return null;
    try {
      const found = await this.deps.sirenCall.findVoiceAssetByOperationId(opKey, { signal });
      if (!found || signal?.aborted) return null;
      const audio = await this.deps.sirenCall.fetchVoiceAssetAudio(found.id, { signal });
      if (!audio || signal?.aborted) return null;
      const saved = await this.deps.media.saveBuffer({
        bytes: Buffer.from(audio.bytes), purpose: 'chat_voice',
        operationId: opKey,
        createdBy: 'assistant-voice', origin: 'import', originService: 'siren', originRef: found.id,
      });
      return saved.id;
    } catch {
      return null;
    }
  }
}
