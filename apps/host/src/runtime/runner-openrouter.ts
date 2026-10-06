// ESTOMAGO_OR_SELF_HOLD §6/§9：OpenRouter Chat Completions 驱动。
//  - 独立凭据：key 只经 api_key_env 指名的环境变量由 transport 读取；不进日志/DB/前端/错误回显。
//  - 与 SDK 完全分离：本文件不 import SDK；OR 模式下 SDK 懒加载不会发生（§2.1）。
//  - §9.2 重试：仅 429/瞬时网络故障，且仅在"尚未发布任何事件/副作用"时有界重试（默认≤2 次），
//    遵守 Retry-After；401/402/配置 400 不自动重试；异常不改模型/上游。
//  - §9.1：200 内 SSE error、注释心跳、UTF-8 跨块、重复终态 usage 帧、[DONE] 由 or-sse 处理；
//    X-Generation-Id 与正文 ID 冲突如实报告（system_notice，不含正文）。
//  - 测试注入假 transport（OrTransport），不联网；真实外网验收只发生在 WP6 授权冒烟。
import { Readable } from 'node:stream';
import type { MatchedCompleteBlock, SdkNormalizedEvent } from '../../../../packages/contracts/src/sdk-events.ts';
import type { Config } from '../config/schema.ts';
import { orModelIdIssue } from '../config/schema.ts';
import { sha256Hex } from '../util/id.ts';
import { ContractError, normalizeOrUsage, toRawUsageColumns } from './or-contract.ts';
import { assertAppendOnly, buildOrPayload } from './or-payload.ts';
import { OrStreamAccumulator } from './or-sse.ts';
import type { AgentRunner, OrRunRequest, RunnerRunResult, RunnerSelection } from './runner.ts';

export type OrTransportResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array>;
};
export type OrTransport = (payload: Record<string, unknown>, signal: AbortSignal) => Promise<OrTransportResponse>;

const RETRY_AFTER_CAP_MS = 30_000; // 有界遵守 Retry-After；不无限等待
const BACKOFF_BASE_MS = 400;

// 默认 transport：真实 fetch（生产路径）。凭据在请求头构造处读取，绝不落日志。
function defaultTransport(baseUrl: string, apiKeyRef: () => string | null): OrTransport {
  return async (payload, signal) => {
    const key = apiKeyRef();
    if (!key) throw new ContractError('OR_KEY_MISSING_AT_SEND');
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        // 不发送 X-Title/HTTP-Referer：无必要的外发标识不引入（§6.1 最小外发）
      },
      body: JSON.stringify(payload),
      signal,
    });
    if (res.body === null) throw new ContractError('OR_EMPTY_BODY');
    return {
      status: res.status,
      headers: res.headers,
      body: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    };
  };
}

/** 稳定 session_id（§6.2）：房间×模型×profile 的持久匿名标识；不随机、不含真实姓名。 */
export function orSessionId(conversationId: string, model: string, profileRef: string | null): string {
  return `es-${sha256Hex(`estomago:or:session:${conversationId}:${model}:${profileRef ?? 'default'}`).slice(0, 40)}`;
}

export function openRouterSelection(config: Config, transport?: OrTransport): RunnerSelection {
  const reasons: string[] = [];
  const or = config.openrouter;
  if (or.model === null) reasons.push('OR_MODEL_NOT_CONFIGURED：openrouter.model 未设置（显示"模型未配置"，不猜默认型号）');
  else {
    const m = orModelIdIssue(or.model);
    if (m) reasons.push(`OR_MODEL_INVALID: ${m}`);
  }
  const key = process.env[or.api_key_env];
  if (typeof key !== 'string' || key.length === 0) reasons.push(`OR_KEY_NOT_CONFIGURED：环境变量 ${or.api_key_env} 未设置（只报状态，不读值）`);
  if (reasons.length > 0) return { status: 'blocked', reasons };
  const apiKeyRef = (): string | null => {
    const v = process.env[or.api_key_env];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  return {
    status: 'ok',
    runner: new OpenRouterRunner(
      { providerOnly: or.provider_only, allowFallbacks: or.allow_fallbacks, requireParameters: or.require_parameters, retryMax: or.retry_max_attempts_after_initial },
      transport ?? defaultTransport(or.base_url, apiKeyRef),
    ),
  };
}

type RunnerCfg = { providerOnly: string[]; allowFallbacks: boolean; requireParameters: boolean; retryMax: number };

export class OpenRouterRunner implements AgentRunner {
  readonly kind = 'openrouter' as const;
  interruptSupport = 'claimed' as const; // fetch signal + 读循环检查点（§9.2 停止）

  private cfg: RunnerCfg;
  private transport: OrTransport;

  constructor(cfg: RunnerCfg, transport: OrTransport) {
    this.cfg = cfg;
    this.transport = transport;
  }

  async run(req: OrRunRequest): Promise<RunnerRunResult> {
    const payload = buildOrPayload({
      model: req.envelope.model,
      sessionId: req.envelope.sessionId,
      messages: req.envelope.messages,
      tools: req.envelope.tools,
      boundaries: req.envelope.boundaries,
      maxTokens: req.envelope.maxTokens,
      reasoning: req.envelope.reasoning,
      providerOnly: this.cfg.providerOnly,
      allowFallbacks: this.cfg.allowFallbacks,
      requireParameters: this.cfg.requireParameters,
    });
    // P2（§11.1）发送侧最终校验之一：同窗续请求前缀 append-only（previousPayload 由调用方持久化轨迹提供）。
    // 断言失败是确定错误（历史被改写/profile 变化）——收口为 error 终态，不向上抛、不静默发送。
    if (req.previousPayload) {
      try {
        assertAppendOnly(req.previousPayload, payload);
      } catch (err) {
        return this.errorResult(err, 0);
      }
    }

    let publishedAny = false; // 已发布事件/已开始流 → 不再自动重试（§9.2 无已发布输出才重试）

    for (let attempt = 0; ; attempt++) {
      let response: OrTransportResponse;
      try {
        response = await this.transport(payload, req.abortController.signal);
      } catch (err) {
        if (req.abortController.signal.aborted) return this.final('interrupted', null, null, null, attempt);
        if (!publishedAny && this.isTransientNetworkError(err) && attempt < this.cfg.retryMax) {
          await this.sleep(BACKOFF_BASE_MS * (attempt + 1));
          continue;
        }
        return this.errorResult(err, attempt);
      }
      if (response.status === 429 && !publishedAny && attempt < this.cfg.retryMax) {
        await this.sleepRetryAfter(response.headers.get('retry-after'), attempt);
        continue;
      }
      req.onDispatch?.({ attemptIndex: attempt, generationId: response.headers.get('x-generation-id') }); // F17：2xx=真实发送
      if (response.status < 200 || response.status >= 300) {
        // 401/402/配置 400 及其他非 2xx：不自动重试，不改模型/上游（§9.2）
        const code = response.status === 401 || response.status === 403 ? 'OR_AUTH_ERROR'
          : response.status === 402 ? 'OR_PAYMENT_REQUIRED'
            : response.status === 400 ? 'OR_BAD_REQUEST'
              : `OR_HTTP_${response.status}`;
        return { ...this.final('error', code, null, `HTTP ${response.status}`, attempt), requestId: response.headers.get('x-generation-id') };
      }
      const streamed = await this.consumeStream(response, req, attempt, () => { publishedAny = true; });
      if (streamed.kind === 'result') return streamed.result;
      // 流在第一个字节前失败：无已发布输出、无已发起副作用 → 瞬时网络故障按预算有界重试（§9.2）
      if (this.isTransientNetworkError(streamed.error) && attempt < this.cfg.retryMax) {
        await this.sleep(BACKOFF_BASE_MS * (attempt + 1));
        continue;
      }
      return this.errorResult(streamed.error, attempt);
    }
  }

  private isTransientNetworkError(err: unknown): boolean {
    const m = String((err as Error)?.message ?? err).toLowerCase();
    return m.includes('network') || m.includes('timeout') || m.includes('timed out') || m.includes('econnreset') ||
      m.includes('econnrefused') || m.includes('enotfound') || m.includes('eai_again') || m.includes('fetch failed') ||
      m.includes('socket hang up') || m.includes('connection error') || m.includes('terminated') || m.includes('epipe');
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  private async sleepRetryAfter(retryAfter: string | null, attempt: number): Promise<void> {
    const secs = Number(retryAfter);
    const ms = Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, RETRY_AFTER_CAP_MS) : BACKOFF_BASE_MS * (attempt + 1);
    await this.sleep(ms);
  }

  private final(outcome: RunnerRunResult['outcome'], errorCode: string | null, errorClassified: RunnerRunResult['errorClassified'], errorMessage: string | null, attempt: number, requestId: string | null = null, reasoningFrames: unknown[] | null = null): RunnerRunResult {
    return { outcome, errorClassified, errorCode, errorMessage, sessionId: null, requestId, attempts: attempt + 1, ...(reasoningFrames !== null && reasoningFrames.length > 0 ? { reasoningFrames } : {}) };
  }

  /** 审计 F20：断流/停止后的计量抢救——优先 finish()；抛出则用已观察的原始记账帧归一（不编造，缺帧=无事件） */
  private salvageMetering(req: OrRunRequest, acc: OrStreamAccumulator): void {
    try {
      const f = acc.finish();
      if (f.usage.completeness !== 'unknown') {
        req.onEvent({ kind: 'usage', scope: 'request', usage: this.usageEventFields(f), source: 'or_stream', completeness: f.usage.completeness === 'complete' ? 'complete' : 'partial' });
      }
      return;
    } catch { /* 无终态：走 usageObserved 抢救 */ }
    const raw = acc.usageObserved();
    if (raw) {
      const u = normalizeOrUsage(raw);
      if (u.completeness !== 'unknown') {
        req.onEvent({ kind: 'usage', scope: 'request', usage: this.usageEventFields({ usage: u, usageRawFrame: raw }), source: 'or_stream', completeness: u.completeness === 'complete' ? 'complete' : 'partial' });
      }
    }
  }

  // F19：OR 计量字段全量透出（费用/推理明细/异常标记/原始帧）——不在桥接中丢失
  private usageEventFields(finish: { usage: import('./or-contract.ts').NormalizedOrUsage; usageRawFrame: unknown }): import('../../../../packages/contracts/src/sdk-events.ts').RawUsage {
    const u = finish.usage;
    return {
      ...toRawUsageColumns(u),
      ...(u.cost !== null ? { cost_usd: u.cost } : {}),
      ...(u.reasoning !== null ? { reasoning_tokens: u.reasoning } : {}),
      ...(u.anomalies.length > 0 ? { anomalies: u.anomalies } : {}),
      ...(finish.usageRawFrame ? { raw_json: JSON.stringify(finish.usageRawFrame) } : {}),
    };
  }

  private errorResult(err: unknown, attempt: number): RunnerRunResult {
    if (err instanceof ContractError) {
      return this.final('error', err.code, null, err.code, attempt);
    }
    const message = String((err as Error)?.message ?? err);
    const classified: RunnerRunResult['errorClassified'] = this.isTransientNetworkError(message) ? 'network' : /refus|permission/i.test(message) ? 'refusal' : 'unknown';
    return this.final('error', classified === 'network' ? 'OR_NETWORK_ERROR' : 'OR_ERROR', classified, message.slice(0, 300), attempt);
  }

  // 结果协议：'result' = 已定终态；'pre_data_error' = 流在收到任何字节前失败（调用方可按 §9.2 有界重试）。
  private async consumeStream(response: OrTransportResponse, req: OrRunRequest, attempt: number, markPublished: () => void): Promise<{ kind: 'result'; result: RunnerRunResult } | { kind: 'pre_data_error'; error: unknown }> {
    const acc = new OrStreamAccumulator();
    const headerGenId = response.headers.get('x-generation-id');
    let messageStartSent = false;
    let sdkMessageId: string | null = null;
    let textBlockOpen = false;
    let sawAnyFrame = false;
    const emit = (ev: SdkNormalizedEvent): void => {
      markPublished();
      req.onEvent(ev);
    };
    const ensureMessageStart = (id: string | null): string => {
      if (!messageStartSent) {
        sdkMessageId = id ?? `orgen_${sha256Hex(`${req.envelope.sessionId}:${Date.now()}:${Math.random()}`).slice(0, 16)}`;
        messageStartSent = true;
        emit({ kind: 'message_start', sdk_message_id: sdkMessageId, model: req.envelope.model, session_id: null, channel: 'main' });
        if (headerGenId && id && headerGenId !== id) {
          // §9.1：请求头与正文 generation ID 冲突如实报告（只记观测，不含正文）
          emit({ kind: 'system_notice', subtype: 'or_generation_id_conflict', content: null, original_model: null, fallback_model: null, session_id: null });
        }
      }
      return sdkMessageId!;
    };

    let abortedMidStream = false;
    try {
      for await (const chunk of response.body) {
        sawAnyFrame = true; // 已进入流（即使尚无正文）——保守视为已发布，不再自动重试
        markPublished();
        const before = acc.snapshot();
        acc.feed(chunk); // 审计 F20：先吸收（含已抵达的计量帧），停止不丢已收到的事实
        const after = acc.snapshot();
        if (req.abortController.signal.aborted) {
          abortedMidStream = true;
          continue; // 不再发布内容/工具；usage 由 fence 单独放行（下方收口补记）
        }
        if (after.id !== before.id) ensureMessageStart(after.id);
        if (after.text.length > before.text.length) {
          const mid = ensureMessageStart(after.id);
          if (!textBlockOpen) {
            textBlockOpen = true;
            emit({ kind: 'content_block_start', sdk_message_id: mid, block_index: 0, block_type: 'text', channel: 'main' });
          }
          emit({ kind: 'text_delta', sdk_message_id: mid, block_index: 0, text: after.text.slice(before.text.length), channel: 'main' });
        }
      }
    } catch (err) {
      if (req.abortController.signal.aborted || abortedMidStream) {
        this.salvageMetering(req, acc);
        return { kind: 'result', result: this.final('interrupted', null, null, null, attempt, acc.snapshot().id ?? headerGenId) };
      }
      if (!sawAnyFrame) return { kind: 'pre_data_error', error: err };
      this.salvageMetering(req, acc); // D04（审计 3655d60）：断流/网络错误也先记已到计量帧，再收口错误
      return { kind: 'result', result: this.errorResult(err, attempt) };
    }
    if (abortedMidStream) {
      // 停止收口：流若完整则 finish；缺 DONE/终态时不再整帧丢弃——已到的记账帧照样补记（F20）
      this.salvageMetering(req, acc);
      return { kind: 'result', result: this.final('interrupted', null, null, null, attempt, acc.snapshot().id ?? headerGenId) };
    }

    let finish: ReturnType<OrStreamAccumulator['finish']>;
    try {
      finish = acc.finish();
    } catch (err) {
      this.salvageMetering(req, acc); // D04：EOF 无 DONE/非法工具 JSON 等 finish 抛出前，先抢救已到计量
      return { kind: 'result', result: this.errorResult(err, attempt) };
    }

    const mid = ensureMessageStart(finish.id);
    if (finish.usage.completeness !== 'unknown') {
      emit({
        kind: 'usage',
        scope: 'request',
        usage: this.usageEventFields(finish),
        source: 'or_stream',
        completeness: finish.usage.completeness === 'complete' ? 'complete' : 'partial',
      });
    }
    if (textBlockOpen) emit({ kind: 'content_block_stop', sdk_message_id: mid, block_index: 0, channel: 'main' });
    const matched: MatchedCompleteBlock[] = [];
    if (finish.text.length > 0) matched.push({ block_index: 0, block_type: 'text', text: finish.text, tool_id: null, tool_name: null });
    for (let i = 0; i < finish.toolCalls.length; i++) {
      const c = finish.toolCalls[i]!;
      matched.push({ block_index: i + 1, block_type: 'tool_use', text: c.arguments, tool_id: c.id, tool_name: c.name });
    }
    emit({ kind: 'complete_message', sdk_message_id: mid, session_id: null, channel: 'main', matched, unmatched: [], packet_uuid: null });

    if (finish.status !== 'completed') {
      // §9.1：length/error/content_filter 等不得发布完整成功；已正式发表部分由 supervisor 按中断语义展示
      const code = finish.finishReason === 'length' ? 'OR_FINISH_LENGTH' : finish.finishReason === 'content_filter' ? 'OR_FINISH_CONTENT_FILTER' : 'OR_FINISH_INCOMPLETE';
      emit({ kind: 'turn_end', outcome: 'error', error_classified: null, error_message: code, session_id: null, request_id: finish.id ?? headerGenId });
      return { kind: 'result', result: this.final('no_final_result', code, null, code, attempt, finish.id ?? headerGenId) };
    }
    emit({ kind: 'turn_end', outcome: 'completed', error_classified: null, error_message: null, session_id: null, request_id: finish.id ?? headerGenId });
    // §10：opaque reasoning 片段随终态透出——协议继续态保真（宿主续请求原样携带，不解释不重构）
    return { kind: 'result', result: this.final('completed', null, null, null, attempt, finish.id ?? headerGenId, finish.reasoningFrames) };
  }
}
