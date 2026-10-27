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
    if (text.length > 4000) return { ok: false, error: { error_code: 'TOOL_ARG_INVALID', detail: 'text 上限 4000 字（与合成服务输入合同一致）' } };
    if (!this.deps.sirenCall || this.deps.sirenCall.status !== 'available') {
      return { ok: false, error: { error_code: 'INTEGRATION_UNCONFIGURED', detail: '语音合成服务未接入（能力缺口，如实拒绝）' } };
    }
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
    try {
      if (existingAsset) {
        // 生成已完成（上次发布前中断）：复用资产直接发布，不再收费合成
        this.deps.media.validateForSend([{ asset_id: existingAsset.id, presentation: 'voice' }]);
        const msg = this.deps.publish({
          conversationId: ctx.roomId, turnId: ctx.turnId ?? '', content: text, kind: 'voice',
          clientMessageId, attachments: [{ asset_id: existingAsset.id, presentation: 'voice' }],
        });
        return { ok: true, value: { state: 'published', message_id: msg.id, sequence: msg.sequence, audio_asset_id: existingAsset.id, reused_asset: true, note: '复用已生成音频发布（不二次合成）' } };
      }
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
      this.deps.media.validateForSend([{ asset_id: saved.id, presentation: 'voice' }]);
      const msg = this.deps.publish({
        conversationId: ctx.roomId, turnId: ctx.turnId ?? '', content: text, kind: 'voice',
        clientMessageId, attachments: [{ asset_id: saved.id, presentation: 'voice' }],
      });
      return {
        ok: true,
        value: {
          state: 'published', // generated+attached 已成，published=唯一消息已发布（回执三阶段收敛为最终事实+中间失败如实报错）
          message_id: msg.id,
          sequence: msg.sequence,
          audio_asset_id: saved.id,
          note: '语音已生成并作为你的语音消息发布；正文=你说的这句话',
        },
      };
    } catch (err) {
      const code = String((err as Error).message ?? err);
      if (ctx.signal?.aborted) return { ok: false, error: { error_code: 'CANCELLED', detail: '本轮已停止；语音未发布' } };
      // 结果不明（超时/连接中断）：Siren 可能已收费合成并持久化——先按操作身份找回同一资产，
      // 找不回才如实报告。恢复不是重试：不重新合成、不重新收费。
      if (code === 'SIREN_OUTCOME_UNKNOWN') {
        const recovered = await this.recoverFromSirenAsset(opKey, clientMessageId, text, ctx);
        if (ctx.signal?.aborted) return { ok: false, error: { error_code: 'CANCELLED', detail: '本轮已停止；语音未发布' } };
        if (recovered) return recovered;
        return { ok: false, error: { error_code: code, detail: '合成结果不明（可能已生成但未取回）；语音未发布。再次调用会重新合成并计费，不要为补发立即重复调用' } };
      }
      // 同操作键但参数不一致（Siren 409）：不是可重试失败，需以新意图发起
      if (code === 'SIREN_OPERATION_CONFLICT') return { ok: false, error: { error_code: code, detail: '同一操作身份携带了与已生成音频不一致的参数；如确要不同语音请作为新的一次发言重新调用' } };
      // 服务明确拒绝/失败：未取得音频，可重试
      if (code.startsWith('SIREN_')) return { ok: false, error: { error_code: code.slice(0, 40), detail: '语音合成失败——可重试；文字消息未受影响' } };
      throw err;
    }
  }

  /** A01 恢复：按操作身份取回 Siren 已持久资产（GET messages?message_id=op → /voice-assets/:id/audio），
   *  落 est 媒体并发布同一唯一消息。任何一步失败/找不回都返回 null（调用方如实报结果不明），
   *  不重新合成、不制造假 sent。取消中的恢复不发布。 */
  private async recoverFromSirenAsset(opKey: string, clientMessageId: string, text: string, ctx: ToolExecContext): Promise<CapabilityOutcome<Record<string, unknown>> | null> {
    if (!this.deps.sirenCall) return null;
    try {
      const found = await this.deps.sirenCall.findVoiceAssetByOperationId(opKey, { signal: ctx.signal });
      if (!found || ctx.signal?.aborted) return null;
      const audio = await this.deps.sirenCall.fetchVoiceAssetAudio(found.id, { signal: ctx.signal });
      if (!audio || ctx.signal?.aborted) return null;
      const saved = await this.deps.media.saveBuffer({
        bytes: Buffer.from(audio.bytes), purpose: 'chat_voice',
        operationId: opKey,
        createdBy: 'assistant-voice', origin: 'import', originService: 'siren', originRef: found.id,
      });
      this.deps.media.validateForSend([{ asset_id: saved.id, presentation: 'voice' }]);
      if (ctx.signal?.aborted) return null;
      const msg = this.deps.publish({
        conversationId: ctx.roomId, turnId: ctx.turnId ?? '', content: text, kind: 'voice',
        clientMessageId, attachments: [{ asset_id: saved.id, presentation: 'voice' }],
      });
      return {
        ok: true,
        value: {
          state: 'published',
          message_id: msg.id,
          sequence: msg.sequence,
          audio_asset_id: saved.id,
          recovered: true,
          note: '响应丢失后按同一操作找回已生成音频发布（未重新合成）',
        },
      };
    } catch {
      return null;
    }
  }
}
