// P08 演练B（A10/A27）：依赖替换与可选能力隔离。
// 见 specs 05 §1 / 08：把首条真实 oído 用例依赖的 transport 替换为合同兼容的 fake 实现，
// 证明 voice-hearing 组合与宿主消息核心不改；再断开该可选能力，普通文字路径仍正常。
// 本测试同一套核心装配跑三种形态：真实 OidoAdapter（fake HTTP 边界）/ 合同兼容 FakeOidoAdapter /
// oído 未注入——只有装配声明不同，模块与核心代码相同。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { OidoAdapter } from '../../apps/host/src/integrations/oido/adapter.ts';
import { wireOidoCapabilitiesForTest } from '../helpers.ts';

type Mode = 'real' | 'fake' | 'absent';

function makeStack(mode: Mode) {
  const root = fs.mkdtempSync(path.join(os_tmp(), 'drill-b-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  process.env.ESTOMAGO_TEST_OIDO_CREDENTIAL = process.env.ESTOMAGO_TEST_OIDO_CREDENTIAL ?? 'drill-b-token';
  const config = buildConfig({ integrations: { oido: { base_url: mode === 'real' ? 'http://127.0.0.1:8791' : null, credential_ref: 'ESTOMAGO_TEST_OIDO_CREDENTIAL' } } } as never);
  const media = new MediaService(db, path.join(root, 'media'), config);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  messages.ensureConversation('other');
  // 合同兼容 fake：与 OidoAdapter 同方法面（ingestVoice/analyze/getOverview/getProsodyPage/getView/find/compare/capabilities/deleteAudio）
  const fakeAdapter = {
    configured: true,
    capabilities: async () => ({ ok: true, providers: [{ name: 'fake' }], status: 'ok' }),
    ingestVoice: async (x: { assetId: string }) => ({ audioId: `fake_${x.assetId}`, deduplicated: false }),
    analyze: async () => ({ analysis_id: 'an_fake', revision: 1, state: 'ready', range_ms: [0, 1000], observations: [] }),
    getOverview: async (id: string) => ({ analysis_id: id, revision: 1, state: 'ready', range_ms: [0, 1000], observations: [] }),
    getProsodyPage: async (id: string) => ({ analysis_id: id, revision: 1, syllables: [] }),
    getView: async (id: string) => ({ mime: 'image/png', pngBase64: Buffer.from('89504e47').toString('base64'), metadata: { analysis_id: id } }),
    find: async () => ({ state: 'candidates', items: [] }),
    compare: async () => ({ metrics: [], limits: [], baseline_comparison: { state: 'unavailable' } }),
    deleteAudio: async () => ({ deleted: true }),
  };
  const realAdapter = new OidoAdapter(config.integrations.oido);
  const adapter = mode === 'fake' ? (fakeAdapter as unknown as OidoAdapter) : mode === 'real' ? realAdapter : null;

  // 原 real 模式的 fetch 边界 fake（ingest/analyze）——与 P02.7/voice-hearing 同模式
  const origFetch = globalThis.fetch;
  if (mode === 'real') {
    (globalThis as { fetch?: typeof fetch }).fetch = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/v1/audio:ingest')) return Response.json({ audio_id: 'aud_real', deduplicated: false });
      if (u.endsWith('/v1/analyses') ) return Response.json({ analysis_id: 'an_real', revision: 1, state: 'ready', range_ms: [0, 1000], observations: [] });
      if (u.includes('/v1/analyses/an_real')) return Response.json({ analysis_id: 'an_real', revision: 1, state: 'ready', range_ms: [0, 1000], observations: [] });
      return Response.json({}, { status: 404 });
    }) as typeof fetch;
  }

  const reviews = new RotationReviewService(db);
  const checkpoint = new HoldCheckpointService(db);
  const tools = new HostToolExecutor({ db, mariposa: null, reviews, checkpoint, media, messages });
  wireOidoCapabilitiesForTest(tools, { oido: adapter, media });

  const ctx = () => ({ roomId: 'c1', windowId: 'w1', turnId: null, purpose: 'chat' as const, activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'drill-b' });
  const createVoice = async () => {
    const asset = await media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x31]), purpose: 'chat_voice', operationId: `drill-b-${mode}`, createdBy: 'qiaosheng', origin: 'upload' });
    messages.publishAssistantMessage({ conversationId: 'c1', turnId: 't', content: '', kind: 'voice', clientMessageId: `m-${mode}`, attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    return asset;
  };
  return { root, db, tools, ctx, createVoice, restore() { (globalThis as { fetch?: typeof fetch }).fetch = origFetch; db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

import os from 'node:os';
const os_tmp = () => os.tmpdir();

test('演练B①：合同兼容 fake 替换 transport——voice-hearing 组合同一语义（A27）', async () => {
  for (const mode of ['real', 'fake'] as Mode[]) {
    const f = makeStack(mode);
    try {
      const asset = await f.createVoice();
      const analyze = await f.tools.execute('oido_analyze', { audio_ref: `est:${asset.id}` }, f.ctx());
      assert.equal(analyze.ok, true, `${mode}: analyze 经组合链成功`);
      const analysisId = (analyze.output as { analysis_id: string }).analysis_id;
      const get = await f.tools.execute('oido_get', { analysis_id: analysisId }, f.ctx());
      assert.equal(get.ok, true, `${mode}: get 同门成功`);
      // 跨会话拒读同门（组合语义不因替换改变）
      const cross = await f.tools.execute('oido_get', { analysis_id: analysisId }, { ...f.ctx(), roomId: 'other' });
      assert.equal(cross.ok, false, `${mode}: 跨会话拒读保持`);
      console.log(JSON.stringify({ case: 'drillB_substitute', mode, analysisId }));
    } finally { f.restore(); }
  }
});

test('演练B②：断开可选能力——oído 工具如实拒绝，普通文字路径正常（A10）', async () => {
  const f = makeStack('absent');
  try {
    const asset = await f.createVoice();
    // oído 未注入：analyze/get 如实 INTEGRATION_UNCONFIGURED
    const analyze = await f.tools.execute('oido_analyze', { audio_ref: `est:${asset.id}` }, f.ctx());
    assert.equal(analyze.ok, false);
    assert.equal((analyze.output as { error_code: string }).error_code, 'INTEGRATION_UNCONFIGURED');
    // 普通文字路径正常：conversation_read 经同一 registry 返回本会话内容
    const read = await f.tools.execute('conversation_read', { around_seq: 1 }, f.ctx());
    assert.equal(read.ok, true, 'oído 断开后 conversation_read 正常');
    const entries = (read.output as { entries: unknown[] }).entries;
    assert.ok(Array.isArray(entries) && entries.length >= 1, '会话内容可读（含已发布语音消息条目）');
    console.log(JSON.stringify({ case: 'drillB_absent', entries: entries.length }));
  } finally { f.restore(); }
});
