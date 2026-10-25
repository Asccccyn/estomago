#!/usr/bin/env node
// 真实集成冒烟（2026-10-25 用户授权：除 OR key 外的付费测试均可做）。
// 全部调用走本仓（重构后）est 代码路径：
//  - Mariposa：integrations/mariposa/client.ts（bootstrap.get + mood vocab——只读）
//  - oído：integrations/oido/adapter.ts（capabilities 只读 + 合成 8 字节 webm ingest→analyze——与一条真实语音消息同构，服务端为自管 loopback）
//  - embedding worker：media/index/service.ts MediaEmbedWorkerClient（1 图 1 文——无状态计算）
//  - Siren：只探测可读端点——绝不建呼（会打真实电话）
// 安全纪律：
//  - 需 ESTOMAGO_REAL_SMOKE=1；绝不读取/打印任何 key 值（credential 全经 env 名间接引用）
//  - 本脚本不构造任何 OpenRouter 客户端；若 OR key 在环境中仅提示"present,unused"，绝不使用
//  - 不触碰生产 ESTOMAGO_HOME（只读服务端点；不写任何 est 本地库——本脚本无本地 DB 写入）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.ESTOMAGO_REAL_SMOKE !== '1') { console.error('拒绝：需 ESTOMAGO_REAL_SMOKE=1'); process.exit(2); }
process.env.ESTOMAGO_TEST_MODE = '1';
if (process.env.OPENROUTER_API_KEY) console.log('[gate] OR key present in env — 本脚本不使用（用户铁律）');

const evidence = { started_at: new Date().toISOString(), mode: 'real-loopback-services', steps: [], siren: null };
const base = (p) => path.join(import.meta.dirname, '..', p);
const record = (name, data) => { evidence.steps.push({ name, ...data }); console.log(`[${name}]`, JSON.stringify(data.summary ?? data)); };
const REDACT = (o) => JSON.parse(JSON.stringify(o, (k, v) => /token|credential|key|authorization/i.test(k) ? '<redacted>' : v));

// ① Mariposa（只读）
{
  const { MariposaClient } = await import(base('apps/host/src/integrations/mariposa/client.ts'));
  const client = new MariposaClient({ baseUrl: 'http://127.0.0.1:18780', credentialEnv: 'MARIPOSA_CREDENTIAL' });
  const t0 = Date.now();
  const boot = await client.bootstrapGet();
  const vocab = await client.moodVocab();
  record('mariposa', {
    summary: {
      configured: client.isConfigured(),
      bootstrap_ok: boot.ok,
      profile: boot.ok ? (boot.result?.profile ?? null) : null,
      snapshot_id_shape: boot.ok ? String(boot.result?.snapshot_id ?? '').startsWith('snap') : null,
      vocab_ok: vocab.ok,
      vocab_categories: Array.isArray(vocab.categories) ? vocab.categories.length : null,
      latency_ms: Date.now() - t0,
    },
  });
  if (!boot.ok || !vocab.ok) process.exitCode = 1;
}

// ② oído：capabilities（只读）+ 合成音频 ingest→analyze（ASR/听析真实后端）
{
  const { OidoAdapter } = await import(base('apps/host/src/integrations/oido/adapter.ts'));
  const adapter = new OidoAdapter({ base_url: 'http://127.0.0.1:8791', credential_ref: 'ESTOMAGO_OIDO_TOKEN' });
  const caps = await adapter.capabilities();
  // 真实合成语音（macOS say+afconvert；可经 ESTOMAGO_REAL_SMOKE_AUDIO 覆盖）——真 ASR 需真音频
  let bytes;
  if (process.env.ESTOMAGO_REAL_SMOKE_AUDIO && fs.existsSync(process.env.ESTOMAGO_REAL_SMOKE_AUDIO)) {
    bytes = fs.readFileSync(process.env.ESTOMAGO_REAL_SMOKE_AUDIO);
  } else {
    const { execFileSync } = await import('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'real-smoke-audio-'));
    const aiffP = path.join(tmp, 's.aiff'), wavP = path.join(tmp, 's.wav');
    execFileSync('/usr/bin/say', ['-o', aiffP, '这是一段真实合成语音冒烟测试']);
    execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16', aiffP, wavP]);
    bytes = fs.readFileSync(wavP);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const t0 = Date.now();
  let ingest = null, analysis = null, analyzeErr = null;
  try {
    const assetId = `real-smoke-${Date.now()}`;
    ingest = await adapter.ingestVoice({ assetId, bytes, sha256, mime: 'audio/wav', transcript: null });
    const res = await adapter.analyze({ assetId, waitMs: 30_000 });
    analysis = 'analysis_id' in res ? res : null;
  } catch (err) { analyzeErr = String(err.message ?? err).slice(0, 160); }
  const oidoOk = caps?.ok === true && Boolean(ingest?.audioId) && analysis != null && analyzeErr === null;
  record('oido', {
    summary: {
      capabilities_ok: caps?.ok === true,
      ingest_ok: Boolean(ingest?.audioId),
      ingest_deduplicated: ingest?.deduplicated ?? null,
      analyze_state: analysis?.state ?? null,
      analyze_observations: Array.isArray(analysis?.observations) ? analysis.observations.length : null,
      analyze_error: analyzeErr,
      latency_ms: Date.now() - t0,
    },
  });
  // 审计 B3 修复（2026-10-25）：ingest/analyze 任一失败即 FAIL——不再只按 capabilities 判成功
  if (!oidoOk) process.exitCode = 1;
}

// ③ embedding worker（无状态计算：1 图 + 1 文）
{
  const { MediaEmbedWorkerClient } = await import(base('apps/host/src/media/index/service.ts'));
  const worker = new MediaEmbedWorkerClient({ base_url: 'http://127.0.0.1:8792', credential_ref: 'ESTOMAGO_MEDIA_WORKER_TOKEN' });
  const png = fs.readFileSync(base('apps/web/src/home/home-v2-original/assets/illustrations/album-chat.png')); // 真实 PNG——假头会被真实后端断连
  const t0 = Date.now();
  const out = await worker.embed([
    { id: 'img', modality: 'image', bytes: png },
    { id: 'q', modality: 'text', bytes: Buffer.from('测试查询', 'utf8') },
  ]);
  const dims = out.vectors.get('img')?.length ?? null;
  record('embedding', {
    summary: {
      fingerprint_shape: String(out.fingerprint).split('|')[0],
      image_dims: dims,
      text_dims: out.vectors.get('q')?.length ?? null,
      latency_ms: Date.now() - t0,
    },
  });
  if (!dims) process.exitCode = 1;
}

// ④ Siren：只读探测（绝不建呼）。当前探测到的可达性如实记录。
{
  let reachable = false, detail = 'connection refused';
  try {
    const res = await fetch('http://127.0.0.1:8790/health', { signal: AbortSignal.timeout(2000) });
    reachable = res.ok; detail = `HTTP ${res.status}`;
  } catch (err) { detail = String(err.cause?.code ?? err.message ?? err).slice(0, 80); }
  evidence.siren = { reachable, detail, note: '只读探测；不建呼（防真实电话）。服务未运行=能力当前不可用，非合同验证失败' };
  console.log('[siren]', JSON.stringify(evidence.siren));
}

fs.mkdirSync(path.join(import.meta.dirname, '..', 'reports'), { recursive: true });
const out = path.join(import.meta.dirname, '..', 'reports', `real-integration-smoke-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
console.log(`证据 → ${out}`);
console.log(process.exitCode ? 'REAL_SMOKE_FAIL' : 'REAL_SMOKE_PASS');
process.exit(process.exitCode ?? 0);
