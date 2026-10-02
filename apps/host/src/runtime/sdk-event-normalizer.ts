// SDK 事件归一化（AUD-11/12/24 修复版）—— 按 0.3.283 真实消息形状：
//  - 完整 AssistantMessage 常为"单块投递"且多个包共用同一 message.id；
//    匹配策略 = 按类型顺序匹配该 message 的"开放流式块"，绝不把 content[0] 当 block 0；
//    无开放块可匹配 → unmatched 路径（独立 seq 身份），不覆盖任何已有块。
//  - parent_tool_use_id 非null → channel='subagent'，宿主不得投影进主私聊。
//  - content_block_start 自带初始 thinking/text → 归一化为一次性初始 delta（只发一次）。
//  - result.subtype 严格映射：success→completed；error_*/is_error→error。
//  - session_id 从任何消息捕获并透传（会话连续性用）。
import {
  classifyError,
  type ContentBlockType,
  type ErrorClass,
  type EventChannel,
  type MatchedCompleteBlock,
  type RawStreamEvent,
  type SdkNormalizedEvent,
  type UnmatchedCompleteBlock,
} from '../../../../packages/contracts/src/sdk-events.ts';

type OpenBlock = { index: number; type: ContentBlockType; hasInitial: boolean };

export class SdkEventNormalizer {
  // v0.3（AUD-11/12 §12）：按 messageId 维护块状态；通道级当前消息（parent/child 互不覆盖）
  private currentByChannel = new Map<EventChannel, string>();
  private currentModel: string | null = null;
  private session_id: string | null = null;
  private request_id: string | null = null;
  private openBlocks = new Map<string, Map<number, OpenBlock>>();
  private unmatchedSeq = 0;
  private unboundCount = 0;
  private sawSuccessResult = false;
  private lastError: { classified: ErrorClass; message: string } | null = null;

  get observedSuccess(): boolean { return this.sawSuccessResult; }
  get lastErrorInfo(): { classified: ErrorClass; message: string } | null { return this.lastError; }
  get sessionId(): string | null { return this.session_id; }

  normalize(raw: RawStreamEvent): SdkNormalizedEvent[] {
    const out: SdkNormalizedEvent[] = [];
    switch (raw.type) {
      case 'stream_event': {
        const ev = raw.event;
        const channel: EventChannel = raw.parent_tool_use_id ? 'subagent' : 'main';
        if (raw.session_id) this.session_id = raw.session_id;
        switch (ev.type) {
          case 'message_start': {
            const id = ev.message?.id ?? `local_${++this.unboundCount}`;
            this.currentByChannel.set(channel, id);
            this.currentModel = ev.message?.model ?? this.currentModel;
            this.openBlocks.set(id, new Map());
            out.push({ kind: 'message_start', sdk_message_id: id, model: this.currentModel, session_id: this.session_id, channel });
            break;
          }
          case 'content_block_start': {
            const id = this.requireMessageId(out, channel);
            this.openBlocks.get(id)!.set(ev.index, { index: ev.index, type: ev.content_block.type, hasInitial: false });
            out.push({ kind: 'content_block_start', sdk_message_id: id, block_index: ev.index, block_type: ev.content_block.type, channel });
            const initial = ev.content_block.type === 'thinking' ? ev.content_block.thinking : ev.content_block.type === 'text' ? ev.content_block.text : undefined;
            if (typeof initial === 'string' && initial.length > 0) {
              const block = this.openBlocks.get(id)!.get(ev.index)!;
              if (!block.hasInitial) {
                block.hasInitial = true;
                if (ev.content_block.type === 'thinking') out.push({ kind: 'thinking_delta', sdk_message_id: id, block_index: ev.index, text: initial, channel });
                else out.push({ kind: 'text_delta', sdk_message_id: id, block_index: ev.index, text: initial, channel });
              }
            }
            break;
          }
          case 'content_block_delta': {
            const id = this.requireMessageId(out, channel);
            switch (ev.delta.type) {
              case 'thinking_delta': out.push({ kind: 'thinking_delta', sdk_message_id: id, block_index: ev.index, text: ev.delta.thinking, channel }); break;
              case 'signature_delta': break; // 吞掉
              case 'text_delta': out.push({ kind: 'text_delta', sdk_message_id: id, block_index: ev.index, text: ev.delta.text, channel }); break;
              case 'input_json_delta': out.push({ kind: 'tool_input_delta', sdk_message_id: id, block_index: ev.index, tool_name: null, partial_json: ev.delta.partial_json, channel }); break;
            }
            break;
          }
          case 'content_block_stop': {
            const id = this.requireMessageId(out, channel);
            out.push({ kind: 'content_block_stop', sdk_message_id: id, block_index: ev.index, channel });
            break;
          }
          case 'message_stop': {
            const id = this.currentByChannel.get(channel);
            if (id) out.push({ kind: 'message_stop', sdk_message_id: id, channel });
            break;
          }
        }
        break;
      }
      case 'assistant': {
        const channel: EventChannel = raw.parent_tool_use_id ? 'subagent' : 'main';
        if (raw.session_id) this.session_id = raw.session_id;
        if (raw.request_id) this.request_id = raw.request_id;
        const id = raw.message.id ?? this.currentByChannel.get(channel) ?? `local_assistant_${++this.unboundCount}`;
        if (!this.openBlocks.has(id)) this.openBlocks.set(id, new Map());
        const open = this.openBlocks.get(id)!;
        const matched: MatchedCompleteBlock[] = [];
        const unmatched: UnmatchedCompleteBlock[] = [];
        for (const b of raw.message.content ?? []) {
          const text = b.type === 'thinking' || b.type === 'text' ? (b.text ?? b.thinking ?? null) : null;
          if (b.type === 'tool_use') {
            matched.push({ block_index: -1, block_type: b.type, text: null, tool_id: b.id ?? null, tool_name: b.name ?? null });
            continue;
          }
          // §12：歧义不猜——同类型开放候选 != 1 时进 unmatched（AMBIGUOUS），绝不取最小 index
          const candidates = [...open.values()].filter((x) => x.type === b.type).sort((a, b2) => a.index - b2.index);
          if (candidates.length === 1) {
            open.delete(candidates[0]!.index);
            matched.push({ block_index: candidates[0]!.index, block_type: b.type, text, tool_id: null, tool_name: null });
          } else if (candidates.length === 0) {
            unmatched.push({ seq: --this.unmatchedSeq, block_type: b.type, text, reason: 'no_open_block' });
          } else {
            unmatched.push({ seq: --this.unmatchedSeq, block_type: b.type, text, reason: 'ambiguous' });
          }
        }
        out.push({ kind: 'complete_message', sdk_message_id: id, session_id: this.session_id, channel, matched, unmatched });
        break;
      }
      case 'system': {
        // F10：结构化 system 事件（model_refusal_fallback / model_refusal_no_fallback 等）不再丢弃
        if (raw.session_id) this.session_id = raw.session_id;
        if (raw.request_id) this.request_id = raw.request_id;
        out.push({
          kind: 'system_notice',
          subtype: raw.subtype ?? 'unknown',
          content: raw.content ?? raw.message ?? null,
          original_model: raw.original_model ?? null,
          fallback_model: raw.fallback_model ?? null,
          session_id: this.session_id,
        });
        break;
      }
      case 'result': {
        if (raw.session_id) this.session_id = raw.session_id;
        if (raw.usage) out.push({ kind: 'usage', scope: 'turn', usage: raw.usage, source: 'sdk_result', completeness: 'complete' });
        const isSuccess = raw.subtype === 'success' && raw.is_error !== true;
        if (isSuccess) {
          this.sawSuccessResult = true;
          out.push({ kind: 'turn_end', outcome: 'completed', error_classified: null, error_message: null, session_id: this.session_id, request_id: this.request_id });
        } else {
          // F10：errors 数组也是错误文本来源（error 字段为空时不至于丢失分类线索）
          const message = raw.error ?? (Array.isArray(raw.errors) && raw.errors.length > 0 ? raw.errors.join('; ') : null)
            ?? `result subtype=${raw.subtype ?? 'unknown'} is_error=${raw.is_error ?? false}`;
          this.lastError = { classified: classifyError(message), message };
          out.push({ kind: 'turn_end', outcome: 'error', error_classified: this.lastError.classified, error_message: message, session_id: this.session_id, request_id: this.request_id });
        }
        break;
      }
      case 'error': {
        this.lastError = { classified: classifyError(raw.error), message: raw.error };
        out.push({ kind: 'turn_end', outcome: 'error', error_classified: this.lastError.classified, error_message: raw.error, session_id: this.session_id, request_id: this.request_id });
        break;
      }
    }
    return out;
  }

  private requireMessageId(out: SdkNormalizedEvent[], channel: EventChannel): string {
    const cur = this.currentByChannel.get(channel);
    if (cur) return cur;
    const id = `local_${++this.unboundCount}`;
    this.currentByChannel.set(channel, id);
    this.openBlocks.set(id, new Map());
    out.push({ kind: 'message_start', sdk_message_id: id, model: null, session_id: this.session_id, channel });
    return id;
  }
}
