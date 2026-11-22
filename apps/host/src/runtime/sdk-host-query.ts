import { isDeepStrictEqual } from 'node:util';
import type { Options, Query, SDKUserMessage, SDKMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { createEstSdkMcp, sdkToolName } from './sdk-mcp.ts';
import { subscriptionAdmission, subscriptionRejected, sdkUsesExtraUsage } from './sdk-subscription.ts';
import { SdkEventNormalizer } from './sdk-event-normalizer.ts';
import { ContractError } from './or-contract.ts';
import type { RawStreamEvent, RawUsage, SdkCostEstimate } from '../../../../packages/contracts/src/sdk-events.ts';
import type { HostToolSpec } from '../capabilities/contracts.ts';
import type { SdkRunRequest, RunnerRunResult } from './runner.ts';
import type { OrMessage } from './or-payload.ts';
import { sha256Hex } from '../util/id.ts';
import { proxyOnlySdkSpawn } from './sdk-network.ts';
import { effectiveToolName } from './tool-discovery.ts';
import { TURN_COMPLETION_TOOL } from './turn-completion.ts';
import { materializeImage, toolResultContent, type ModelImageBlock } from '../media/model-input.ts';
import { SdkHistoryReplay } from './sdk-history.ts';

export type SdkQueryFactory = (request: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
type SessionPrefix = { sessionId: string; prefixHash: string; messageCount: number; messagesHash: string };
type NativeCheckpoint = SessionPrefix & { uuid: string };
export type SdkSessionAnchor = SessionPrefix & { checkpoint?: NativeCheckpoint; forkOnResume?: boolean };
type ForkPrefix = typeof import('@anthropic-ai/claude-agent-sdk').forkSession;
const forkNativePrefix: ForkPrefix = async (sessionId, options) =>
  (await import('@anthropic-ai/claude-agent-sdk')).forkSession(sessionId, options);

// Bound retained raw chunks across the current model message.
const MAX_ARGUMENT_SOURCE_BYTES = 1024 * 1024;

function verifiedArgumentSource(source: string | undefined, args: Record<string, unknown>): string | undefined {
  if (!source) return undefined;
  try {
    return isDeepStrictEqual(JSON.parse(source), args) ? source : undefined;
  } catch {
    return undefined;
  }
}

export async function verifySdkSubscription(run: Query): Promise<string | null> {
  const account = await run.accountInfo();
  const usage = await run.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => null);
  return subscriptionAdmission(account, usage);
}

/** Native SDK owns its tool loop. The only business execution callback is the
 * host bridge, and the returned protocol projection feeds est's existing ledger. */
export async function runSdkHostQuery(
  query: SdkQueryFactory,
  req: SdkRunRequest & { host: NonNullable<SdkRunRequest['host']> },
  sessions: Map<string, SdkSessionAnchor>,
  verifySubscription: (run: Query) => Promise<string | null> = verifySdkSubscription,
  spawnProcess?: Options['spawnClaudeCodeProcess'],
  forkPrefix: ForkPrefix = forkNativePrefix,
): Promise<RunnerRunResult> {
  const host = req.host;
  const normalizer = new SdkEventNormalizer();
  const messages = structuredClone(host.envelope.messages);
  const tools = host.envelope.tools as unknown as HostToolSpec[];
  const toolPrefixHash = () => sha256Hex(JSON.stringify([req.options.options.systemPrompt, tools, host.envelope.model]));
  const prefixHash = toolPrefixHash();
  const previous = host.isolatedSession ? undefined : sessions.get(host.windowId);
  // Preserve the main anchor when a task explicitly uses a separate tool profile.
  // 纯日志信号（supervisor 落 launchd 日志），不新建会话状态机、不影响行为。
  let resumeDecision: NonNullable<RunnerRunResult['resumeDiagnosis']>['decision'] =
    host.isolatedSession ? 'isolated' : 'anchor_missing';
  let resume = (() => {
    if (!previous) return null;
    if (previous.prefixHash !== prefixHash) { resumeDecision = 'prefix_changed'; return null; }
    const currentPrefixHash = sha256Hex(JSON.stringify(messages.slice(0, previous.messageCount)));
    if (previous.messagesHash !== undefined && previous.messagesHash !== currentPrefixHash) { resumeDecision = 'history_mismatch'; return null; }
    resumeDecision = 'resume_hit';
    return previous;
  })();
  if (resume?.forkOnResume && resume.checkpoint && !req.abortController.signal.aborted) {
    const point = resume.checkpoint;
    try {
      // An immutable fork keeps native thinking/signatures and completed tool
      // history. The failed branch is never truncated or used as the next tip.
      const fork = await forkPrefix(point.sessionId, { dir: req.options.options.cwd, upToMessageId: point.uuid });
      resume = { ...point, sessionId: fork.sessionId, checkpoint: point };
      sessions.set(host.windowId, resume);
      resumeDecision = 'resume_checkpoint';
    } catch {
      // The SDK may have pruned the transcript. No model request was made by
      // the local fork; the ordinary ledger replay below remains authoritative.
      sessions.delete(host.windowId);
      resume = null;
      resumeDecision = 'checkpoint_unavailable';
    }
  }
  const resumeDiagnosis: NonNullable<import('./runner.ts').RunnerRunResult['resumeDiagnosis']> = {
    decision: resumeDecision,
    anchorSessionId: previous?.sessionId ?? null,
    anchorMessageCount: previous?.messageCount ?? null,
    sentMessageCount: messages.length,
  };
  // A restart, edit, rotation or OR interval rebuilds from est's current ledger.
  // No synthetic SessionStore entries or mutation of the runtime's private format.
  // P1-a（审计 2026-11-15）：system 数据块中的媒体引用（相册携带图）在 SDK 流式输入没有
  // 载体——systemPrompt 只组装文本（supervisor），输入流又滤掉全部 system；旧实现携带图
  // 被静默丢弃、回合成功仍消费 next_once。把 system 消息的非文本块按原序抬升为输入流首条
  // user 消息（文本块留在 systemPrompt 不重复；本转换仅在输入组装层，账本/锚点哈希基于
  // 原 messages 不受影响）。无 readImage 时维持未核实门，与 tail 物化同款不静默丢图。
  const sliced = messages.slice(resume?.messageCount ?? 0);
  const systemMedia = sliced.flatMap((m) => (m.role === 'system' && typeof m.content !== 'string') ? m.content.filter((b) => b.type !== 'text') : []);
  if (systemMedia.length > 0 && !host.readImage) {
    return { outcome: 'error', errorCode: 'SDK_MEDIA_TRANSPORT_UNVERIFIED', errorClassified: 'unknown', errorMessage: '携带图无媒体投影通道（readImage 缺席），不静默丢图', sessionId: null, requestId: null, attempts: 0, activityStarted: false };
  }
  const inputMessages = sliced.filter(m => m.role !== 'system');
  if (systemMedia.length > 0) inputMessages.unshift({ role: 'user', content: systemMedia });
  const lastUser = inputMessages.findLastIndex(m => m.role === 'user');
  const history = inputMessages.slice(0, Math.max(0, lastUser));
  const tail = inputMessages.slice(Math.max(0, lastUser));
  // 2026-10-31 她批：SDK 原生媒体投影——官方文档核实 Streaming Input（client_composed
  // SDKUserMessage）支持 image 内容块。asset_image 引用块在发送边界物化为 SDK image 块；
  // 仅进本 prompt 流，messages 账本/lastSent/持久化保持引用形态（§6.2 Base64 不入库）。
  // 无 readImage（无媒体服务）或未知块型 → 维持未核实门，不静默丢图。
  const content: Array<{type:'text';text:string} | ModelImageBlock> = [];
  for (const message of tail) {
    if (typeof message.content === 'string') content.push({ type: 'text', text: message.content });
    else for (const block of message.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text ?? '' });
      else if (block.type === 'asset_image' && host.readImage) {
        if (typeof block.asset_id !== 'string') throw Error('SDK_MEDIA_TRANSPORT_UNVERIFIED');
        content.push(await materializeImage(block.asset_id, host.readImage));
      }
      else return { outcome: 'error', errorCode: 'SDK_MEDIA_TRANSPORT_UNVERIFIED', errorClassified: null, errorMessage: 'SDK 原生媒体投影尚未验证', sessionId: null, requestId: null };
    }
  }
  let replay: SdkHistoryReplay;
  try { replay = new SdkHistoryReplay(history, req.abortController.signal, host.readImage); }
  catch (error) { return { outcome: 'error', errorCode: (error as Error).message, errorClassified: 'unknown', errorMessage: 'SDK 历史输入格式不受支持，未发送模型请求', sessionId: null, requestId: null, attempts: 0, activityStarted: false }; }
  let activityStarted = false;
  // P2-a（审计 2026-11-15）：会话是否实际接收到输入（历史重放帧或当前输入）——
  // 锚保留/删除的判定基准。旧实现以"无输出块（activityStarted）"判定，既会把
  // 已送入输入未出块的打断错保留（会话已前进，旧锚 resume 会重复送入），又会把
  // 0 帧 0 派发的准入拒绝错删锚（会话明明未触碰）。
  let sessionReceivedInput = false;
  let nativeAssistant: { uuid: string; message: OrMessage } | undefined;
  let limit: SDKRateLimitInfo | undefined;
  let failure: string | null = null;
  let sdkDetailError: string | null = null; // P1-10（Codex 审计）：归一化结果携带的具体错误原因（result.errors/error），最终回执不再只剩稳定码
  let businessCompleted = false;
  // Resolved SDK receipts prove native retention, separately from provider input.
  let retainedCompletionCalls: Set<string> | null = null;
  let errorEvidence: Record<string, unknown> | null = null; // B3：错误事件脱敏安全字段（白名单键）
  let round = 0;
  let attempts = 0;
  let requestUsage: RawUsage | null = null;
  let observedRequestUsage = false;
  let lastSentMessages = structuredClone(messages);
  const savedHoldCalls = new Set<string>();
  let terminalToolNames = '';
  const callIds = new Map<string, string[]>();
  const toolIdsByBlock = new Map<number, string>();
  const argumentSources = new Map<string, string>();
  let argumentSourceBytes = 0;
  const executing = new Set<string>();
  const observedCalls = new Set<string>();
  const pendingBatch = new Map<string, () => void>();
  async function observedAssistantBatch(callId: string): Promise<boolean> {
    if (observedCalls.has(callId)) return true;
    // MCP and stream events are independent SDK surfaces. Do not accept a
    // terminal operation without the complete assistant packet to recover.
    const signal = AbortSignal.any([req.abortController.signal, AbortSignal.timeout(3000)]);
    if (signal.aborted) return false;
    await new Promise<void>(resolve => {
      const finish = () => { signal.removeEventListener('abort', finish); resolve(); };
      pendingBatch.set(callId, finish);
      signal.addEventListener('abort', finish, { once: true });
    });
    pendingBatch.delete(callId);
    return observedCalls.has(callId) && !signal.aborted;
  }
  const deferredReview: Array<{ name: string; args: Record<string, unknown>; id: string; argumentSource?: string }> = [];
  const assistantIndexes = new Map<string, number>();
  const textBlocks = new Map<string, Map<number, string>>();
  const assistantMessage = (id: string): OrMessage => {
    let index = assistantIndexes.get(id);
    if (index === undefined) {
      index = messages.length; assistantIndexes.set(id, index);
      messages.push({ role: 'assistant', content: '' });
    }
    return messages[index]!;
  };
  const projectText = (id: string, index: number, text: string, append: boolean): void => {
    const blocks = textBlocks.get(id) ?? new Map<number, string>();
    blocks.set(index, (append ? blocks.get(index) ?? '' : '') + text);
    textBlocks.set(id, blocks);
    assistantMessage(id).content = [...blocks.values()].join('');
  };
  const mcp = createEstSdkMcp(tools, async (name, args) => {
    activityStarted = true;
    const key = JSON.stringify([sdkToolName(name), args]);
    const id = callIds.get(key)?.shift();
    if (!id) throw Error('SDK_TOOL_ID_UNAVAILABLE');
    if (req.abortController.signal.aborted) throw Error('SDK_CANCELLED');
    // The SDK can call MCP before the iterator has delivered the block stop.
    // A matching, complete JSON object proves the source even in that order.
    const argumentSource = verifiedArgumentSource(argumentSources.get(id), args);
    argumentSources.delete(id);
    // The existing OR loop completes reviews after every other tool in a batch.
    // Native MCP calls may arrive in model order, so postpone only that action
    // until the official PostToolBatch hook. The business executor still runs once.
    if (host.purpose === 'pre_rotate_review' && effectiveToolName(name, args) === 'context_review_complete') {
      deferredReview.push({ name, args, id, argumentSource });
      const pending = { error_code: 'REVIEW_COMPLETION_PENDING', detail: '本批工具结束后由宿主核验；尚未完成检查。' };
      return { ok: false, output: pending, recordDelivery: result => { messages.push({role:'tool',tool_call_id:id,content:toolResultContent(result)}); } };
    }
    const terminal = host.captureCompletionBatch && effectiveToolName(name, args) === TURN_COMPLETION_TOOL;
    if ((terminal || host.captureHeartbeatBatch) && !await observedAssistantBatch(id)) {
      return {
        ok: false, output: { error_code: terminal ? 'TURN_COMPLETION_BATCH_UNOBSERVED' : 'HEARTBEAT_BATCH_UNOBSERVED' },
        recordDelivery: receipt => { messages.push({ role: 'tool', tool_call_id: id, content: toolResultContent(receipt) }); },
      };
    }
    executing.add(id);
    try {
      const result = await host.executeTool(name, args, id, round, messages, argumentSource, terminal || host.captureHeartbeatBatch ? () => ({
        tail: messages.slice(lastSentMessages.length), inFlight: [...executing], sentMessages: lastSentMessages,
      }) : undefined);
      return { ...result, recordDelivery: delivered => {
        executing.delete(id);
        messages.push({role:'tool',tool_call_id:id,content:toolResultContent(delivered)});
        host.recordToolDelivery?.(id, delivered);
        if (host.purpose === 'chat' && delivered.ok && delivered.output.saved === true
            && effectiveToolName(name, args) === 'memory_hold') {
          savedHoldCalls.add(id);
        }
      } };
    } catch (error) {
      failure = 'TOOL_EXECUTION_OUTCOME_UNKNOWN';
      messages.push({ role: 'tool', tool_call_id: id, content: '{"error_code":"TOOL_EXECUTION_OUTCOME_UNKNOWN"}' });
      run?.close();
      throw error;
    }
  }, host.readImage);
  let releaseInput!: (allowed: boolean) => void;
  const admitted = new Promise<boolean>(resolve => { releaseInput = resolve; });
  let finishInput!: () => void;
  const inputDone = new Promise<void>(resolve => { finishInput = resolve; });
  let run: Query | undefined;
  const beforeModel = async (): Promise<void> => {
    if (req.abortController.signal.aborted) throw Error('SDK_CANCELLED');
    const blocked = await verifySubscription(run!);
    if (blocked) throw Error(blocked);
    await host.beforeModel(messages, round);
    attempts++;
    lastSentMessages = structuredClone(messages);
  };
  const options: Options = {
    ...req.options.options, model: host.envelope.model,
    extraArgs: { 'replay-user-messages': null },
    env: { ...req.options.options.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(host.envelope.maxTokens) },
    abortController: req.abortController, ...(resume ? { resume: resume.sessionId } : {}),
    // RB03（复审 20261106）：维护轮不再 fork——纯1协议已被 est 正本保留（b779842），
    // 维护 user/assistant 属于当前会话的合法继续态；成功后锚随真实最终会话前进，
    // 下一次请求从实发前缀接续，不再向已含维护记录的会话重复重放。旧 fork 策略
    // （为丢弃 ack 而设）与保留策略冲突，已统一到保留侧。
    mcpServers: { est: mcp },
    // 2026-11-09 宿主用户裁定撤销 §8.2 工具轮上限：未显式设 maxModelRequests 时
    // 不传 maxTurns（SDK 无限制）；退出=模型自然结束，死循环由用户停止回合兜底
    ...(host.maxModelRequests !== undefined ? { maxTurns: host.maxModelRequests } : {}),
    spawnClaudeCodeProcess: spawnProcess ?? proxyOnlySdkSpawn(req.options.options.env.HTTPS_PROXY),
    canUseTool: async (name, input, context) => context.mcpServer?.source === 'sdk' && context.mcpServer.name === 'est' && tools.some(t => sdkToolName(t.function.name) === name)
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'Only the explicitly registered est tools are available.' },
    hooks: {
      PreToolUse: [{ hooks: [async input => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const key = JSON.stringify([input.tool_name, input.tool_input]);
        const ids = callIds.get(key) ?? [];
        ids.push(input.tool_use_id); callIds.set(key, ids);
        return {};
      }] }],
      PostToolBatch: [{ hooks: [async input => {
        try {
          const results = [];
          let completed = false;
          for (const call of deferredReview.splice(0)) {
            const result = await host.executeTool(call.name, call.args, call.id, round, messages, call.argumentSource);
            const entry = messages.findLast(m => m.role === 'tool' && m.tool_call_id === call.id)!;
            entry.content = JSON.stringify(result.output);
            results.push(result.output); completed ||= result.ok;
          }
          if (completed) return { continue: false, stopReason: 'EST_REVIEW_COMPLETED' };
          if (host.completionRequested?.()) {
            businessCompleted = true;
            retainedCompletionCalls = new Set(input.hook_event_name === 'PostToolBatch'
              ? (input.tool_calls ?? []).map(call => call.tool_use_id) : []);
            return { continue: false, stopReason: 'EST_TURN_COMPLETED' };
          }
          // The native terminal list uses outer MCP names. Only arm it for a
          // confirmed save batch with main-channel text already sent to publication.
          const calls = input.hook_event_name === 'PostToolBatch' ? input.tool_calls : [];
          const holdsSaved = !!calls?.length && calls.every(call => savedHoldCalls.has(call.tool_use_id));
          savedHoldCalls.clear();
          const hasReply = holdsSaved && [...textBlocks.values()].some(blocks =>
            [...blocks.values()].some(text => text.trim().length > 0));
          const names = hasReply ? [...new Set(calls.map(call => call.tool_name))].join(',') : '';
          if (names !== terminalToolNames) {
            await run!.applyFlagSettings({ env: { CLAUDE_CODE_TERMINAL_MCP_TOOLS: names } });
            terminalToolNames = names;
          }
          round++;
          await beforeModel();
          return results.length ? { hookSpecificOutput: { hookEventName: 'PostToolBatch' as const, additionalContext: JSON.stringify({ review_results: results }) } } : {};
        }
        catch (error) {
          // RB02（复审 20261106）：background_complete 后的停发（宿主 beforeModel 的
          // complete 门）是合法业务完成，不是异常——归一为共同控制结果，与 API 路径
          // 的 complete 门同一出口；SDK 锚/协议投影/维护回执按成功收尾（不再 failed
          // turn + 后半补 completed）。其余错误照旧为失败。
          if (error instanceof ContractError && error.message === 'TURN_COMPLETED_STOP') {
            businessCompleted = true;
            return { continue: false, stopReason: 'EST_TURN_COMPLETED' };
          }
          failure = String((error as Error).message); return { continue: false, stopReason: failure };
        }
      }] }],
      PreCompact: [{ hooks: [async () => ({ continue: false, stopReason: 'EST_OWNS_CONTEXT' })] }],
      PreModelSwitch: [{ hooks: [async () => ({ continue: false, stopReason: 'EST_OWNS_ROUTING' })] }],
    },
  };
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    if (!(await admitted)) return;
    for await (const frame of replay.input()) { sessionReceivedInput = true; yield frame; }
    if (!replay.completed || req.abortController.signal.aborted) return;
    try { await beforeModel(); }
    catch (error) { failure = String((error as Error).message); run?.close(); return; }
    sessionReceivedInput = true;
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null,
      session_id: '', client_composed: true };
    // Replay completions already satisfy the SDK's first-result wait. Keep
    // stdin open until the real turn finishes, including tool/control replies.
    await inputDone;
  })();
  try {
    run = query({ prompt, options });
    releaseInput(true);
    for await (const raw of run) {
      const event = raw as SDKMessage;
      const replayed = replay.consume(event);
      if (replayed === 'failed') { failure = 'SDK_HISTORY_REPLAY_FAILED'; run.close(); break; }
      if (replayed === 'replayed') continue;
      if (event.type === 'result' && (event.total_cost_usd !== undefined || event.modelUsage !== undefined)) {
        // Runtime 2.1.283 restores cumulative spend on resume/fork. Keep the
        // estimate as evidence, never as another request or an actual charge.
        const estimate: SdkCostEstimate = {
          kind: 'sdk_cost_estimate', scope: 'sdk_session_cumulative',
          session_id: event.session_id ?? null, resumed_from_session_id: resume?.sessionId ?? null,
          fork_session: resumeDecision === 'resume_checkpoint' || options.forkSession === true,
          total_cost_usd: event.total_cost_usd ?? null, model_usage: event.modelUsage ?? {}, result_subtype: event.subtype,
        };
        req.onEvent({ kind: 'usage', scope: 'cumulative', source: 'sdk_result',
          completeness: event.subtype === 'success' && !event.is_error ? 'complete' : 'partial', usage: { raw_json: JSON.stringify(estimate) } });
      }
      if (event.type === 'rate_limit_event') {
        limit = event.rate_limit_info;
        if (sdkUsesExtraUsage(limit)) { failure = 'SDK_EXTRA_USAGE_ACTIVE'; run.close(); break; }
        if (subscriptionRejected(limit)) failure = 'SDK_SUBSCRIPTION_EXHAUSTED';
        continue;
      }
      if (event.type === 'assistant' && event.error) {
        failure ??= event.error === 'authentication_failed' ? 'SDK_SUBSCRIPTION_AUTH_REQUIRED' : `SDK_${event.error.toUpperCase()}`;
        // B3：留错误证据的安全标量字段（不含消息正文/工具内容——隐私纪律与 AUD-28 同口径）
        errorEvidence ??= {
          sdk_error: event.error,
          ...(typeof (event as Record<string, unknown>)['subtype'] === 'string' ? { subtype: (event as Record<string, unknown>)['subtype'] } : {}),
          ...(typeof event.session_id === 'string' ? { session_id: event.session_id } : {}),
          ...(event.message?.id ? { provider_message_id: event.message.id } : {}),
          ...(event.message?.model ? { model: event.message.model } : {}),
          ...(event.request_id ? { request_id: event.request_id } : {}),
        } as Record<string, unknown>;
        continue;
      }
      if (event.type === 'stream_event') {
        const stream = event.event;
        if (!event.parent_tool_use_id) {
          if (stream.type === 'message_start') {
            toolIdsByBlock.clear();
            argumentSources.clear();
            argumentSourceBytes = 0;
          } else if (stream.type === 'content_block_start' && stream.content_block.type === 'tool_use'
            && typeof stream.content_block.id === 'string' && typeof stream.content_block.name === 'string'
            && stream.content_block.name.startsWith('mcp__est__')) {
            toolIdsByBlock.set(stream.index, stream.content_block.id);
            argumentSources.set(stream.content_block.id, '');
          } else if (stream.type === 'content_block_delta' && stream.delta.type === 'input_json_delta'
            && typeof stream.delta.partial_json === 'string') {
            const toolId = toolIdsByBlock.get(stream.index);
            const source = toolId === undefined ? undefined : argumentSources.get(toolId);
            if (toolId !== undefined && source !== undefined) {
              const chunkBytes = Buffer.byteLength(stream.delta.partial_json);
              if (argumentSourceBytes + chunkBytes > MAX_ARGUMENT_SOURCE_BYTES) {
                argumentSources.delete(toolId);
              } else {
                argumentSourceBytes += chunkBytes;
                argumentSources.set(toolId, source + stream.delta.partial_json);
              }
            }
          } else if (stream.type === 'content_block_stop') {
            toolIdsByBlock.delete(stream.index);
          }
        }
        if (event.event.type === 'message_start') {
          host.modelStarted(event.event.message.id, round, event.event.message.model);
          requestUsage = event.event.message.usage ? sdkUsageFields(event.event.message.usage) : null;
          observedRequestUsage ||= requestUsage !== null;
        }
        if (event.event.type === 'message_delta' && requestUsage) requestUsage = { ...requestUsage, ...sdkUsageFields(event.event.usage) };
        if (event.event.type === 'message_stop' && requestUsage) {
          req.onEvent({ kind: 'usage', scope: 'request', usage: requestUsage, source: 'sdk_stream', completeness: 'complete' });
          requestUsage = null;
        }
        if (event.event.type === 'content_block_delta' || event.event.type === 'content_block_start') activityStarted = true;
      }
      const normalized = normalizer.normalize((event.type === 'result' && event.usage
        ? { ...event, usage: sdkUsageFields(event.usage) } : raw) as unknown as RawStreamEvent);
      if (event.type === 'assistant' && normalized.some(e => e.kind === 'complete_message')) {
        activityStarted = true;
        const assistant = assistantMessage(event.message.id);
        if (!event.parent_tool_use_id && normalized.some(e => e.kind === 'complete_message' && e.channel === 'main')) {
          nativeAssistant = event.uuid ? { uuid: event.uuid, message: assistant } : undefined;
        }
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            const calls = (assistant.tool_calls ??= []) as unknown[];
            calls.push({ id: block.id, type: 'function', function: {
              name: block.name.replace(/^mcp__est__/, ''), arguments: JSON.stringify(block.input),
            } });
          }
        }
      }
      for (const event of normalized) {
        // P1-10（Codex 审计 2026-11-16）：失败 result 的具体原因（error / errors 数组，如
        // Overloaded）在归一化层已提取——留档供最终回执使用，避免只剩 SDK_* 稳定码。
        if (event.kind === 'turn_end' && (event as { outcome?: string; error_message?: unknown }).outcome === 'error') {
          const em = (event as { error_message?: unknown }).error_message;
          if (typeof em === 'string' && em.length > 0) sdkDetailError ??= em.slice(0, 200);
        }
        // Keep partial text in est's protocol ledger too. Waiting for a complete
        // assistant packet would lose a response when the stream breaks mid-block.
        if (event.kind === 'text_delta' && event.channel === 'main') projectText(event.sdk_message_id, event.block_index, event.text, true);
        if (event.kind === 'complete_message' && event.channel === 'main') {
          for (const block of event.matched) if (block.block_type === 'text' && block.text !== null) projectText(event.sdk_message_id, block.block_index, block.text, false);
          for (const block of event.unmatched) if (block.block_type === 'text' && block.text !== null && block.reason === 'no_open_block') projectText(event.sdk_message_id, block.seq, block.text, false);
        }
        // result.usage sums the native tool loop. Recording it again would both
        // double-count tokens and present that sum as the last request's context.
        if (event.kind === 'usage' && observedRequestUsage) continue;
        req.onEvent(event);
        // Refusal is an explicit upstream flag. End the native loop before its
        // continuation; the existing host route ticket owns the user's choice.
        if (event.kind === 'system_notice' && event.scope !== 'local'
          && (event.subtype === 'model_flagged' || event.subtype === 'model_refusal_no_fallback')) {
          failure = 'SDK_FLAGGED';
          req.abortController.abort();
          run.close();
          return finish('interrupted');
        }
      }
      if (event.type === 'assistant' && normalized.some(output => output.kind === 'complete_message' && output.channel === 'main')) {
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            observedCalls.add(block.id);
            pendingBatch.get(block.id)?.();
          }
        }
      }
      if (event.type === 'result') finishInput();
    }
    if (req.abortController.signal.aborted) return finish('interrupted');
    if (failure) return finish('error');
    // RB02：合法业务停发（background_complete）＝completed——即便原生循环没有最终
    // result 事件（hook continue:false 收口），也按成功收尾，不落 no_final_result。
    return finish(businessCompleted || normalizer.observedSuccess ? 'completed' : normalizer.lastErrorInfo ? 'error' : 'no_final_result');
  } catch (error) {
    failure ??= String((error as Error).message);
    return finish(req.abortController.signal.aborted ? 'interrupted' : 'error');
  } finally {
    if (requestUsage) req.onEvent({ kind: 'usage', scope: 'request', usage: requestUsage, source: 'sdk_stream', completeness: 'partial' });
    for (const release of pendingBatch.values()) release();
    replay.close(); releaseInput(false); finishInput(); run?.close();
  }

  function finish(outcome: RunnerRunResult['outcome']): RunnerRunResult {
    const answered = new Set(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    if (outcome !== 'completed' || businessCompleted) {
      for (const m of messages) for (const call of (m.tool_calls ?? []) as Array<{ id: string }>) {
        if (!answered.has(call.id)) messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(executing.has(call.id)
          ? { error_code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN', outcome: 'unknown' }
          : { error_code: 'EXECUTION_NOT_STARTED', executed: false }) });
      }
    }
    const missingNativeReceipt = businessCompleted && messages.slice(lastSentMessages.length)
      .flatMap(message => (message.tool_calls ?? []) as Array<{ id: string }>)
      .some(call => !answered.has(call.id) || !retainedCompletionCalls?.has(call.id));
    if (host.isolatedSession) {
      // A scoped request may have appended real task history to est's ledger,
      // but that history will be replayed from the main session's own anchor.
      resumeDiagnosis.anchorOutcome = null;
    } else if (outcome === 'completed' && normalizer.sessionId && !missingNativeReceipt) {
      // RB03（复审 20261106）：锚随真实最终会话前进（含维护轮——协议保留后维护
      // 记录属于该会话）。
      const prefix = { sessionId: normalizer.sessionId, prefixHash: toolPrefixHash(),
        messageCount: messages.length, messagesHash: sha256Hex(JSON.stringify(messages)) };
      // A terminal tool batch can have a native receipt after the last assistant.
      // Never mark its assistant UUID as covering that receipt. Keep the earlier
      // checkpoint: any subsequent canonical tool receipts are replayed as history.
      const checkpoint = nativeAssistant && nativeAssistant.message === messages.at(-1) && !nativeAssistant.message.tool_calls
        ? { ...prefix, uuid: nativeAssistant.uuid } : resume?.checkpoint;
      sessions.set(host.windowId, { ...prefix, checkpoint });
      resumeDiagnosis.anchorOutcome = 'saved';
    } else if (outcome !== 'completed' && !sessionReceivedInput) {
      resumeDiagnosis.anchorOutcome = 'kept';
    } else if (resume?.checkpoint) {
      const checkpoint = resume.checkpoint;
      sessions.set(host.windowId, { ...checkpoint, checkpoint, forkOnResume: true });
      resumeDiagnosis.anchorOutcome = 'checkpoint_kept';
    } else {
      sessions.delete(host.windowId);
      resumeDiagnosis.anchorOutcome = 'deleted';
    }
    return {
      outcome, errorCode: failure && /^[A-Z][A-Z0-9_]+$/.test(failure) ? failure : outcome === 'error' ? 'SDK_ERROR' : null,
      errorClassified: failure && /network|timeout|fetch|ECONN/i.test(failure) ? 'network' : outcome === 'error' ? 'unknown' : null,
      errorMessage: sdkDetailError ?? failure, sessionId: normalizer.sessionId, requestId: null,
      subscriptionLimit: limit, activityStarted, attempts, finalMessages: messages, lastSentMessages,
      resumeDiagnosis, errorEvidence,
    };
  }
}

// SDK counters are nullable; absent is unknown, never an observed zero.
function sdkUsageFields(usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; output_tokens_details?: { thinking_tokens?: number | null } | null; cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null }): RawUsage {
  const result: RawUsage = {};
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    const value = usage[key];
    if (typeof value === 'number') result[key] = value;
  }
  const thinking = usage.output_tokens_details?.thinking_tokens;
  if (typeof thinking === 'number') result.reasoning_tokens = thinking;
  // B3（2026-11-04）：保留缓存写入的 5m/1h 拆分（存在时）——经 raw_json 落 usage_observations.raw_usage_json；
  // 字段缺失=未知，不补零、不推断（供应商/线路未回传时保持不可见）。
  const e5 = usage.cache_creation?.ephemeral_5m_input_tokens;
  const e1 = usage.cache_creation?.ephemeral_1h_input_tokens;
  if (typeof e5 === 'number' || typeof e1 === 'number') {
    result.raw_json = JSON.stringify({ cache_creation_split: {
      ...(typeof e5 === 'number' ? { ephemeral_5m_input_tokens: e5 } : {}),
      ...(typeof e1 === 'number' ? { ephemeral_1h_input_tokens: e1 } : {}),
    } });
  }
  return result;
}
