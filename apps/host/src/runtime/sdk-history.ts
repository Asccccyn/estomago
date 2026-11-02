import { randomUUID } from 'node:crypto';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { OrMessage } from './or-payload.ts';
import { sdkToolName } from './sdk-mcp.ts';

type TextBlock = { type: 'text'; text: string };
// 2026-10-31 她批：历史回放的 asset_image 同样在发送边界物化为 SDK image 块（§6.2 不入账本）
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
type ReadImage = (assetId: string) => { bytes: Buffer; mime: string };
type HistoryBlock = TextBlock | ImageBlock
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: TextBlock[] };
type HistoryFrame = {
  type: 'user' | 'assistant'; uuid: string;
  message: { role: 'user' | 'assistant'; content: HistoryBlock[] };
  parent_tool_use_id: null; shouldQuery?: false; client_composed?: true;
};

function textBlocks(content: OrMessage['content'], readImage?: ReadImage): Array<TextBlock | ImageBlock> {
  if (content == null || content === '') return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw Error('SDK_MEDIA_TRANSPORT_UNVERIFIED');
  const out: Array<TextBlock | ImageBlock> = [];
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') { out.push({ type: 'text', text: b.text }); continue; }
    if (b.type === 'asset_image' && readImage) {
      const { bytes, mime } = readImage(b.asset_id);
      out.push({ type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } });
      continue;
    }
    throw Error('SDK_MEDIA_TRANSPORT_UNVERIFIED');
  }
  return out;
}

/** Ordered stdin replay, not a second conversation ledger. A non-query user
 * frame is queued by the runtime; wait for its completion before inserting the
 * next assistant frame, or the assistant can overtake the queued user. */
export class SdkHistoryReplay {
  private frames: HistoryFrame[];
  private ids = new Set<string>();
  private pending: ((ok: boolean) => void) | null = null;
  private closed = false;
  private signal: AbortSignal;
  completed = false;

  constructor(history: OrMessage[], signal: AbortSignal, readImage?: ReadImage) {
    this.signal = signal;
    this.frames = [];
    for (const message of history) {
      if (!['user', 'assistant', 'tool'].includes(message.role)) throw Error('SDK_HISTORY_ROLE_UNSUPPORTED');
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      let content: HistoryBlock[] = textBlocks(message.content, readImage);
      if (message.role === 'tool') {
        if (typeof message.tool_call_id !== 'string') throw Error('SDK_HISTORY_TOOL_ID_MISSING');
        content = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: content as TextBlock[] }];
      } else if (message.tool_calls !== undefined) {
        if (role !== 'assistant' || !Array.isArray(message.tool_calls)) throw Error('SDK_HISTORY_TOOL_CALL_INVALID');
        for (const call of message.tool_calls) {
          if (typeof call.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') throw Error('SDK_HISTORY_TOOL_CALL_INVALID');
          let input: unknown;
          try { input = JSON.parse(call.function.arguments); } catch { throw Error('SDK_HISTORY_TOOL_ARGUMENTS_INVALID'); }
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('SDK_HISTORY_TOOL_ARGUMENTS_INVALID');
          const name = call.function.name;
          content.push({ type: 'tool_use', id: call.id, name: name.startsWith('mcp__est__') ? name : sdkToolName(name), input: input as Record<string, unknown> });
        }
      }
      const previous = this.frames.at(-1);
      // Anthropic pairs one assistant tool batch with one user result batch.
      if (message.role === 'tool' && previous?.message.content.length && previous.message.content.every(block => block.type === 'tool_result')) {
        previous.message.content = [...previous.message.content, ...content];
        continue;
      }
      const uuid = randomUUID(); this.ids.add(uuid);
      this.frames.push({ type: role, uuid, message: { role, content }, parent_tool_use_id: null,
        ...(role === 'user' ? { shouldQuery: false as const, client_composed: true as const } : {}) });
    }
    signal.addEventListener('abort', this.close, { once: true });
  }

  async *input(): AsyncGenerator<SDKUserMessage> {
    for (const frame of this.frames) {
      if (this.closed || this.signal.aborted) return;
      const completion = frame.type === 'user' ? new Promise<boolean>(resolve => { this.pending = resolve; }) : null;
      // Runtime 2.1.283 accepts assistant replay frames on stream-json input;
      // the SDK's prompt iterable type only names user frames. This cast is
      // confined to that measured transport boundary, with no fabricated usage.
      yield frame as unknown as SDKUserMessage;
      if (completion && !(await completion)) return;
    }
    this.completed = true;
  }

  consume(event: SDKMessage): 'replayed' | 'failed' | null {
    if ('uuid' in event && typeof event.uuid === 'string' && this.ids.has(event.uuid)) return 'replayed';
    if (event.type !== 'result' || !this.pending) return null;
    const complete = this.pending; this.pending = null;
    const ok = event.subtype === 'success' && !event.is_error;
    complete(ok);
    return ok ? 'replayed' : 'failed';
  }

  close = (): void => {
    this.closed = true;
    this.pending?.(false); this.pending = null;
    this.signal.removeEventListener('abort', this.close);
  };
}
