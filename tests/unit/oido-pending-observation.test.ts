// 联合审计 A02（2026-10-27）：迟到分析的正常在途（oído GET 409 NOT_READY_YET）不是失败。
// 真实 MessageService/OidoAdapter/OidoHearingService/VoiceObservationService；只替换 oído
// HTTP 边界，响应体为 oído 现行合同形状（error_body / analysis_ticket / evidence_overview）。
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
import { VoiceObservationService } from '../../apps/host/src/modules/oido/observations.ts';

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

type GetReply = 'not_ready' | 'ready' | 'failed';

async function run(getReplies: GetReply[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-oido-pending-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const config = buildConfig({ integrations: { oido: { base_url: 'http://127.0.0.1:8791', credential_ref: credentialRef } } });
  const media = new MediaService(db, path.join(root, 'media'), config);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  const counts = { analyze: 0, get: 0 };
  const origFetch = globalThis.fetch;
  (globalThis as { fetch?: typeof fetch }).fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/v1/audio:ingest')) return Response.json({ audio_id: 'aud_p1', deduplicated: false });
    if (u.endsWith('/transcript')) return Response.json({ stored: true });
    if (u.endsWith('/v1/analyses') && init?.method === 'POST') { counts.analyze++; return Response.json({ analysis_id: 'run_p1', state: 'running' }); }
    if (u.endsWith('/v1/analyses/run_p1')) {
      counts.get++;
      const reply = getReplies.shift();
      if (reply === 'not_ready') return Response.json({ code: 'NOT_READY_YET', message: 'analysis is running', retryable: true }, { status: 409 });
      if (reply === 'failed') return Response.json({ code: 'ANALYSIS_FAILED', message: 'pipeline_failed' }, { status: 422 });
      return Response.json({ analysis_id: 'run_p1', revision: 1, state: 'ready', range_ms: [0, 1200], observations: [] });
    }
    throw new Error('UNEXPECTED_EXTERNAL_TRANSPORT:' + u);
  }) as typeof fetch;
  try {
    const asset = await media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x07]), purpose: 'chat_voice', operationId: 'pending-upload', createdBy: 'qiaosheng', origin: 'upload' });
    const sub = messages.submitUserMessageWithTurn({ conversationId: 'primary', content: '', clientMessageId: 'm-pending-1', attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    const hearing = new OidoHearingService({ db, oido: new OidoAdapter(config.integrations.oido), sources: new OidoSourceRepository(db), audio: media, artifacts: media });
    const observations = new VoiceObservationService(db, { hearing, archiveClient: null, streamId: 'unused' });
    observations.ensureForMessage(sub.message.id, 1, 'primary', true);
    const row = () => db.prepare('SELECT status, analysis_id, error_code FROM voice_observations WHERE message_id=?').get(sub.message.id) as { status: string; analysis_id: string | null; error_code: string | null };
    const states: Array<{ status: string; analysis_id: string | null; error_code: string | null }> = [];
    for (let i = 0; i < 4; i++) {
      await observations.runPending(hearing);
      states.push(row());
    }
    return { states, counts };
  } finally {
    (globalThis as { fetch?: typeof fetch }).fetch = origFetch;
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('A02：GET 409 NOT_READY_YET 保持 pending，沿同一 analysis 续查到 ready；不重新 analyze', async () => {
  const { states, counts } = await run(['not_ready', 'not_ready', 'ready']);
  assert.deepEqual(states.map((s) => s.status), ['pending', 'pending', 'pending', 'ready'], JSON.stringify(states));
  assert.ok(states.every((s) => s.analysis_id === 'run_p1'), '全程同一 analysis_id');
  assert.equal(states[1]!.error_code, 'OIDO_NOT_READY', '在途如实记录，不是失败');
  assert.equal(counts.analyze, 1, '首跳之后只 GET，不再 POST analyze');
  assert.equal(counts.get, 3);
});

test('A02：真实终态失败（oído 422 ANALYSIS_FAILED）仍落 failed，不被当作在途无限轮询', async () => {
  const { states, counts } = await run(['failed']);
  assert.equal(states[1]!.status, 'failed');
  assert.equal(states[1]!.error_code, 'OIDO_GET_422:ANALYSIS_FAILED');
  assert.equal(counts.get, 1, 'failed 后不再查询');
  assert.equal(counts.analyze, 1);
});
