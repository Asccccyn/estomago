// DeepSeek 官方直连驱动（2026-10-05 她裁定：DS 官方 key 走独立驱动，不经 OpenRouter）。
// 规范依据 ESTOMAGO_OR_SELF_HOLD §1.1（"新增 API 入口"=新增模型驱动与配置）+ §6.3（provider-neutral 信封按 driver 区分）。
//  - 端点：OpenAI 兼容 POST {base_url}/chat/completions；SSE 帧解析复用 OrStreamAccumulator（注入 DS 用量口径）。
//  - 与 OR 完全分离：不发送 session_id / provider / plugins / cache_control（DS 为自动上下文缓存，
//    命中由 usage 的 prompt_cache_hit_tokens 观测）；envelope.boundaries 对 DS 无意义，序列化时忽略——
//    防 Anthropic 式块参数泄漏（审计 P1-1 的直连侧防线）。
//  - 身份映射隔离：dsSessionId 独立命名空间（estomago:ds:session:*），与 OR session 派生互不重叠；
//    该值只用于宿主内部关联（消息投影 id 等），绝不发给 DS。上下文指纹纳入 deepseek 配置段（identity/service），
//    OR↔DS 切换 → CONTEXT_STALE 强制换窗，不复用旧窗轨迹。
//  - reasoning：DS 官方合同 reasoning_content 由服务端剥离、无需也不应回传（区别于 OR reasoning_details
//    续态）；本驱动不透出 reasoningFrames，工具续请求只靠 tool_calls 块。
//  - §9.2 同款重试纪律：401/402/400 不自动重试；429/瞬时网络故障仅在无已发布输出时有界重试并遵守 Retry-After。
//  - 测试注入假 transport，不联网；真实外网只发生在她授权的 DS 冒烟（ESTOMAGO_DS_SMOKE=1）。
import { Readable } from 'node:stream';
import type { SdkNormalizedEvent } from '../../../../packages/contracts/src/sdk-events.ts';
import type { Config } from '../config/schema.ts';
import { dsModelIdIssue } from '../config/schema.ts';
import { sha256Hex } from '../util/id.ts';
import { ContractError, normalizeDsUsage, toRawUsageColumns, type NormalizedOrUsage } from './or-contract.ts';
import { assertAppendOnly } from './or-payload.ts';
import { OrStreamAccumulator } from './or-sse.ts';
import type { AgentRunner, OrRequestEnvelope, OrRunRequest, RunnerRunResult, RunnerSelection } from './runner.ts';
import type { OrTransport, OrTransportResponse } from './runner-openrouter.ts';

const RETRY_AFTER_CAP_MS = 30_000;
const BACKOFF_BASE_MS = 400;

// 默认 transport：真实 fetch（生产路径）。凭据在请求头构造处读取，绝不落日志。
function defaultTransport(baseUrl: string, apiKeyRef: () => string | null): OrTransport {
  return async (payload, signal) => {
    const key = apiKeyRef();
    if (!key) throw new ContractError('DS_KEY_MISSING_AT_SEND');
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (res.body === null) throw new ContractError('DS_EMPTY_BODY');
    return {
      status: res.status,
      headers: res.headers,
      body: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    };
  };
}

/** 稳定内部关联标识（身份映射隔离）：房间×型号的持久匿名派生，命名空间独立于 OR（estomago:or:session）。
 *  只用于宿主内部（消息投影 id/日志关联），不发送给 DS——DS 端点无此概念。 */
export function dsSessionId(conversationId: string, model: string): string {
  return `es-ds-${sha256Hex(`estomago:ds:session:${conversationId}:${model}`).slice(0, 40)}`;
}

export function deepSeekSelection(config: Config, transport?: OrTransport): RunnerSelection {
  const reasons: string[] = [];
  const ds = config.deepseek;
  if (ds.model === null) reasons.push('DS_MODEL_NOT_CONFIGURED：deepseek.model 未设置（显示"模型未配置"，不猜默认型号）');
  else {
    const m = dsModelIdIssue(ds.model);
    if (m) reasons.push(`DS_MODEL_INVALID: ${m}`);
  }
  const key = process.env[ds.api_key_env];
  if (typeof key !== 'string' || key.length === 0) reasons.push(`DS_KEY_NOT_CONFIGURED：环境变量 ${ds.api_key_env} 未设置（只报状态，不读值）`);
  if (reasons.length > 0) return { status: 'blocked', reasons };
  const apiKeyRef = (): string | null => {
    const v = process.env[ds.api_key_env];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  return {
    status: 'ok',
    runner: new DeepSeekRunner({ retryMax: ds.retry_max_attempts_after_initial }, transport ?? defaultTransport(ds.base_url, apiKeyRef)),
  };
}

/** 信封 → DS 官方 payload：content 块数组拍平为字符串；tools 原样（宿主工具本就是 OpenAI function 形状）；
 *  防御性剥除 cache_control / reasoning_details（DS 端点不认，且轨迹信封可能携带 OR 形状历史）。 */
export function buildDeepSeekPayload(envelope: OrRequestEnvelope): Record<string, unknown> {
  if (typeof envelope.model !== 'string' || dsModelIdIssue(envelope.model) !== null) throw new ContractError('DS_MODEL_INVALID');
  if (!Array.isArray(envelope.messages) || envelope.messages.length === 0) throw new ContractError('MESSAGES_REQUIRED');
  if (!Number.isSafeInteger(envelope.maxTokens) || envelope.maxTokens <= 0) throw new ContractError('MAX_TOKENS_INVALID');
  const messages = envelope.messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role };
    if (typeof m.content === 'string') out.content = m.content;
    else if (Array.isArray(m.content)) {
      out.content = m.content.map((b) => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('');
    } else out.content = m.content ?? null;
    if (Array.isArray((m as { tool_calls?: unknown }).tool_calls)) out.tool_calls = structuredClone((m as unknown as { tool_calls: unknown[] }).tool_calls);
    if (typeof (m as { tool_call_id?: unknown }).tool_call_id === 'string') out.tool_call_id = (m as unknown as { tool_call_id: string }).tool_call_id;
    // D01（审计 3655d60）：thinking 型号同一工具回合的官方协议继续态——仅 string 原样透传
    // （宿主在落轨迹前剥除，绝不跨用户回合携带；UI 思考投影与本字段无通道）
    if (typeof (m as { reasoning_content?: unknown }).reasoning_content === 'string') out.reasoning_content = (m as unknown as { reasoning_content: string }).reasoning_content;
    return out;
  });
  return {
    model: envelope.model,
    messages,
    ...(Array.isArray(envelope.tools) && envelope.tools.length > 0 ? { tools: structuredClone(envelope.tools) } : {}),
    stream: true,
    max_tokens: envelope.maxTokens,
  };
}

type DsRunnerCfg = { retryMax: number };

export class DeepSeekRunner implements AgentRunner {
  readonly kind = 'deepseek' as const;
  interruptSupport = 'claimed' as const;

  private cfg: DsRunnerCfg;
  // 公开只读：冒烟/测试可在不触碰凭据的前提下外包一层字段自检 transport（生产不包裹）
  readonly transport: OrTransport;

  constructor(cfg: DsRunnerCfg, transport: OrTransport) {
    this.cfg = cfg;
    this.transport = transport;
  }

  async run(req: OrRunRequest): Promise<RunnerRunResult> {
    const payload = buildDeepSeekPayload(req.envelope);
    // P2（§11.1）：同窗续请求前缀 append-only（previousPayload 由调用方持久轨迹构造；DS payload 无
    // session_id/provider 键，assertAppendOnly 的键比较对缺席键按 null 通过，消息前缀逐条等值仍强制）。
    if (req.previousPayload) {
      try {
        assertAppendOnly(req.previousPayload, payload);
      } catch (err) {
        return this.errorResult(err, 0);
      }
    }

    let publishedAny = false;
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
      req.onDispatch?.({ attemptIndex: attempt, generationId: response.headers.get('x-generation-id') });
      if (response.status < 200 || response.status >= 300) {
        const code = response.status === 401 || response.status === 403 ? 'DS_AUTH_ERROR'
          : response.status === 402 ? 'DS_PAYMENT_REQUIRED'
            : response.status === 400 ? 'DS_BAD_REQUEST'
              : `DS_HTTP_${response.status}`;
        return { ...this.final('error', code, null, `HTTP ${response.status}`, attempt), requestId: response.headers.get('x-generation-id') };
      }
      const streamed = await this.consumeStream(response, req, attempt, () => { publishedAny = true; });
      if (streamed.kind === 'result') return streamed.result;
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

  private final(outcome: RunnerRunResult['outcome'], errorCode: string | null, errorClassified: RunnerRunResult['errorClassified'], errorMessage: string | null, attempt: number, requestId: string | null = null, _reasoningFrames?: undefined, reasoningContent?: string): RunnerRunResult {
    return { outcome, errorClassified, errorCode, errorMessage, sessionId: null, requestId, attempts: attempt + 1, ...(reasoningContent ? { reasoningContent } : {}) };
  }

  /** 审计 F20 同款：断流/停止后的计量抢救——finish() 抛出则用已观察原始帧按 DS 口径归一（缺帧=无事件） */
  private salvageMetering(req: OrRunRequest, acc: OrStreamAccumulator): void {
    try {
      const f = acc.finish();
      if (f.usage.completeness !== 'unknown') {
        req.onEvent({ kind: 'usage', scope: 'request', usage: this.usageEventFields(f), source: 'ds_stream', completeness: f.usage.completeness === 'complete' ? 'complete' : 'partial' });
      }
      return;
    } catch { /* 无终态：走 usageObserved 抢救 */ }
    const raw = acc.usageObserved();
    if (raw) {
      const u = normalizeDsUsage(raw);
      if (u.completeness !== 'unknown') {
        req.onEvent({ kind: 'usage', scope: 'request', usage: this.usageEventFields({ usage: u, usageRawFrame: raw }), source: 'ds_stream', completeness: u.completeness === 'complete' ? 'complete' : 'partial' });
      }
    }
  }

  // F19 同款：DS 计量字段全量透出（缓存命中/推理明细/异常标记/原始帧）；费用官方帧常缺失 → cost null 如实
  private usageEventFields(finish: { usage: NormalizedOrUsage; usageRawFrame: unknown }): import('../../../../packages/contracts/src/sdk-events.ts').RawUsage {
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
    return this.final('error', classified === 'network' ? 'DS_NETWORK_ERROR' : 'DS_ERROR', classified, message.slice(0, 300), attempt);
  }

  // 与 OpenRouterRunner.consumeStream 同构（SSE 帧形状一致），差异：usage 口径 ds_stream、无 x-generation-id
  // 冲突探测（DS 无该响应头）。按驱动隔离各自维护，不复用同一实现体——两驱动的字段纪律独立演进。
  private async consumeStream(response: OrTransportResponse, req: OrRunRequest, attempt: number, markPublished: () => void): Promise<{ kind: 'result'; result: RunnerRunResult } | { kind: 'pre_data_error'; error: unknown }> {
    const acc = new OrStreamAccumulator({ normalizeUsage: normalizeDsUsage });
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
        sdkMessageId = id ?? `dsgen_${sha256Hex(`${req.envelope.sessionId}:${Date.now()}:${Math.random()}`).slice(0, 16)}`;
        messageStartSent = true;
        emit({ kind: 'message_start', sdk_message_id: sdkMessageId, model: req.envelope.model, session_id: null, channel: 'main' });
      }
      return sdkMessageId!;
    };

    let abortedMidStream = false;
    try {
      for await (const chunk of response.body) {
        sawAnyFrame = true;
        markPublished();
        const before = acc.snapshot();
        acc.feed(chunk);
        const after = acc.snapshot();
        if (req.abortController.signal.aborted) {
          abortedMidStream = true;
          continue;
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
        return { kind: 'result', result: this.final('interrupted', null, null, null, attempt, acc.snapshot().id) };
      }
      if (!sawAnyFrame) return { kind: 'pre_data_error', error: err };
      this.salvageMetering(req, acc); // D04（审计 3655d60）：断流/网络错误先记已到计量帧再收口
      return { kind: 'result', result: this.errorResult(err, attempt) };
    }
    if (abortedMidStream) {
      this.salvageMetering(req, acc);
      return { kind: 'result', result: this.final('interrupted', null, null, null, attempt, acc.snapshot().id) };
    }

    let finish: ReturnType<OrStreamAccumulator['finish']>;
    try {
      finish = acc.finish();
    } catch (err) {
      this.salvageMetering(req, acc); // D04：EOF 无 DONE/非法工具 JSON 等 finish 抛出前先抢救计量
      return { kind: 'result', result: this.errorResult(err, attempt) };
    }

    const mid = ensureMessageStart(finish.id);
    if (finish.usage.completeness !== 'unknown') {
      emit({
        kind: 'usage',
        scope: 'request',
        usage: this.usageEventFields(finish),
        source: 'ds_stream',
        completeness: finish.usage.completeness === 'complete' ? 'complete' : 'partial',
      });
    }
    if (textBlockOpen) emit({ kind: 'content_block_stop', sdk_message_id: mid, block_index: 0, channel: 'main' });
    const matched: import('../../../../packages/contracts/src/sdk-events.ts').MatchedCompleteBlock[] = [];
    if (finish.text.length > 0) matched.push({ block_index: 0, block_type: 'text', text: finish.text, tool_id: null, tool_name: null });
    for (let i = 0; i < finish.toolCalls.length; i++) {
      const c = finish.toolCalls[i]!;
      matched.push({ block_index: i + 1, block_type: 'tool_use', text: c.arguments, tool_id: c.id, tool_name: c.name });
    }
    emit({ kind: 'complete_message', sdk_message_id: mid, session_id: null, channel: 'main', matched, unmatched: [], packet_uuid: null });

    if (finish.status !== 'completed') {
      const code = finish.finishReason === 'length' ? 'DS_FINISH_LENGTH' : finish.finishReason === 'content_filter' ? 'DS_FINISH_CONTENT_FILTER' : 'DS_FINISH_INCOMPLETE';
      emit({ kind: 'turn_end', outcome: 'error', error_classified: null, error_message: code, session_id: null, request_id: finish.id });
      return { kind: 'result', result: this.final('no_final_result', code, null, code, attempt, finish.id) };
    }
    emit({ kind: 'turn_end', outcome: 'completed', error_classified: null, error_message: null, session_id: null, request_id: finish.id });
    // DS 无 reasoning_details 续态；reasoning_content（thinking）作为同轮工具续传的协议继续态透出——
    // supervisor 只在同一工具回合内回传，落轨迹前剥除（§10/D01）
    return { kind: 'result', result: this.final('completed', null, null, null, attempt, finish.id, undefined, finish.reasoningContent ?? undefined) };
  }
}
