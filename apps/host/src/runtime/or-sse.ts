// ESTOMAGO_OR_SELF_HOLD §9.1：单请求 SSE 帧解析与聚合。
// 移植自 docs/specs/ESTOMAGO_OR_SELF_HOLD/reference/or-stream.mjs（按本仓 TS 规范）。
//  - 增量 UTF-8 跨网络块、注释心跳、多行 data、[DONE]。
//  - 最终 usage 帧替换不累计；finish_reason 只记录首个（重复终态是记账帧不是第二次结束）。
//  - 不执行工具、不发请求；opaque reasoning 片段按接收顺序单独保留（§10：不是可发送的完整
//    reasoning_details——完整签名块重建须按实际型号协议另验，不得把片段数组直接回发）。
import { Buffer } from 'node:buffer';
import { ContractError, requireThat, normalizeOrUsage, type NormalizedOrUsage, type OrUsageFrame } from './or-contract.ts';

export class SseFramer {
  private onData: (data: string) => void;
  private maxEventBytes: number;
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private data: string[] = [];
  private eventBytes = 0;

  constructor(onData: (data: string) => void, opts: { maxEventBytes?: number } = {}) {
    this.onData = onData;
    this.maxEventBytes = opts.maxEventBytes ?? 1048576;
  }

  feed(chunk: string | Uint8Array): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.eventBytes += Buffer.byteLength(line) + 1;
      requireThat(this.eventBytes <= this.maxEventBytes, 'SSE_EVENT_TOO_LARGE');
      if (!line) {
        this.eventBytes = 0;
        if (this.data.length > 0) {
          const data = this.data.join('\n');
          this.data = [];
          this.onData(data);
        }
      } else if (!line.startsWith(':') && line.startsWith('data:')) {
        this.data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    requireThat(this.eventBytes + Buffer.byteLength(this.buffer) <= this.maxEventBytes, 'SSE_EVENT_TOO_LARGE');
  }

  end(): void {
    this.feed(this.decoder.decode());
    requireThat(this.buffer.length === 0 && this.data.length === 0, 'SSE_TRUNCATED_FRAME');
  }
}

export type AggregatedToolCall = {
  id: string;
  type: 'function';
  name: string;
  arguments: string;
  parsedArguments: Record<string, unknown>;
};

// 可读展示投影与原样协议继续态分开；签名/密文绝不进入 text。
export type OrReasoningBlock = { index: number; type: 'thinking' | 'redacted_thinking'; text: string };

export type OrStreamFinish = {
  id: string | null;
  status: 'completed' | 'incomplete';
  finishReason: string;
  text: string;
  toolCalls: AggregatedToolCall[];
  usage: NormalizedOrUsage;
  usageRawFrame: OrUsageFrame | null; // 原始记账帧（仅计数/费用字段；供持久化对账）
  reasoningFrames: unknown[]; // opaque：只按接收顺序保留，不解释、不回发
  reasoningBlocks: OrReasoningBlock[]; // 仅上游实际返回的可读文本或明确删隐标记
  reasoningContent: string | null; // D01：DS 官方 thinking 增量拼接（仅同轮工具续传回传；无=null）
  terminalEvents: number;
};

type ToolAcc = { id: string | null; type: 'function'; name: string; arguments: string };

export class OrStreamAccumulator {
  private id: string | null = null;
  private text = '';
  private terminal: string | null = null;
  private terminalEvents = 0;
  private done = false;
  private rawUsage: OrUsageFrame | null = null;
  private tools = new Map<number, ToolAcc>();
  private reasoningFrames: unknown[] = [];
  private reasoningBlocks = new Map<string, OrReasoningBlock>();
  private dsReasoning = ''; // D01（审计 3655d60）：DS thinking 的 reasoning_content 增量——同轮工具续传的协议继续态（opaque，不进 UI）
  private normalizeUsageFn: (u: OrUsageFrame | null) => NormalizedOrUsage;
  private framer = new SseFramer((data) => this.accept(data));

  // normalizeUsage 可注入（DS 官方端点用量口径与 OR 不同：prompt_cache_hit_tokens、无费用字段常态）
  constructor(opts: { normalizeUsage?: (u: OrUsageFrame | null) => NormalizedOrUsage } = {}) {
    this.normalizeUsageFn = opts.normalizeUsage ?? normalizeOrUsage;
  }

  feed(chunk: string | Uint8Array): void {
    this.framer.feed(chunk);
  }

  /** 驱动层增量映射用的只读快照（正文/generation id 当前累计；不暴露内部结构） */
  snapshot(): { id: string | null; text: string } {
    return { id: this.id, text: this.text };
  }

  reasoningSnapshot(): OrReasoningBlock[] {
    return Array.from(this.reasoningBlocks.values(), (block) => ({ ...block }));
  }

  private appendReasoning(key: string, type: OrReasoningBlock['type'], text: string): void {
    const block = this.reasoningBlocks.get(key) ?? { index: this.reasoningBlocks.size, type, text: '' };
    block.text += text;
    this.reasoningBlocks.set(key, block);
  }

  private acceptReasoning(delta: { reasoning?: unknown; reasoning_content?: unknown; reasoning_details?: unknown[] }): void {
    let hasReadableDetails = false;
    for (const [position, value] of (Array.isArray(delta.reasoning_details) ? delta.reasoning_details : []).entries()) {
      if (!value || typeof value !== 'object') continue;
      const detail = value as Record<string, unknown>;
      const identity = Number.isSafeInteger(detail.index) ? `index:${detail.index}`
        : typeof detail.id === 'string' ? `id:${detail.id}` : `position:${position}`;
      const key = `${detail.type}:${identity}`;
      const text = detail.type === 'reasoning.text' ? detail.text : detail.type === 'reasoning.summary' ? detail.summary : null;
      if (typeof text === 'string' && text.length > 0) {
        hasReadableDetails = true;
        this.appendReasoning(key, 'thinking', text);
      } else if (detail.type === 'reasoning.encrypted') {
        this.appendReasoning(key, 'redacted_thinking', '');
      }
    }
    // OpenRouter 可能同帧同时返回 reasoning 与 reasoning_details；它们是同一份
    // 可读内容的两种表示，优先结构化字段，不能把别名再追加一遍。
    const plain = typeof delta.reasoning === 'string' && delta.reasoning.length > 0 ? delta.reasoning : delta.reasoning_content;
    if (!hasReadableDetails && typeof plain === 'string' && plain.length > 0) {
      this.appendReasoning('plain', 'thinking', plain);
    }
  }

  /** 审计 F20：无终态/DONE 断流时，已抵达的记账帧仍可读（不因 finish() 抛出而丢失事实） */
  usageObserved(): OrUsageFrame | null {
    return this.rawUsage ? structuredClone(this.rawUsage) : null;
  }

  private accept(data: string): void {
    if (data === '[DONE]') {
      requireThat(!this.done, 'DUPLICATE_DONE');
      this.done = true;
      return;
    }
    requireThat(!this.done, 'DATA_AFTER_DONE');
    let x: {
      error?: unknown;
      id?: unknown;
      usage?: OrUsageFrame;
      choices?: Array<{ index?: number; delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown; reasoning_details?: unknown[]; tool_calls?: Array<{ index?: unknown; id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }> }; finish_reason?: unknown }>;
    };
    try {
      x = JSON.parse(data) as typeof x;
    } catch {
      throw new ContractError('SSE_INVALID_JSON');
    }
    if (x.error) throw new ContractError('OR_STREAM_ERROR'); // 不透传供应商正文（隐私纪律）
    if (typeof x.id === 'string' && x.id.length > 0) {
      requireThat(this.id === null || this.id === x.id, 'GENERATION_ID_CHANGED');
      this.id = x.id;
    }
    if (x.usage) this.rawUsage = structuredClone(x.usage); // 记账帧替换，绝不求和
    for (const ch of x.choices ?? []) {
      requireThat(ch.index === 0 || ch.index === undefined, 'UNSUPPORTED_MULTIPLE_CHOICES');
      const d = ch.delta ?? {};
      const substantive = Boolean(d.content) || Boolean(d.tool_calls?.length) || Boolean(d.reasoning_details?.length) || Boolean(d.reasoning) || Boolean(d.reasoning_content);
      requireThat(!this.terminal || !substantive, 'CONTENT_AFTER_TERMINAL');
      if (d.content) {
        requireThat(typeof d.content === 'string', 'CONTENT_TYPE_INVALID');
        this.text += d.content;
      }
      if (typeof d.reasoning_content === 'string' && d.reasoning_content.length > 0) this.dsReasoning += d.reasoning_content; // D01：DS thinking 增量（官方协议继续态）
      if (d.reasoning_details?.length) this.reasoningFrames.push(structuredClone(d.reasoning_details));
      this.acceptReasoning(d);
      for (const t of d.tool_calls ?? []) {
        requireThat(Number.isSafeInteger(t.index) && (t.index as number) >= 0, 'TOOL_INDEX_INVALID');
        const idx = t.index as number;
        const v = this.tools.get(idx) ?? { id: null, type: 'function' as const, name: '', arguments: '' };
        if (t.id) {
          requireThat(v.id === null || v.id === t.id, 'TOOL_ID_CHANGED');
          v.id = t.id as string;
        }
        if (t.type) requireThat(t.type === 'function', 'TOOL_TYPE_INVALID');
        if (t.function?.name) v.name += t.function.name;
        if (t.function?.arguments !== undefined) {
          requireThat(typeof t.function.arguments === 'string', 'TOOL_ARGUMENT_FRAGMENT_INVALID');
          v.arguments += t.function.arguments as string;
        }
        requireThat(Buffer.byteLength(v.arguments) <= 1048576, 'TOOL_ARGUMENTS_TOO_LARGE');
        this.tools.set(idx, v);
      }
      if (ch.finish_reason) {
        if (ch.finish_reason === 'error') throw new ContractError('OR_STREAM_ERROR');
        requireThat(this.terminal === null || this.terminal === ch.finish_reason, 'FINISH_REASON_CHANGED');
        if (this.terminal === null) {
          this.terminal = ch.finish_reason as string;
          this.terminalEvents++;
        }
      }
    }
  }

  finish(): OrStreamFinish {
    this.framer.end();
    requireThat(this.done && this.terminal !== null, 'MISSING_FINAL_RESULT');
    const status: 'completed' | 'incomplete' = this.terminal === 'stop' || this.terminal === 'tool_calls' ? 'completed' : 'incomplete';
    const calls: AggregatedToolCall[] = [];
    if (status === 'completed') {
      requireThat((this.tools.size > 0) === (this.terminal === 'tool_calls'), 'TOOL_FINISH_MISMATCH');
      for (const [, v] of [...this.tools.entries()].sort((a, b) => a[0] - b[0])) {
        requireThat(Boolean(v.id) && Boolean(v.name), 'INCOMPLETE_TOOL_CALL');
        let args: unknown;
        try {
          args = JSON.parse(v.arguments);
        } catch {
          throw new ContractError('TOOL_JSON_INVALID');
        }
        requireThat(args !== null && typeof args === 'object' && !Array.isArray(args), 'TOOL_JSON_NOT_OBJECT');
        calls.push({ id: v.id as string, type: 'function', name: v.name, arguments: v.arguments, parsedArguments: args as Record<string, unknown> });
      }
      requireThat(new Set(calls.map((c) => c.id)).size === calls.length, 'DUPLICATE_TOOL_ID');
    }
    return {
      id: this.id,
      status,
      finishReason: this.terminal as string,
      text: this.text,
      toolCalls: calls,
      usage: this.normalizeUsageFn(this.rawUsage),
      usageRawFrame: this.rawUsage ? structuredClone(this.rawUsage) : null,
      reasoningFrames: this.reasoningFrames,
      reasoningBlocks: this.reasoningSnapshot(),
      reasoningContent: this.dsReasoning.length > 0 ? this.dsReasoning : null,
      terminalEvents: this.terminalEvents,
    };
  }
}
