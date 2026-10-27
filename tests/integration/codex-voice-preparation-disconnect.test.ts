// 正式建呼选择 deep_listen 后验证准备阶段取消；只有外部供应商 transport 为 fake。
// 联合审计 A03（2026-10-27）：取消只停止回复（零模型请求保留），已接纳的 final 原话必须保存为
// 唯一正式消息（含归档意图）；turn 落终态不可派发。此前"零消息"断言是把丢记录当成功，已替换。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { request } from 'node:http';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import {tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';


async function runPhone(scenario: 'control' | 'disconnect-audio' | 'disconnect-after-ingest' | 'disconnect-before-analysis') {
  const root = tempRoot('codex-phone-prepare-');
  writeApprovedIdentity(root);
  const originalFetch = globalThis.fetch;
  process.env.AUDIT_DS_TOKEN = 'synthetic-only';
  process.env.AUDIT_SIREN_TOKEN = 'synthetic-only';
  process.env.AUDIT_OIDO_TOKEN = 'synthetic-only';
  process.env.ESTOMAGO_VOICE_INGRESS_TOKEN = 'synthetic-ingress';
  const holdAudio = scenario === 'disconnect-audio';
  const holdAnalyse = scenario === 'disconnect-after-ingest';
  let enterAudio!: () => void;
  const audioEntered = new Promise<void>(resolve => { enterAudio = resolve; });
  let releaseAudio!: () => void;
  const audioRelease = new Promise<void>(resolve => { releaseAudio = resolve; });
  let serverClosed!: () => void;
  const responseClosed = new Promise<void>(resolve => { serverClosed = resolve; });
  let modelRequests = 0, ingests = 0, analyses = 0;
  let enterAnalyse!: () => void;
  const analyseEntered = new Promise<void>(resolve => { enterAnalyse = resolve; });
  let releaseAnalyse!: () => void;
  const analyseRelease = new Promise<void>(resolve => { releaseAnalyse = resolve; });
  let analysesDispatched = 0;
  let enterTranscript!: () => void;
  const transcriptEntered = new Promise<void>(resolve => { enterTranscript = resolve; });
  let releaseTranscript!: () => void;
  const transcriptRelease = new Promise<void>(resolve => { releaseTranscript = resolve; });
  let audioSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'http://127.0.0.1:47901/v1/calls' && init?.method === 'POST') return Response.json({ call_id: 'audit-call', ws_url: 'ws://127.0.0.1:9/ws/call/audit-call', token: 'synthetic-call' });
    if (url === 'http://127.0.0.1:47901/v1/voice-assets/audit_audio/audio') {
      audioSignal = init?.signal;
      enterAudio();
      if (holdAudio) await audioRelease;
      return new Response(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x21]), { headers: { 'content-type': 'audio/webm' } });
    }
    if (url === 'http://127.0.0.1:47902/v1/audio:ingest') {
      ingests++;
      return Response.json({ audio_id: 'aud_audit', deduplicated: false });
    }
    if (url === 'http://127.0.0.1:47902/v1/audio/aud_audit/transcript') {
      enterTranscript();
      if (scenario === 'disconnect-before-analysis') await transcriptRelease;
      return Response.json({ stored: true });
    }
    if (url === 'http://127.0.0.1:47902/v1/analyses' && init?.method === 'POST') {
      analysesDispatched++;
      enterAnalyse();
      if (holdAnalyse) await analyseRelease;
      if (init.signal?.aborted) throw new Error('ABORTED_DURING_ANALYSE'); // 挂起中被取消=不完成
      analyses++;
      return Response.json({ analysis_id: 'run_audit', revision: 1, state: 'ready', range_ms: [0, 1000], observations: [] });
    }
    if (url === 'https://api.deepseek.com/chat/completions') {
      modelRequests++;
      const body = 'data: ' + JSON.stringify({ id: 'audit-model', choices: [{ delta: { content: '合成回答。' } }] }) + '\n\n' +
        'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } }) + '\n\ndata: [DONE]\n\n';
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error('UNEXPECTED_EXTERNAL_TRANSPORT:' + new URL(url).pathname);
  }) as typeof fetch;
  const patch = readyRuntimePatch();
  const config = buildConfig({ ...patch,
    runtime: { ...patch.runtime as object, provider: 'deepseek', tool_schema_mode: 'deferred' },
    deepseek: { model: 'deepseek-flash', api_key_env: 'AUDIT_DS_TOKEN', retry_max_attempts_after_initial: 0 },
    integrations: {
      siren: { base_url: 'http://127.0.0.1:47901', credential_ref: 'AUDIT_SIREN_TOKEN' },
      oido: { base_url: 'http://127.0.0.1:47902', credential_ref: 'AUDIT_OIDO_TOKEN' },
    },
  });
  let host: Host | null = null;
  try {
    host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
    await host.start();
    const owner = fs.readFileSync(host.auth.tokenFilePath(), 'utf8').trim();
    const created = await new Promise<number>((resolve, reject) => {
      const r = request(`http://127.0.0.1:${host!.port}/api/v1/calls`, { method: 'POST',
        headers: { authorization: 'Bearer ' + owner, 'content-type': 'application/json' } }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode!));
      });
      r.on('error', reject);
      r.end(JSON.stringify({ conversation_id: 'primary', analysis_mode: 'deep_listen' }));
    });
    assert.equal(created, 200);
    // Observe actual socket closure; do not substitute request handling.
    (host as any).server.on('request', (req: any, res: any) => { if (req.url === '/v1/chat/stream') res.once('close', serverClosed); });
    const body = JSON.stringify({ conversation_id: 'primary', call_id: 'audit-call', turn_id: 'audit-turn', modality: 'voice_call', text: '合成通话输入。', audio_ref: 'siren:audit_audio' });
    let clientClosed!: () => void;
    const clientDone = new Promise<void>(resolve => { clientClosed = resolve; });
    const req = request(`http://127.0.0.1:${host.port}/v1/chat/stream`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-ingress', 'Content-Type': 'application/x-ndjson', 'Content-Length': Buffer.byteLength(body) } }, res => {
      res.resume();
      res.once('end', clientClosed);
    });
    req.on('error', error => { if (scenario === 'control') throw error; clientClosed(); });
    req.end(body);
    await audioEntered;
    if (scenario !== 'control') {
      if (scenario === 'disconnect-after-ingest') await analyseEntered; // ingest 已成功（fake 立即返回），analyze 已挂起
      if (scenario === 'disconnect-before-analysis') await transcriptEntered;
      req.destroy();
      await responseClosed;
    }
    const abortedAtRelease = audioSignal?.aborted ?? false;
    releaseAudio();
    releaseTranscript();
    releaseAnalyse();
    // 放行全部迟到响应，等待真实 handler 的 Promise 链继续处理，不能靠悬挂 fake 得到零计数。
    await new Promise<void>(resolve => setImmediate(resolve));
    // The provider call, if wrongly enqueued, terminates through the real event stream.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const row = host.db.prepare('SELECT state FROM voice_stream_turns WHERE call_id=? AND turn_key=?').get('audit-call', 'audit-turn') as { state: string } | undefined;
      if (row && ['completed', 'failed', 'cancelled'].includes(row.state)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await host.supervisor.waitIdle();
    if (scenario === 'control') await clientDone;
    const result = {
      scenario, abortedAtRelease, ingests, analyses, analysesDispatched, modelRequests,
      receipts: host.db.prepare('SELECT est_asset_id,oido_audio_id FROM oido_ingest_receipts').all(),
      observation: host.db.prepare('SELECT direction,status,model_projection,dispatched_turn_id FROM voice_observations LIMIT 1').get() as Record<string, unknown> | undefined,
      messages: host.db.prepare('SELECT speaker, COUNT(*) AS count FROM messages GROUP BY speaker ORDER BY speaker').all(),
      stream: host.db.prepare('SELECT state FROM voice_stream_turns WHERE call_id=? AND turn_key=?').get('audit-call', 'audit-turn'),
      turns: host.db.prepare('SELECT state FROM turns').all(),
      owner: host.db.prepare(`SELECT m.id, m.kind, r.content, t.state AS turn_state, a.state AS attempt_state, a.blocked_reason,
          (SELECT derived_text FROM message_attachments ma WHERE ma.message_id=m.id AND ma.presentation='voice') AS derived_text,
          (SELECT COUNT(*) FROM outbox o WHERE o.operation_key='archive:'||m.id||':1') AS archive_intents,
          (SELECT est_turn_id FROM voice_stream_turns WHERE call_id='audit-call' AND turn_key='audit-turn') = t.id AS admission_linked
        FROM messages m JOIN message_revisions r ON r.message_id=m.id AND r.revision=m.current_revision
        JOIN turns t ON t.input_message_id=m.id JOIN attempts a ON a.turn_id=t.id WHERE m.speaker='owner'`).all() as Array<Record<string, unknown>>,
    } as Record<string, any>;
    console.log('AUDIT_PHONE_PREPARATION', JSON.stringify(result));
    // 同键重试返回原终态（不开模型、不重播音频）——在 host 存活期内直接复用真实 HTTP 入口
    if (scenario === 'disconnect-audio') {
      const retryBody = JSON.stringify({ conversation_id: 'primary', call_id: 'audit-call', turn_id: 'audit-turn', modality: 'voice_call', text: '合成通话输入。', audio_ref: 'siren:audit_audio' });
      const retryRes = await new Promise<string>((resolve) => {
        const r = request(`http://127.0.0.1:${host.port}/v1/chat/stream`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-ingress', 'Content-Type': 'application/x-ndjson', 'Content-Length': Buffer.byteLength(retryBody) } }, res => {
          let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b));
        });
        r.on('error', () => resolve(''));
        r.end(retryBody);
      });
      const doneLine = retryRes.split('\n').find(l => l.includes('"type":"done"'));
      const done = JSON.parse(doneLine ?? '{}');
      result.retry = { replayed: done.replayed === true, prior_state: done.prior_state ?? null, modelRequestsAfterRetry: modelRequests,
        ownerMessagesAfterRetry: (host.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE speaker='owner'").get() as { n: number }).n };
    }
    return result;
  } finally {
    releaseAudio();
    releaseTranscript();
    releaseAnalyse();
    if (host) await host.stop();
    globalThis.fetch = originalFetch;
    for (const key of ['AUDIT_DS_TOKEN', 'AUDIT_SIREN_TOKEN', 'AUDIT_OIDO_TOKEN', 'ESTOMAGO_VOICE_INGRESS_TOKEN']) delete process.env[key];
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('control: connected phone input with audio reaches the real model loop', { timeout: 10000 }, async () => {
  const result = await runPhone('control');
  assert.equal(result.modelRequests, 1);
  assert.equal(result.ingests, 1);
  assert.equal(result.analyses, 1);
});

test('disconnect during audio preparation must stop later analysis and model dispatch', { timeout: 10000 }, async () => {
  const result = await runPhone('disconnect-audio');
  assert.equal(result.abortedAtRelease, true, '父取消信号必须贯穿到取音频 fetch（修复前 false）');
  assert.equal(result.ingests, 0, 'ingest started after actual HTTP disconnect');
  assert.equal(result.analyses, 0, 'oído analysis started after actual HTTP disconnect');
  assert.equal(result.modelRequests, 0, 'model request started after actual HTTP disconnect');
  assert.equal(result.stream?.state, 'cancelled', '接纳记录收口为 cancelled');
  // 同键重试返回原终态（不开模型、不重播音频）
  assert.equal(result.retry.replayed, true, '同键重试=终态回执');
  assert.equal(result.retry.prior_state, 'cancelled');
  assert.equal(result.retry.modelRequestsAfterRetry, 0, '重试不开模型');
  assertSavedNotDispatched(result, 'text');
  assert.equal(result.retry.ownerMessagesAfterRetry, 1, '同键重试不产生第二条消息');
});

/** A03：取消后这句话仍是唯一正式消息（原声已存则带原声+可信转写），turn/attempt 终态不可派发。 */
function assertSavedNotDispatched(result: Record<string, any>, shape: 'text' | 'voice'): void {
  assert.equal(result.owner.length, 1, '已接纳的 final 保存为唯一正式消息');
  const m = result.owner[0];
  if (shape === 'text') {
    assert.equal(m.kind, 'text');
    assert.equal(m.content, '合成通话输入。');
  } else {
    assert.equal(m.kind, 'voice');
    assert.equal(m.derived_text, '合成通话输入。', '原声已保存：正文在可信转写快照');
  }
  assert.equal(m.turn_state, 'failed');
  assert.equal(m.attempt_state, 'failed');
  assert.equal(m.blocked_reason, 'CANCELLED_BEFORE_DISPATCH');
  assert.equal(m.archive_intents, 1, '归档意图随消息落库');
  assert.equal(m.admission_linked, 1, '接纳记录指向该 turn（通话记录可反查这句话）');
}

/** A06（联合审计 2026-10-27）：断线发生在持久分析任务进行中——交互停止（至多一次模型请求，
 *  替身即时返回时可能先于断开完成），但 deep_listen 的合法持久任务不随交互取消（B4.6）：
 *  分析晚到完成、只写观察行（无投影冻结/不改已派发历史）；消息仍唯一正式保留。 */
function assertLateAnalysisAfterDisconnect(result: Record<string, any>): void {
  assert.equal(result.ingests, 1, '持久分析任务的 ingest 已发生（回执保留）');
  assert.equal(result.analysesDispatched, 1, '分析由持久 worker 派发一次');
  assert.equal(result.analyses, 1, '分析晚到完成——交互断开不取消合法持久任务（B4.6）');
  assert.equal(result.receipts.length, 1, '数据库确实保留导入回执');
  assert.equal(result.receipts[0].oido_audio_id, 'aud_audit');
  assert.ok(result.modelRequests <= 1, '在途停止：模型请求至多一次（替身即时返回时可能先于断开完成）');
  assert.equal(result.stream?.state, 'cancelled', '接纳流收口为 cancelled');
  assert.equal(result.observation?.direction, 'user');
  assert.equal(result.observation?.status, 'ready', '晚到分析写入观察行');
  assert.equal(result.observation?.dispatched_turn_id, null, 'A06：迟到观察不改已派发历史');
  assert.equal(result.observation?.model_projection, null, 'A06：迟到结果只持久化/显示');
  assert.equal(result.owner.length, 1, '唯一正式消息保留');
  assert.equal(result.owner[0].kind, 'voice');
  assert.equal(result.owner[0].archive_intents, 1, '归档意图随消息落库');
}

test('A06：断线在持久分析任务中——交互停止、任务晚到完成、历史不改写', { timeout: 10000 }, async () => {
  assertLateAnalysisAfterDisconnect(await runPhone('disconnect-after-ingest'));
});

test('A06：断线在分析派发前——持久任务继续派发并完成，不重开交互回复', { timeout: 10000 }, async () => {
  assertLateAnalysisAfterDisconnect(await runPhone('disconnect-before-analysis'));
});
