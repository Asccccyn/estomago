// F04（四仓联合审计 20261104，P2）：E 分析操作键不得永久绑定音频资产——
// 迟到转写改变 O 输入 digest 后：①同键 409（O 冲突合同保留）②E 失效旧键，
// 提示"重新发起"后的重试**真正可恢复**（新键新分析）；③同输入同操作仍复用（去重保留）。
// 真实 OidoHearingService/OidoSourceRepository/MediaService/MessageService/SQLite；
// 仅 O HTTP 边界为 fetch 替身（含审计复现的 409 IDEMPOTENCY_CONFLICT 行为）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { OidoAdapter } from '../../apps/host/src/integrations/oido/adapter.ts';
import { OidoHearingService } from '../../apps/host/src/modules/oido/service.ts';
import { OidoSourceRepository } from '../../apps/host/src/modules/oido/source-repository.ts';

const credentialRef = 'ESTOMAGO_TEST_OIDO_CREDENTIAL';
let previousCredential: string | undefined;
before(() => {
  assert.equal(process.env.ESTOMAGO_TEST_MODE, '1', 'only isolated test mode');
  previousCredential = process.env[credentialRef];
  process.env[credentialRef] = 'unit-only-oido-token';
});
after(() => {
  if (previousCredential === undefined) delete process.env[credentialRef];
  else process.env[credentialRef] = previousCredential;
});

const EBML = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x07]);

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-f04-key-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const config = buildConfig({ integrations: { oido: { base_url: 'http://127.0.0.1:8791', credential_ref: credentialRef } } });
  const media = new MediaService(db, path.join(root, 'media'), config);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  // O 替身：记录每次 POST analyze 的 idempotency_key 与请求体里的转写；
  // 键已见过且输入变化 → 409 IDEMPOTENCY_CONFLICT（真实 O 合同）
  // O 输入 digest 正本=转写内容（ingest 阶段提交，analyses 按键比对 digest——真实合同）
  const seenKeys = new Map<string, string>(); // idempotency_key → digest at creation
  const seenAnalysis = new Map<string, unknown>(); // idempotency_key → 既有 analysis（同键同 digest 复用）
  let lastTranscriptDigest = '-'; // 本替身单音频：最近一次 ingest 提交的转写摘要
  const analyzeCalls: Array<{ key: string | null; hasTranscript: boolean }> = [];
  const origFetch = globalThis.fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/v1/audio:ingest')) return Response.json({ audio_id: 'aud_f4', deduplicated: false });
    if (/\/v1\/audio\/[^/]+\/transcript$/.test(u)) {
      const body = JSON.parse(String(init.body)) as { text?: string };
      lastTranscriptDigest = body.text ? sha256Hex(body.text) : '-';
      return Response.json({ stored: true });
    }
    if (u.endsWith('/v1/analyses') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { idempotency_key?: string };
      const digest = lastTranscriptDigest; // analyze 时刻该音频的输入版本（ingest 已提交）
      analyzeCalls.push({ key: body.idempotency_key ?? null, hasTranscript: digest !== '-' });
      const key = body.idempotency_key ?? '(none)';
      if (seenKeys.has(key) && seenKeys.get(key) !== digest) {
        return Response.json({ code: 'IDEMPOTENCY_CONFLICT', message: 'same key different input digest' }, { status: 409 });
      }
      if (seenAnalysis.has(key)) return Response.json(seenAnalysis.get(key)); // 真实合同：同键同 digest=既有分析
      const created = { analysis_id: `an_${analyzeCalls.length}`, state: 'ready', revision: 1, range_ms: [0, 1200], observations: [] };
      seenKeys.set(key, digest);
      seenAnalysis.set(key, created);
      return Response.json(created);
    }
    throw new Error('UNEXPECTED_EXTERNAL_TRANSPORT:' + u);
  }) as typeof fetch;
  const hearing = new OidoHearingService({ db, oido: new OidoAdapter(config.integrations.oido), sources: new OidoSourceRepository(db), audio: media, artifacts: media });
  const asset = await media.saveBuffer({ bytes: EBML, purpose: 'chat_voice', operationId: 'f04-upload', createdBy: 'qiaosheng', origin: 'upload' });
  messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '', clientMessageId: 'f04-msg', attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
  const ctx = { roomId: 'primary', windowId: 'w', turnId: 't-f04', purpose: 'chat' as const, activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'prq-f04', toolCallId: 'call-f04', signal: undefined };
  return {
    hearing, db, asset, ctx,
    calls: analyzeCalls,
    done() { (globalThis as { fetch?: typeof fetch }).fetch = origFetch; db.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('F04：无转写首发→迟到转写→旧键409失效→重试新键成功；同输入重试复用', async () => {
  const s = await setup();
  try {
    // ① 无转写首发（quick 键记录 digest='-'）
    const r1 = await s.hearing.analyzeVoice({ audio_ref: `est:${s.asset.id}` }, s.ctx as never);
    assert.equal(r1.ok, true, '首发成功');
    assert.equal(s.calls.length, 1);
    const firstKey = s.calls[0]!.key;
    assert.ok(firstKey, '有幂等键');

    // ② 迟到转写到达（voice_transcripts ready），同一资产再分析——digest 变化
    //    旧实现：仍取旧键 → 409 → 提示重试 → 重试仍旧键 → 永远失败（审计链）
    s.db.prepare("INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,derived_source,duration_ms,created_at,updated_at) VALUES (?,?,'op-f4',?,'ready','今天天气不错','siren:transcribe',NULL,?,?)")
      .run(s.asset.id, 'primary', s.asset.content_sha256, new Date().toISOString(), new Date().toISOString());
    const r2 = await s.hearing.analyzeVoice({ audio_ref: `est:${s.asset.id}` }, s.ctx as never);
    assert.equal(r2.ok, false, '审计场景：旧键 409（若直达此断言失败=旧键仍被复用的方向性变化）');
    assert.equal((r2 as { error?: { error_code?: string } }).error?.error_code, 'OIDO_CONTRACT_CHANGED');
    // 关键修复点：旧键已失效
    const receipt = s.db.prepare('SELECT analysis_key, analysis_input_digest FROM oido_ingest_receipts WHERE est_asset_id=?').get(s.asset.id) as { analysis_key: string | null; analysis_input_digest: string | null };
    assert.equal(receipt.analysis_key, null, 'F04：409 后旧键失效——重试不再永久卡死');

    // ③ 按提示重新发起：新键成功（审计验收"409 后明确新请求可恢复"）
    const r3 = await s.hearing.analyzeVoice({ audio_ref: `est:${s.asset.id}` }, { ...s.ctx, toolCallId: 'call-f4-retry' } as never);
    assert.equal(r3.ok, true, '重试可恢复（新键新分析）');
    assert.notEqual(s.calls[2]!.key, firstKey, '新键≠旧键');
    assert.equal(s.calls[2]!.hasTranscript, true, '新分析带转写（新输入版本）');

    // ④ 同输入重试（键已记 digest=带转写）：同 toolCallId 重放复用同键（去重保留）
    const before = s.calls.length;
    const r4 = await s.hearing.analyzeVoice({ audio_ref: `est:${s.asset.id}` }, { ...s.ctx, toolCallId: 'call-f4-retry' } as never);
    assert.equal(r4.ok, true);
    assert.equal(s.calls.at(-1)?.key, s.calls[2]!.key, '同输入同操作复用同键');
    const id3 = (r3 as { value: { view: { analysis_id: string } } }).value.view.analysis_id;
    const id4 = (r4 as { value: { view: { analysis_id: string } } }).value.view.analysis_id;
    assert.equal(id4, id3, '同键同 digest=O 返回既有分析（不新建）');
  } finally { s.done(); }
});
