// SDK 事件归一化（05 §5.1 接收矩阵）：RawSdkEvent → SdkNormalizedEvent。
// 关键纪律：
// - signature_delta 不向 UI 分发（吞掉）
// - text_delta 走正文，绝不进 reasoning
// - 完整 AssistantMessage 只用于核对/补齐（发 complete_message），不重复追加
// - message_stop ≠ 产品 turn 结束；content_block_stop ≠ 工具成功
// - 模型消息身份绑定 message_start 的 sdk_message_id；无法绑定的事件按序挂到最近消息并标记
import { classifyError, type ContentBlockType, type RawStreamEvent, type SdkNormalizedEvent } from '../../../../packages/contracts/src/sdk-events.ts';

export class SdkEventNormalizer {
  private currentMessageId: string | null = null;
  private currentModel: string | null = null;
  private blockTypes = new Map<number, ContentBlockType>();
  private toolNames = new Map<number, string | null>();
  private unboundCount = 0;

  normalize(raw: RawStreamEvent): SdkNormalizedEvent[] {
    const out: SdkNormalizedEvent[] = [];
    switch (raw.type) {
      case 'stream_event': {
        const ev = raw.event;
        switch (ev.type) {
          case 'message_start': {
            // SDK 未提供稳定 message id 时：绑定本连接本地步标识，并标出来源（05 §4）
            this.currentMessageId = ev.message?.id ?? `local_${++this.unboundCount}`;
            this.currentModel = ev.message?.model ?? this.currentModel;
            this.blockTypes.clear();
            this.toolNames.clear();
            out.push({ kind: 'message_start', sdk_message_id: this.currentMessageId, model: this.currentModel, source: 'stream' });
            break;
          }
          case 'content_block_start': {
            const id = this.requireMessageId(out, ev.index);
            this.blockTypes.set(ev.index, ev.content_block.type);
            if (ev.content_block.type === 'tool_use') this.toolNames.set(ev.index, null);
            out.push({ kind: 'content_block_start', sdk_message_id: id, block_index: ev.index, block_type: ev.content_block.type });
            break;
          }
          case 'content_block_delta': {
            const id = this.requireMessageId(out, ev.index);
            const bt = this.blockTypes.get(ev.index);
            switch (ev.delta.type) {
              case 'thinking_delta':
                out.push({ kind: 'thinking_delta', sdk_message_id: id, block_index: ev.index, text: ev.delta.thinking });
                break;
              case 'signature_delta':
                // 吞掉：不分发、不解析、不入库（协议态由 SDK 自己维护）
                break;
              case 'text_delta':
                out.push({ kind: 'text_delta', sdk_message_id: id, block_index: ev.index, text: ev.delta.text });
                break;
              case 'input_json_delta':
                out.push({
                  kind: 'tool_input_delta',
                  sdk_message_id: id,
                  block_index: ev.index,
                  tool_name: this.toolNames.get(ev.index) ?? null,
                  partial_json: ev.delta.partial_json,
                });
                break;
            }
            if (bt === undefined) {
              // 未见 block_start 的 delta：仍按 delta 自身类型归一（不猜身份，block_index 原样保留）
            }
            break;
          }
          case 'content_block_stop': {
            const id = this.requireMessageId(out, ev.index);
            out.push({ kind: 'content_block_stop', sdk_message_id: id, block_index: ev.index });
            break;
          }
          case 'message_stop': {
            if (this.currentMessageId) out.push({ kind: 'message_stop', sdk_message_id: this.currentMessageId });
            break;
          }
        }
        break;
      }
      case 'assistant': {
        // 完整块：可能早于 block_stop 到达；多块可共用同一 model message ID（05 §5.1）
        const id = raw.message.id ?? this.currentMessageId ?? `local_assistant_${++this.unboundCount}`;
        const blocks = (raw.message.content ?? []).map((b, idx) => ({
          block_type: b.type,
          block_index: idx, // 完整块的数组下标仅作初核对键；映射歧义由 reconciler 处理，不冒充供应商 ID
          text: b.type === 'thinking' || b.type === 'text' ? (b.text ?? b.thinking ?? null) : null,
          tool_id: b.type === 'tool_use' ? (b.id ?? null) : null,
          tool_name: b.type === 'tool_use' ? (b.name ?? null) : null,
        }));
        out.push({ kind: 'complete_message', sdk_message_id: id, blocks });
        break;
      }
      case 'result': {
        if (raw.usage) {
          out.push({
            kind: 'usage',
            scope: 'turn', // result.usage 是本轮口径；累计 modelUsage 另有 scope=cumulative（01 §9）
            usage: raw.usage,
            source: 'sdk_result',
            completeness: 'complete',
          });
        }
        out.push({ kind: 'turn_end', outcome: 'completed', error_classified: null, error_message: raw.error ?? null });
        break;
      }
      case 'error': {
        out.push({ kind: 'turn_end', outcome: 'error', error_classified: classifyError(raw.error), error_message: raw.error });
        break;
      }
    }
    return out;
  }

  private requireMessageId(out: SdkNormalizedEvent[], blockIndex: number): string {
    if (this.currentMessageId) return this.currentMessageId;
    // message_start 缺失：本地步标识兜底，并在流上标记（不伪造供应商 ID）
    this.currentMessageId = `local_${++this.unboundCount}`;
    out.push({ kind: 'message_start', sdk_message_id: this.currentMessageId, model: null, source: 'stream' });
    return this.currentMessageId;
  }
}
