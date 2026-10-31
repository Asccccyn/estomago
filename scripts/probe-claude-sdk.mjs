#!/usr/bin/env node
// A separate process owns the fake API, fake credentials and synthetic Claude home.
// Raw bodies stay in a temporary directory; this server never forwards requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fakeKey = 'sk-ant-est-synthetic-local-only';
const literalReminder = "<system-reminder>\nToday's date is USER_LITERAL_DO_NOT_STRIP.\n</system-reminder>";

if (process.argv[2] !== '--worker') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-sdk-capture-'));
  for (const name of ['home', 'config', 'workspace', 'state', 'captures']) fs.mkdirSync(path.join(root, name));
  for (const dir of ['workspace', 'config']) {
    fs.writeFileSync(path.join(root, dir, 'CLAUDE.md'), 'EST_UNWANTED_PROJECT_INSTRUCTIONS');
    fs.mkdirSync(path.join(root, dir, '.claude', 'skills', 'unwanted'), { recursive: true });
    fs.writeFileSync(path.join(root, dir, '.claude', 'skills', 'unwanted', 'SKILL.md'), '---\nname: unwanted\ndescription: EST_UNWANTED_SKILL\n---\nEST_UNWANTED_SKILL');
    fs.writeFileSync(path.join(root, dir, '.mcp.json'), JSON.stringify({ mcpServers: { unwanted: { type: 'http', url: 'http://127.0.0.1:1' } } }));
  }
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [import.meta.filename, '--worker', root], {
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
        HOME: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'config'),
        ESTOMAGO_HOME: path.join(root, 'state'), ESTOMAGO_TEST_MODE: '1',
        OPENROUTER_API_KEY: 'EST_FAKE_OR_KEY_MUST_STAY_OUT', ANTHROPIC_AUTH_TOKEN: 'EST_FAKE_AUTH_MUST_STAY_OUT',
      },
    });
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
  console.log(JSON.stringify({ captureDirectory: path.join(root, 'captures'), exitCode: result }));
  process.exitCode = result;
} else {
  const root = process.argv[3];
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const captures = [];
  const events = [];
  let mode;
  let invokeDefinitionId;
  let reviewDefinitionId;
  let reviewId;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":100}');
      return;
    }
    if (req.method !== 'POST' || !pathname.endsWith('/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const payload = JSON.parse(body);
    captures.push({ mode, payload, clientEntry: String(req.headers['user-agent'] ?? '').includes('sdk-ts') ? 'sdk-ts' : 'other' });
    const step = captures.filter(c => c.mode === mode).length;
    const toolStep = mode === 'est-tool' || mode === 'est-host-tool' ? [
      { name: 'tool_catalog', input: {} },
      { name: 'tool_define', input: { name: 'wake_manage' } },
      { name: 'tool_invoke', input: { name: 'wake_manage', definition_id: invokeDefinitionId, arguments: mode === 'est-host-tool'
        ? { operation: 'schedule', operation_id: 'synthetic-wake-once', delay_seconds: 1, note: 'EST_SYNTHETIC_WAKE_NOTE' } : { operation: 'list' } } },
    ][step - 1] : null;
    const frames = [
      { type: 'message_start', message: { id: `msg_probe_${captures.length}`, type: 'message', role: 'assistant', model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 } } },
      { type: 'content_block_start', index: 0, content_block: toolStep ? { type: 'tool_use', id: `tool_probe_${captures.length}`, name: `mcp__est__${toolStep.name}`, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: toolStep ? { type: 'input_json_delta', partial_json: JSON.stringify(toolStep.input) } : { type: 'text_delta', text: mode === 'est-keepwarm' || mode === 'est-host-keepwarm' ? '1' : 'synthetic probe response' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: toolStep ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    if (mode === 'est-review-batch') {
      const batch = step === 1 ? [{ name: 'tool_define', input: { name: 'context_review_complete' } }]
        : step === 2 ? [{ name: 'tool_define', input: { name: 'wake_manage' } }]
        : step === 3 ? [
          { name: 'tool_invoke', input: { name: 'context_review_complete', definition_id: reviewDefinitionId, arguments: { review_id: reviewId, decision: 'no_new_hold' } } },
          { name: 'tool_invoke', input: { name: 'wake_manage', definition_id: invokeDefinitionId, arguments: { operation: 'schedule', operation_id: 'synthetic-review-peer', delay_seconds: 600, note: 'EST_SYNTHETIC_REVIEW_PEER' } } },
        ] : [];
      if (!batch.length) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'REVIEW_REQUESTED_AN_UNNECESSARY_MODEL_ROUND' } }));
        return;
      }
      frames.splice(1, frames.length - 1,
        ...batch.flatMap((tool, index) => [
          { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `tool_review_${captures.length}_${index}`, name: `mcp__est__${tool.name}`, input: {} } },
          { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } },
          { type: 'content_block_stop', index },
        ]),
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' });
    }
    if (mode === 'est-host-thinking') {
      frames.find(f=>f.type==='message_delta').usage.output_tokens_details={thinking_tokens:4};
      for (const f of frames) if ('index' in f) f.index = 1;
      frames.splice(1,0,
        {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},
        {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'SYNTHETIC_SDK_THINKING'}},
        {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'SYNTHETIC_SIGNATURE'}},
        {type:'content_block_stop',index:0});
    }
    if (mode === 'est-host-flag') frames.find(f=>f.type==='message_delta').delta.stop_reason='refusal';
    if (mode === 'est-host-cancel') {
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write(frames.slice(0,3).map(f=>`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(''));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const env = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    HOME: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'config'),
    ANTHROPIC_API_KEY: fakeKey, ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  const summary = [];
  try {
    const prompts = {
      preset: { type: 'preset', preset: 'claude_code' },
      append: { type: 'preset', preset: 'claude_code', append: 'EST_SYNTHETIC_APPEND_MARKER' },
      custom: 'EST_SYNTHETIC_PERSONA. You are a fictional companion. Never claim that synthetic tool results are real actions.',
      unspecified: undefined,
    };
    for (const [name, systemPrompt] of Object.entries(prompts)) {
      mode = name;
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), 45_000);
      const run = query({
        prompt: 'EST_SYNTHETIC_USER hello',
        options: {
          ...(systemPrompt === undefined ? {} : { systemPrompt }),
          model: 'claude-sonnet-4-6', cwd: path.join(root, 'workspace'),
          tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, skills: [],
          settings: { autoMemoryEnabled: false, disableClaudeAiConnectors: true },
          includePartialMessages: true, maxTurns: 1, abortController, env,
        },
      });
      try {
        for await (const event of run) events.push({ mode, event });
      } finally { clearTimeout(timer); run.close(); }
      const requests = captures.filter(c => c.mode === name);
      const result = events.findLast(e => e.mode === name && e.event.type === 'result')?.event;
      summary.push({
        mode, requests: requests.length, result: result?.subtype ?? null,
        system: requests.map(({ payload }) => (payload.system ?? []).map(b => ({ characters: b.text?.length ?? 0, hash: hash(b.text), cache_control: b.cache_control ?? null }))),
        tools: requests.map(({ payload }) => (payload.tools ?? []).map(t => t.name)),
        messagesHash: requests.map(({ payload }) => hash(payload.messages)),
      });
      console.log(JSON.stringify(summary.at(-1)));
      if (!requests.length || result?.subtype !== 'success') throw Error(`PROBE_FAILED:${name}`);
    }
    const { buildConfig } = await import('../apps/host/src/config/schema.ts');
    const { subscriptionSdkOptions } = await import('../apps/host/src/runtime/build-options.ts');
    const { runSdkHostQuery } = await import('../apps/host/src/runtime/sdk-host-query.ts');
    const { proxyOnlySdkSpawn } = await import('../apps/host/src/runtime/sdk-network.ts');
    const { makeDb, makePaths, writeApprovedIdentity, readyRuntimePatch, assembleTestTools } = await import('../tests/helpers.ts');
    const { IdentityService } = await import('../apps/host/src/identity/service.ts');
    const { WindowManager } = await import('../apps/host/src/windows/manager.ts');
    const { EventService } = await import('../apps/host/src/events/service.ts');
    const { MessageService } = await import('../apps/host/src/messages/service.ts');
    const { freezeWindowTools, definitionId } = await import('../apps/host/src/runtime/tool-discovery.ts');
    const { BackgroundSettingsService } = await import('../apps/host/src/runtime/background-settings.ts');
    const { BackgroundTaskService } = await import('../apps/host/src/runtime/background-task-service.ts');
    const { RotationReviewService } = await import('../apps/host/src/context/rotation-review.ts');
    const { HoldCheckpointService } = await import('../apps/host/src/memory/hold-checkpoint.ts');
    const { db } = makeDb(path.join(root, 'state'));
    writeApprovedIdentity(path.join(root, 'state'));
    const config = buildConfig({ ...readyRuntimePatch(), runtime: { ...readyRuntimePatch().runtime, model: 'claude-sonnet-4-6', tool_schema_mode: 'deferred' }, background: { keepwarm: { sleep_window: { enabled: false } } } });
    const paths = makePaths(path.join(root, 'state'));
    const identity = new IdentityService(config, paths);
    const gate = identity.evaluateGate(db);
    const materials = identity.loadVerifiedMaterials(gate.manifest);
    const messageService = new MessageService(db);
    messageService.ensureConversation('synthetic');
    const windows = new WindowManager(db, new EventService(db), identity, config);
    let window = windows.createWindow({ conversationId: 'synthetic', gate }).window;
    let nowMs = Date.now();
    const bgSettings = new BackgroundSettingsService(db, config);
    const taskService = new BackgroundTaskService(db, bgSettings, () => nowMs);
    const reviews = new RotationReviewService(db);
    const checkpoint = new HoldCheckpointService(db);
    const { tools: executor, registry } = assembleTestTools({ db, taskService, reviews, checkpoint });
    invokeDefinitionId = definitionId(registry.currentCatalog().find(t => t.function.name === 'wake_manage'));
    reviewDefinitionId = definitionId(registry.currentCatalog().find(t => t.function.name === 'context_review_complete'));
    let sessions = new Map();
    let canonical = [{ role: 'system', content: `${materials.identityText}\n${materials.rulesText}\n${materials.iText}` }];
    let toolExecutions = 0;
    for (const name of ['est-first', 'est-followup', 'est-tool', 'est-resume', 'est-restart', 'est-rotation', 'est-wake', 'est-keepwarm', 'est-literal', 'est-bare-comparison']) {
      mode = name;
      if (name === 'est-restart' || name === 'est-bare-comparison') sessions = new Map();
      if (name === 'est-rotation') {
        const rotated = windows.rotate({ conversationId: 'synthetic', gate, maxSequence: 0 });
        if (!rotated.ok) throw Error(rotated.reason);
        window = rotated.window; sessions = new Map();
      }
      const submission = messageService.submitUserMessageWithTurn({ conversationId: 'synthetic', content: `EST_SYNTHETIC_USER ${name}`, clientMessageId: name });
      canonical = [...canonical, { role: 'user', content: name === 'est-wake' ? '[host_event] 合成自动唤醒，不是用户发言' : name === 'est-keepwarm' ? '[host_event] 合成心跳，可回复1' : name === 'est-literal' ? literalReminder : `EST_SYNTHETIC_USER ${name}` }];
      const toolset = freezeWindowTools(db, window.id, registry.currentCatalog(), 'deferred');
      const assembled = subscriptionSdkOptions(config, canonical[0].content, paths.workspacesDir);
      assembled.options.env = { ...assembled.options.env, ...env };
      if (name === 'est-resume') assembled.options.env.CLAUDE_CODE_OVERRIDE_DATE = '2026-10-30';
      if (name === 'est-bare-comparison') assembled.options.env.CLAUDE_CODE_SIMPLE = '1';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      let requestId;
      const result = await runSdkHostQuery(query, {
        prompt: '', options: assembled, resumeSessionId: null, abortController: controller,
        onEvent: event => events.push({ mode, event }),
        host: {
          windowId: window.id, purpose: name === 'est-keepwarm' ? 'cache_keepalive' : 'chat', envelope: { model: config.runtime.model, sessionId: window.id, messages: canonical, tools: toolset, boundaries: [], maxTokens: 1024, reasoning: null },
          maxModelRequests: 8,
          beforeModel: async (messages, round) => {
            requestId = `${name}-${round}`;
            db.prepare('INSERT INTO provider_requests(id,window_id,attempt_id,turn_id,purpose,seen_manifest_json,payload_json,sent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
              .run(requestId, window.id, submission.attemptId, submission.turnId, 'chat', '[]', JSON.stringify({ tools: toolset, messages }), new Date().toISOString(), new Date().toISOString());
          },
          modelStarted: () => {},
          executeTool: async (tool, args, toolCallId, round) => {
            toolExecutions++;
            const output = await executor.execute(tool, args, { roomId: 'synthetic', windowId: window.id, turnId: submission.turnId, requestId,
              purpose: 'chat', activeReviewId: null, seenSequence: 0, seenMessages: [], toolCallId, round, attemptId: submission.attemptId });
            if (!output.ok) throw Error(`REAL_HOST_EXECUTOR_FAILED:${JSON.stringify(output.output)}`);
            return output;
          },
        },
      }, sessions, async () => null, proxyOnlySdkSpawn(baseUrl)); // synthetic transport only; deliberately NOT an authentication test
      clearTimeout(timer);
      const requests = captures.filter(c => c.mode === name);
      summary.push({ mode, requests: requests.length, outcome: result.outcome, error: result.errorCode, sessionId: result.sessionId, toolExecutions,
        systemHashes: requests.map(c => hash(c.payload.system)), toolsHashes: requests.map(c => hash(c.payload.tools)),
        tools: requests.map(c => c.payload.tools.map(t => t.name)) });
      console.log(JSON.stringify(summary.at(-1)));
      if (!requests.length || result.outcome !== 'completed') throw Error(`EST_PROBE_FAILED:${name}:${result.errorMessage}`);
      canonical = result.finalMessages;
    }
    if (toolExecutions !== 3) throw Error('DUPLICATE_OR_MISSING_HOST_EXECUTION');
    const rebuilt = captures.find(c => c.mode === 'est-restart')?.payload.messages ?? [];
    if (!rebuilt.some(m => m.role === 'assistant') || JSON.stringify(rebuilt).includes('<est_history>')) throw Error('SDK_HISTORY_ROLES_NOT_REBUILT');
    const historicalCalls = rebuilt.filter(m => m.role === 'assistant').flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_use') : []);
    const historicalResults = rebuilt.filter(m => m.role === 'user').flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : []);
    if (historicalCalls.length !== 3 || historicalCalls.some(call => !historicalResults.some(result => result.tool_use_id === call.id))) throw Error('SDK_HISTORY_TOOL_PAIRS_LOST');
    summary.push({ mode: 'native-history-replay', roleSequence: rebuilt.map(m => m.role), historicalToolPairs: historicalCalls.length, historicalToolsReexecuted: false });
    const { TurnSupervisor } = await import('../apps/host/src/runtime/supervisor.ts');
    const { WindowTrajectoryService } = await import('../apps/host/src/runtime/window-trajectory.ts');
    const { CapabilityMatrix } = await import('../apps/host/src/runtime/capabilities.ts');
    const { ReasoningService } = await import('../apps/host/src/reasoning/service.ts');
    const { RoutingService } = await import('../apps/host/src/routing/service.ts');
    const { UsageCollector } = await import('../apps/host/src/usage/collector.ts');
    const { Logger } = await import('../apps/host/src/observability/logging.ts');
    const { BackgroundScheduler } = await import('../apps/host/src/runtime/background-scheduler.ts');
    const { SystemAlertService } = await import('../apps/host/src/observability/system-alerts.ts');
    const { ConversationActivityService } = await import('../apps/host/src/runtime/wake-activity.ts');
    const { bindMessageLifecycle } = await import('../apps/host/src/application/message-lifecycle.ts');
    const { createBackgroundExecution } = await import('../apps/host/src/application/background-execution.ts');
    const hostEvents = new EventService(db);
    const activity = new ConversationActivityService(db);
    const hostMessages = new MessageService(db, bindMessageLifecycle({ activity, surfacing: null }), activity);
    hostMessages.ensureConversation('primary');
    const trajectory = new WindowTrajectoryService(db);
    const hostSessions = new Map();
    let cancelTurnId = null; let abortAt = null;
    const nativeRunner = { kind: 'claude-agent-sdk', interruptSupport: 'claimed', run: req => {
      req.options.options.env = { ...req.options.options.env, ...env };
      const onEvent = req.onEvent;
      req.onEvent = event => {
        events.push({mode,event}); onEvent(event);
        if (mode === 'est-host-cancel' && event.kind === 'text_delta' && abortAt === null) {
          abortAt = Date.now(); supervisor.stop(cancelTurnId);
        }
      };
      return runSdkHostQuery(query, req, hostSessions, async () => null, proxyOnlySdkSpawn(baseUrl));
    } };
    const supervisor = new TurnSupervisor({ db, config, messages: hostMessages, events: hostEvents, identity, windows, trajectory,
      runnerSelection: { status: 'ok', runner: nativeRunner }, capabilities: new CapabilityMatrix(config), tools: executor, toolCatalog: registry,
      reasoning: new ReasoningService(db, hostEvents), routing: new RoutingService(db, hostEvents, hostMessages),
      usage: new UsageCollector(db), logger: new Logger(null), activity, reviews, checkpoint, now: () => nowMs });
    bgSettings.applyUpdate({ expectedRevision: bgSettings.revision(), patch: { autonomous_enabled: true, autonomous_daily_cost_cap_usd: 5 } });
    for (const name of ['est-host-first', 'est-host-tool', 'est-host-thinking']) {
      mode = name;
      const input = hostMessages.submitUserMessageWithTurn({ conversationId: 'primary', content: `EST_SYNTHETIC_USER ${name}`, clientMessageId: name });
      supervisor.enqueue(input.turnId); await supervisor.waitIdle();
      const state = db.prepare('SELECT state FROM turns WHERE id=?').get(input.turnId).state;
      summary.push({ mode, state, requests: captures.filter(c => c.mode === mode).length });
      console.log(JSON.stringify(summary.at(-1)));
      if (state !== 'completed') throw Error('HOST_TURN_FAILED:' + JSON.stringify(db.prepare('SELECT blocked_reason FROM attempts WHERE turn_id=?').all(input.turnId)));
    }
    const thinking = db.prepare("SELECT received_text,final_text FROM reasoning_blocks WHERE visibility='summary' AND received_text='SYNTHETIC_SDK_THINKING'").get();
    if (!thinking || thinking.final_text !== thinking.received_text || !events.some(e=>e.mode==='est-host-thinking'&&e.event.kind==='thinking_delta')) throw Error('SDK_THINKING_MAPPING_FAILED');
    if (!events.some(e=>e.mode==='est-host-thinking'&&e.event.kind==='usage'&&e.event.usage.reasoning_tokens===4)) throw Error('SDK_THINKING_USAGE_MISSING');
    const taskCount = db.prepare("SELECT COUNT(*) n FROM background_tasks WHERE origin='self_schedule'").get().n;
    if (taskCount !== 1) throw Error('HOST_TOOL_SIDE_EFFECT_COUNT:' + taskCount);
    const modelRequests = db.prepare("SELECT COUNT(*) n FROM provider_requests p JOIN turns t ON t.id=p.turn_id WHERE t.conversation_id='primary' AND p.sent_at IS NOT NULL").get().n;
    const usageRows = db.prepare("SELECT u.scope,u.input_tokens,u.cache_creation_input_tokens FROM usage_observations u JOIN turns t ON t.id=u.turn_id WHERE t.conversation_id='primary' AND u.scope='request'").all();
    if (usageRows.length !== modelRequests || usageRows.some(u => u.scope !== 'request' || u.input_tokens !== 100 || u.cache_creation_input_tokens !== 100)) throw Error('SDK_USAGE_DOUBLE_COUNTED_OR_MISSCOPED');
    let scheduler;
    const alerts = new SystemAlertService(db, hostEvents);
    const backgroundExecutor = createBackgroundExecution({ messages: hostMessages, events: hostEvents, bgSettings, supervisor,
      scheduler: { recordDispatchStart: input => scheduler.recordDispatchStart(input) } });
    scheduler = new BackgroundScheduler({ db, config, settings: bgSettings, alerts, executor: backgroundExecutor, now: () => nowMs });
    mode = 'est-host-wake'; nowMs += 2000;
    scheduler.start();
    try { await scheduler.tick(); await supervisor.waitIdle(); } finally { scheduler.stop(); }
    const wake = db.prepare("SELECT state,result_code FROM background_runs WHERE kind='autonomous' ORDER BY rowid DESC LIMIT 1").get();
    summary.push({ mode, ...wake, requests: captures.filter(c => c.mode === mode).length });
    console.log(JSON.stringify(summary.at(-1)));
    if (!captures.some(c => c.mode === mode) || wake?.state !== 'completed') throw Error('HOST_WAKE_FAILED:' + JSON.stringify(wake));
    bgSettings.applyUpdate({ expectedRevision: bgSettings.revision(), patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 5 } });
    const hostWindow = windows.activeWindow('primary');
    const beforeKeepwarm = hash(trajectory.forWindow(hostWindow.id).messages);
    const parentSession = hostSessions.get(hostWindow.id)?.sessionId;
    const messageCount = db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id='primary'").get().n;
    mode = 'est-host-keepwarm'; nowMs = Date.parse(activity.get('primary').last_real_activity_at) + 50 * 60_000 + 1000;
    scheduler.start();
    try { await scheduler.tick(); await supervisor.waitIdle(); } finally { scheduler.stop(); }
    const keepwarm = db.prepare("SELECT state,result_code,retention FROM background_runs WHERE kind='keepwarm' ORDER BY rowid DESC LIMIT 1").get();
    summary.push({ mode, ...keepwarm, requests: captures.filter(c => c.mode === mode).length,
      ledgerUnchanged: beforeKeepwarm === hash(trajectory.forWindow(hostWindow.id).messages),
      messagesUnchanged: messageCount === db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id='primary'").get().n,
      parentSessionUnchanged: parentSession === hostSessions.get(hostWindow.id)?.sessionId });
    console.log(JSON.stringify(summary.at(-1)));
    if (!captures.some(c => c.mode === mode) || keepwarm?.retention !== 'ephemeral_ack' || !summary.at(-1).ledgerUnchanged || !summary.at(-1).messagesUnchanged || !summary.at(-1).parentSessionUnchanged) throw Error('HOST_KEEPWARM_FAILED');
    mode = 'est-review-batch';
    const reviewMessage = hostMessages.submitUserMessageWithTurn({ conversationId: 'primary', content: 'EST_SYNTHETIC_REVIEW', clientMessageId: mode });
    const review = reviews.create(hostWindow.id, 'primary', hostWindow.revision, [{ id: reviewMessage.message.id, revision: 1, seq: reviewMessage.message.sequence, origin: 'dialogue', visible: true }]);
    reviewId = review.id;
    const reviewTrace = [];
    const reviewMessages = [...trajectory.forWindow(hostWindow.id).messages, { role: 'user', content: 'EST_SYNTHETIC_REVIEW' }];
    const reviewTools = freezeWindowTools(db, hostWindow.id, registry.currentCatalog(), 'deferred');
    const reviewOptions = subscriptionSdkOptions(config, reviewMessages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : m.content.map(b => b.text).join('\n')).join('\n\n'), paths.workspacesDir);
    reviewOptions.options.env = { ...reviewOptions.options.env, ...env };
    let reviewRequestId;
    const reviewed = await runSdkHostQuery(query, { prompt: '', options: reviewOptions, resumeSessionId: null, abortController: new AbortController(), onEvent: e => events.push({ mode, event: e }),
      host: { windowId: hostWindow.id, purpose: 'pre_rotate_review', envelope: { model: config.runtime.model, sessionId: hostWindow.id, messages: reviewMessages, tools: reviewTools, boundaries: [], maxTokens: 1024, reasoning: null }, maxModelRequests: 8,
        beforeModel: async (messages, round) => {
          reviewRequestId = `review-${round}`;
          db.prepare('INSERT INTO provider_requests(id,window_id,attempt_id,turn_id,purpose,seen_manifest_json,payload_json,sent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(reviewRequestId, hostWindow.id, reviewMessage.attemptId, reviewMessage.turnId, 'pre_rotate_review', '[]', JSON.stringify({ tools: reviewTools, messages }), new Date().toISOString(), new Date().toISOString());
        }, modelStarted() {},
        executeTool: async (name, args, toolCallId, round) => {
          reviewTrace.push(name === 'tool_invoke' ? args.name : name);
          return executor.execute(name, args, { roomId: 'primary', windowId: hostWindow.id, turnId: reviewMessage.turnId, attemptId: reviewMessage.attemptId, requestId: reviewRequestId,
            purpose: 'pre_rotate_review', activeReviewId: review.id, seenSequence: reviewMessage.message.sequence, seenMessages: [{ id: reviewMessage.message.id, revision: 1 }], toolCallId, round });
        } },
    }, new Map(), async () => null, proxyOnlySdkSpawn(baseUrl));
    summary.push({ mode, outcome: reviewed.outcome, reviewStatus: reviews.get(review.id)?.status, executionOrder: reviewTrace, requests: captures.filter(c => c.mode === mode).length });
    console.log(JSON.stringify(summary.at(-1)));
    if (reviewed.outcome !== 'completed' || reviews.get(review.id)?.status !== 'completed' || reviewTrace.slice(-2).join(',') !== 'wake_manage,context_review_complete') throw Error('NATIVE_REVIEW_ORDER_FAILED');
    mode = 'est-parallel-history';
    let replayedTools = 0;
    const replayedBatch = await runSdkHostQuery(query, { prompt: '', options: reviewOptions, resumeSessionId: null, abortController: new AbortController(), onEvent: e => events.push({ mode, event: e }),
      host: { windowId: hostWindow.id, purpose: 'chat', envelope: { model: config.runtime.model, sessionId: hostWindow.id,
        messages: [...reviewed.finalMessages, { role: 'user', content: 'SYNTHETIC_AFTER_COMPLETED_PARALLEL_TOOLS' }], tools: reviewTools, boundaries: [], maxTokens: 1024, reasoning: null }, maxModelRequests: 2,
        beforeModel: async () => {}, modelStarted() {}, executeTool: async () => { replayedTools++; throw Error('HISTORICAL_TOOL_REEXECUTED'); } },
    }, new Map(), async () => null, proxyOnlySdkSpawn(baseUrl));
    const batchWire = captures.find(c => c.mode === mode)?.payload.messages ?? [];
    const batchIndex = batchWire.findLastIndex(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.filter(b => b.type === 'tool_use').length === 2);
    const resultBatch = batchWire[batchIndex + 1];
    if (replayedBatch.outcome !== 'completed' || replayedTools !== 0 || batchIndex < 0 || resultBatch?.role !== 'user' || resultBatch.content.filter(b => b.type === 'tool_result').length !== 2) throw Error('HISTORICAL_TOOL_BATCH_NOT_PRESERVED');
    summary.push({ mode, historicalToolResultsInOneBatch: 2, historicalToolsReexecuted: replayedTools, requests: captures.filter(c => c.mode === mode).length });
    const serialized = JSON.stringify(captures);
    for (const marker of ['EST_UNWANTED_PROJECT_INSTRUCTIONS', 'EST_UNWANTED_SKILL', 'EST_FAKE_OR_KEY_MUST_STAY_OUT', 'EST_FAKE_AUTH_MUST_STAY_OUT']) {
      if (serialized.includes(marker)) throw Error('UNEXPECTED_INPUT_SOURCE:' + marker);
    }
    for (const group of [['est-first', 'est-followup', 'est-tool', 'est-resume'], ['est-host-first', 'est-host-tool', 'est-host-wake', 'est-host-keepwarm']]) {
      const requests = captures.filter(c => group.includes(c.mode));
      if (new Set(requests.map(c => hash(c.payload.system))).size !== 1 || new Set(requests.map(c => hash(c.payload.tools))).size !== 1) throw Error('UNSTABLE_WINDOW_PREFIX');
      for (const { payload } of requests) {
        if (payload.tools.map(t => t.name).join(',') !== 'mcp__est__tool_catalog,mcp__est__tool_define,mcp__est__tool_invoke') throw Error('UNEXPECTED_TOOL_DIRECTORY');
        if (!payload.system.some(b => b.cache_control?.ttl === '1h')) throw Error('ONE_HOUR_CACHE_NOT_REQUESTED');
      }
    }
    const estimateRows = db.prepare("SELECT u.cost_usd,u.input_tokens,u.raw_usage_json,p.purpose FROM usage_observations u JOIN provider_requests p ON p.id=u.request_id JOIN turns t ON t.id=u.turn_id WHERE t.conversation_id='primary' AND u.scope='cumulative' ORDER BY u.rowid").all();
    const estimates = estimateRows.map(row => JSON.parse(row.raw_usage_json));
    if (estimateRows.length !== 5 || estimateRows.some(row => row.cost_usd !== null || row.input_tokens !== null)) throw Error('SDK_ESTIMATE_MIXED_WITH_REQUEST_USAGE');
    const fork = estimates.at(-1);
    if (fork.scope !== 'sdk_session_cumulative' || !fork.fork_session || fork.resumed_from_session_id !== parentSession || fork.session_id === parentSession) throw Error('SDK_FORK_ESTIMATE_SCOPE_LOST');
    if (estimates[1].resumed_from_session_id !== estimates[0].session_id || estimates[2].resumed_from_session_id !== estimates[1].session_id) throw Error('SDK_RESUME_ESTIMATE_SCOPE_LOST');
    summary.push({ mode: 'sdk-estimates', observations: estimates, monetaryRequestCosts: estimateRows.map(row => row.cost_usd) });
    console.log(JSON.stringify({ mode: 'sdk-estimates', count: estimates.length, forkScopePreserved: true, actualChargesUnknown: true }));
    mode='est-host-cancel';
    const cancelInput=hostMessages.submitUserMessageWithTurn({conversationId:'primary',content:'SYNTHETIC_CANCEL',clientMessageId:mode});cancelTurnId=cancelInput.turnId;
    supervisor.enqueue(cancelTurnId);await supervisor.waitIdle();
    const cancelled=db.prepare('SELECT state FROM turns WHERE id=?').get(cancelTurnId);
    const cancelMs=abortAt===null?null:Date.now()-abortAt;
    if(cancelled?.state!=='interrupted'||cancelMs===null||cancelMs>5000)throw Error('SDK_INTERRUPT_NOT_VERIFIED');
    summary.push({mode,state:cancelled.state,abort_to_end_ms:cancelMs});
    mode='est-host-flag';
    const flagInput=hostMessages.submitUserMessageWithTurn({conversationId:'primary',content:'SYNTHETIC_FLAG',clientMessageId:mode});
    supervisor.enqueue(flagInput.turnId);await supervisor.waitIdle();
    const flagState=db.prepare('SELECT state FROM turns WHERE id=?').get(flagInput.turnId)?.state;
    const flagRequests=captures.filter(c=>c.mode===mode).length;
    // The runtime can start its refusal-recovery request before the host receives
    // the stream notice. Assert the host gate, not an invented one-request limit.
    if(flagState!=='route_owner_pending'||flagRequests<1)throw Error('SDK_FLAG_NOT_ROUTED');
    summary.push({mode,state:flagState,requests:flagRequests});
    const cleanRequests = captures.filter(c => c.mode.startsWith('est-') && c.mode !== 'est-bare-comparison');
    for (const { payload, clientEntry } of cleanRequests) {
      if (clientEntry !== 'sdk-ts') throw Error('SDK_ENTRYPOINT_CHANGED');
      if (!payload.system[0]?.text.startsWith('x-anthropic-billing-header:') || !payload.system[0].text.includes('cc_entrypoint=sdk-ts;')) throw Error('SDK_SUBSCRIPTION_ATTRIBUTION_STRIPPED');
      if (payload.system[1]?.text !== 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.') throw Error('SDK_NATIVE_IDENTITY_CHANGED');
      const blocks = payload.messages.flatMap(m => Array.isArray(m.content) ? m.content : []);
      if (blocks.some(b => b.type === 'text' && b.text !== literalReminder && /^<system-reminder>\s*(# Environment|You are powered by|Today's date is|The date has changed)/.test(b.text))) throw Error('SDK_AMBIENT_REMINDER_REMAINED');
    }
    if (!captures.find(c => c.mode === 'est-literal')?.payload.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.text === literalReminder))) throw Error('USER_LITERAL_REMINDER_WAS_MODIFIED');
    const hostSystemBlocks = trajectory.forWindow(hostWindow.id).messages.filter(m => m.role === 'system')
      .flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text));
    const { THINKING_LANGUAGE_RULE } = await import('../apps/host/src/runtime/build-options.ts');
    // The pinned runtime joins custom system strings with two newlines.
    if (captures.find(c => c.mode === 'est-host-first')?.payload.system.slice(2).map(b => b.text).join('\n\n') !== [...hostSystemBlocks, THINKING_LANGUAGE_RULE].join('\n\n')) throw Error('HOST_SYSTEM_BLOCKS_CHANGED');
    if (cleanRequests.some(c => c.payload.system.map(b => b.text).join('\n\n').split(THINKING_LANGUAGE_RULE).length !== 2)) throw Error('THINKING_LANGUAGE_RULE_MISSING_OR_DUPLICATED');
    summary.push({ mode: 'prompt-cleanliness', requests: cleanRequests.length, nativeAttributionPreserved: true, nativeSdkIdentityPreserved: true, hostSystemPreserved: true, ambientRemindersRemoved: true, userLiteralPreserved: true, clientEntry: 'sdk-ts' });
    if (!captures.find(c=>c.mode==='custom')?.payload.system.some(b=>b.text===prompts.custom)) throw Error('CUSTOM_SYSTEM_PROMPT_NOT_SERIALIZED');
    const sdkVersion=JSON.parse(fs.readFileSync(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json',import.meta.url),'utf8')).version;
    fs.writeFileSync(path.join(root,'captures','capabilities.json'),JSON.stringify({sdk_version:sdkVersion,observed_at:new Date().toISOString(),verification_scope:'official_runtime_local_transport',upstream:'loopback_synthetic',
      probes:{system_prompt_explicit:'supported',settings_sources_isolated:'supported',interrupt_supported:'supported',thinking_delta_observed:'supported',complete_block_mapping_verified:'supported'},
      evidence:{requests:'requests.json',events:'events.json',summary:'summary.json'},
      note:'These are observed SDK adapter capabilities. No real provider inference, semantic obedience or subscription billing is verified.'},null,2));
    await supervisor.stopAll();
    db.close();
  } finally {
    fs.writeFileSync(path.join(root, 'captures', 'requests.json'), JSON.stringify(captures, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'captures', 'events.json'), JSON.stringify(events, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'captures', 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
    await new Promise(resolve => server.close(resolve));
  }
}
