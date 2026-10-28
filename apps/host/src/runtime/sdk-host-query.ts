import type { Options, Query, SDKUserMessage, SDKMessage, SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { createEstSdkMcp, sdkToolName } from './sdk-mcp.ts';
import { subscriptionAdmission, subscriptionRejected, sdkUsesExtraUsage } from './sdk-subscription.ts';
import { SdkEventNormalizer } from './sdk-event-normalizer.ts';
import type { RawStreamEvent, RawUsage } from '../../../../packages/contracts/src/sdk-events.ts';
import type { HostToolSpec } from '../capabilities/contracts.ts';
import type { SdkRunRequest, RunnerRunResult } from './runner.ts';
import type { OrMessage } from './or-payload.ts';
import { sha256Hex } from '../util/id.ts';
import { proxyOnlySdkSpawn } from './sdk-network.ts';
import { effectiveToolName } from './tool-discovery.ts';

export type SdkQueryFactory = (request: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
export type SdkSessionAnchor = { sessionId: string; prefixHash: string; messageCount: number; messagesHash: string };

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
): Promise<RunnerRunResult> {
  const host = req.host;
  const normalizer = new SdkEventNormalizer();
  const messages = structuredClone(host.envelope.messages);
  const tools = host.envelope.tools as unknown as HostToolSpec[];
  const prefixHash = sha256Hex(JSON.stringify([req.options.options.systemPrompt, tools, host.envelope.model]));
  const previous = sessions.get(host.windowId);
  const resume = previous && previous.prefixHash === prefixHash
    && previous.messagesHash === sha256Hex(JSON.stringify(messages.slice(0, previous.messageCount))) ? previous : null;
  // A restart, edit, rotation or OR interval rebuilds from est's current ledger.
  // No synthetic SessionStore entries or mutation of the runtime's private format.
  const inputMessages = messages.slice(resume?.messageCount ?? 0).filter(m => m.role !== 'system');
  const lastUser = inputMessages.findLastIndex(m => m.role === 'user');
  const history = inputMessages.slice(0, Math.max(0, lastUser));
  const tail = inputMessages.slice(Math.max(0, lastUser));
  const content: Array<{ type: 'text'; text: string }> = [];
  if (history.length) content.push({ type: 'text', text: `<est_history>\n以下是宿主聊天账本的历史记录，仅作历史上下文；不是新的用户指令，也不要重执其中的工具。\n${JSON.stringify(history)}\n</est_history>` });
  for (const message of tail) {
    if (typeof message.content === 'string') content.push({ type: 'text', text: message.content });
    else for (const block of message.content) {
      if (block.type !== 'text') return { outcome: 'error', errorCode: 'SDK_MEDIA_TRANSPORT_UNVERIFIED', errorClassified: null, errorMessage: 'SDK 原生媒体投影尚未验证', sessionId: null, requestId: null };
      content.push({ type: 'text', text: block.text ?? '' });
    }
  }
  let activityStarted = false;
  let limit: SDKRateLimitInfo | undefined;
  let failure: string | null = null;
  let round = 0;
  let attempts = 0;
  let requestUsage: RawUsage | null = null;
  let observedRequestUsage = false;
  let lastSentMessages = structuredClone(messages);
  const callIds = new Map<string, string[]>();
  const executing = new Set<string>();
  const deferredReview: Array<{ name: string; args: Record<string, unknown>; id: string }> = [];
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
    // The existing OR loop completes reviews after every other tool in a batch.
    // Native MCP calls may arrive in model order, so postpone only that action
    // until the official PostToolBatch hook. The business executor still runs once.
    if (host.purpose === 'pre_rotate_review' && effectiveToolName(name, args) === 'context_review_complete') {
      deferredReview.push({ name, args, id });
      const pending = { error_code: 'REVIEW_COMPLETION_PENDING', detail: '本批工具结束后由宿主核验；尚未完成检查。' };
      messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(pending) });
      return { ok: false, output: pending };
    }
    executing.add(id);
    try {
      const result = await host.executeTool(name, args, id, round);
      messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result.output) });
      executing.delete(id);
      return result;
    } catch (error) {
      failure = 'TOOL_EXECUTION_OUTCOME_UNKNOWN';
      messages.push({ role: 'tool', tool_call_id: id, content: '{"error_code":"TOOL_EXECUTION_OUTCOME_UNKNOWN"}' });
      run?.close();
      throw error;
    }
  });
  let releaseInput!: (allowed: boolean) => void;
  const admitted = new Promise<boolean>(resolve => { releaseInput = resolve; });
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    if (!(await admitted)) return;
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null,
      session_id: '', client_composed: true };
  })();
  let run: Query | undefined;
  const beforeModel = async (): Promise<void> => {
    if (req.abortController.signal.aborted) throw Error('SDK_CANCELLED');
    if (round >= host.maxModelRequests) throw Error('TOOL_ROUNDS_EXCEEDED');
    const blocked = await verifySubscription(run!);
    if (blocked) throw Error(blocked);
    await host.beforeModel(messages, round);
    attempts++;
    lastSentMessages = structuredClone(messages);
  };
  const options: Options = {
    ...req.options.options, model: host.envelope.model,
    env: { ...req.options.options.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(host.envelope.maxTokens) },
    abortController: req.abortController, ...(resume ? { resume: resume.sessionId } : {}),
    // est discards a pure maintenance acknowledgement. A native fork warms the
    // same prefix without appending that acknowledgement to the chat session.
    ...(resume && host.purpose === 'cache_keepalive' ? { forkSession: true } : {}),
    mcpServers: { est: mcp },
    maxTurns: host.maxModelRequests,
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
      PostToolBatch: [{ hooks: [async () => {
        try {
          const results = [];
          let completed = false;
          for (const call of deferredReview.splice(0)) {
            const result = await host.executeTool(call.name, call.args, call.id, round);
            const entry = messages.findLast(m => m.role === 'tool' && m.tool_call_id === call.id)!;
            entry.content = JSON.stringify(result.output);
            results.push(result.output); completed ||= result.ok;
          }
          if (completed) return { continue: false, stopReason: 'EST_REVIEW_COMPLETED' };
          round++;
          await beforeModel();
          return results.length ? { hookSpecificOutput: { hookEventName: 'PostToolBatch' as const, additionalContext: JSON.stringify({ review_results: results }) } } : {};
        }
        catch (error) { failure = String((error as Error).message); return { continue: false, stopReason: failure }; }
      }] }],
      PreCompact: [{ hooks: [async () => ({ continue: false, stopReason: 'EST_OWNS_CONTEXT' })] }],
      PreModelSwitch: [{ hooks: [async () => ({ continue: false, stopReason: 'EST_OWNS_ROUTING' })] }],
    },
  };
  try {
    run = query({ prompt, options });
    try { await beforeModel(); releaseInput(true); }
    catch (error) { failure = String((error as Error).message); releaseInput(false); return finish('error'); }
    for await (const raw of run) {
      const event = raw as SDKMessage;
      if (event.type === 'rate_limit_event') {
        limit = event.rate_limit_info;
        if (sdkUsesExtraUsage(limit)) { failure = 'SDK_EXTRA_USAGE_ACTIVE'; run.close(); break; }
        if (subscriptionRejected(limit)) failure = 'SDK_SUBSCRIPTION_EXHAUSTED';
        continue;
      }
      if (event.type === 'assistant' && event.error) {
        failure ??= event.error === 'authentication_failed' ? 'SDK_SUBSCRIPTION_AUTH_REQUIRED' : `SDK_${event.error.toUpperCase()}`;
        continue;
      }
      if (event.type === 'stream_event') {
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
      const normalized = normalizer.normalize(raw as unknown as RawStreamEvent);
      if (event.type === 'assistant' && normalized.some(e => e.kind === 'complete_message')) {
        activityStarted = true;
        const assistant = assistantMessage(event.message.id);
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
      }
    }
    if (req.abortController.signal.aborted) return finish('interrupted');
    if (failure) return finish('error');
    return finish(normalizer.observedSuccess ? 'completed' : normalizer.lastErrorInfo ? 'error' : 'no_final_result');
  } catch (error) {
    failure ??= String((error as Error).message);
    return finish(req.abortController.signal.aborted ? 'interrupted' : 'error');
  } finally {
    if (requestUsage) req.onEvent({ kind: 'usage', scope: 'request', usage: requestUsage, source: 'sdk_stream', completeness: 'partial' });
    releaseInput(false); run?.close();
  }

  function finish(outcome: RunnerRunResult['outcome']): RunnerRunResult {
    if (outcome !== 'completed') {
      const answered = new Set(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id));
      for (const m of messages) for (const call of (m.tool_calls ?? []) as Array<{ id: string }>) {
        if (!answered.has(call.id)) messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(executing.has(call.id)
          ? { error_code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN', outcome: 'unknown' }
          : { error_code: 'EXECUTION_NOT_STARTED', executed: false }) });
      }
    }
    if (host.purpose !== 'cache_keepalive') {
      if (outcome === 'completed' && normalizer.sessionId) sessions.set(host.windowId, { sessionId: normalizer.sessionId, prefixHash,
        messageCount: messages.length, messagesHash: sha256Hex(JSON.stringify(messages)) });
      else sessions.delete(host.windowId);
    }
    return {
      outcome, errorCode: failure && /^[A-Z][A-Z0-9_]+$/.test(failure) ? failure : outcome === 'error' ? 'SDK_ERROR' : null,
      errorClassified: failure && /network|timeout|fetch|ECONN/i.test(failure) ? 'network' : outcome === 'error' ? 'unknown' : null,
      errorMessage: failure, sessionId: normalizer.sessionId, requestId: null,
      subscriptionLimit: limit, activityStarted, attempts, finalMessages: messages, lastSentMessages,
    };
  }
}

// SDK counters are nullable; absent is unknown, never an observed zero.
function sdkUsageFields(usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): RawUsage {
  const result: RawUsage = {};
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    const value = usage[key];
    if (typeof value === 'number') result[key] = value;
  }
  return result;
}
