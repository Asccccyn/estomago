// 审计 B2 修复（2026-10-25，Codex 独立复审）：取代旧版两场景测试——旧版悬挂 fake（releaseAnalyse
// 从不释放、计数在等待之后递增）导致"analyses:0"只是完成数而非派发数，且未查 oido_ingest_receipts。
// 本版：放行全部迟到响应、分别记录派发/完成、查询真实回执，并补"分析派发中断线"第四场景。
// 一次性只读审计复现：真实 Host/HTTP，只有外部 Siren/oído/DS transport 为 fake。
// 场景：用户正常电话输入携带原声，在原声取回过程中断开连接。
// 前置经真实 HTTP 入口建立；不直接写业务表、不替换 handler/registry/supervisor。
// P08 批次1（审计修复复现迁入正式目录，源=一次性审计复现 codex-voice-preparation-disconnect）：
// 真实 Host/HTTP/数据库，只有外部 Siren/oído/DS transport 为 fake。
// 场景①control：正常电话输入（音频→ingest→analyze→模型）各一次。
// 场景②disconnect-audio：取音频期间真实 socket 断开——修复后：父取消贯穿 fetch、ingest/analyze/model 不启动、
//   接纳记录 cancelled、同键重试返回原终态。
// 场景③disconnect-after-ingest：ingest 已成功后断开——receipt 保留（副作用如实保留），analyze/model 不完成。
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
  let retryPort = 0;
  try {
    host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
    retryPort = host.port;
    // Observe actual socket closure; do not substitute request handling.
    (host as any).server.on('request', (_req: any, res: any) => res.once('close', serverClosed));
    await host.start();
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
      messages: host.db.prepare('SELECT speaker, COUNT(*) AS count FROM messages GROUP BY speaker ORDER BY speaker').all(),
      stream: host.db.prepare('SELECT state FROM voice_stream_turns WHERE call_id=? AND turn_key=?').get('audit-call', 'audit-turn'),
      turns: host.db.prepare('SELECT state FROM turns').all(),
    };
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
      result.retry = { replayed: done.replayed === true, prior_state: done.prior_state ?? null, modelRequestsAfterRetry: modelRequests };
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
});

test('disconnect after successful ingest: receipt retained, analyze/model never complete', { timeout: 10000 }, async () => {
  const result = await runPhone('disconnect-after-ingest');
  assert.equal(result.ingests, 1, 'ingest 已成功（receipt 保留）');
  assert.equal(result.analyses, 0, 'analyze 被取消不得完成');
  assert.equal(result.analysesDispatched, 1, '这次分析在断线前已经派发，不得把完成数冒充派发数');
  assert.equal(result.receipts.length, 1, '数据库确实保留导入回执');
  assert.equal(result.receipts[0].oido_audio_id, 'aud_audit');
  assert.equal(result.modelRequests, 0, 'model request started after actual HTTP disconnect');
  assert.equal(result.stream?.state, 'cancelled');
});

test('disconnect after ingest before analysis: late receipt persists and no later analysis dispatches', { timeout: 10000 }, async () => {
  const result = await runPhone('disconnect-before-analysis');
  assert.equal(result.ingests, 1);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].oido_audio_id, 'aud_audit');
  assert.equal(result.analysesDispatched, 0);
  assert.equal(result.modelRequests, 0);
  assert.deepEqual(result.turns, []);
  assert.deepEqual(result.messages, []);
  assert.equal(result.stream?.state, 'cancelled');
});
// 一次性只读审计复现：真实 Host/HTTP，只有外部 Siren/oído/DS transport 为 fake。
// 场景：用户正常电话输入携带原声，在原声取回过程中断开连接。
// 前置经真实 HTTP 入口建立；不直接写业务表、不替换 handler/registry/supervisor。
// P08 批次1（审计修复复现迁入正式目录，源=一次性审计复现 codex-voice-preparation-disconnect）：
// 真实 Host/HTTP/数据库，只有外部 Siren/oído/DS transport 为 fake。
// 场景①control：正常电话输入（音频→ingest→analyze→模型）各一次。
// 场景②disconnect-audio：取音频期间真实 socket 断开——修复后：父取消贯穿 fetch、ingest/analyze/model 不启动、
//   接纳记录 cancelled、同键重试返回原终态。
// 场景③disconnect-after-ingest：ingest 已成功后断开——receipt 保留（副作用如实保留），analyze/model 不完成。
