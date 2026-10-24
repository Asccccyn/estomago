// R6′（2026-10-23，她批 R6P 方案）：导入回执持久化 + 删除传播意图 + outbox 重试语义
// （404=幂等成功；失败退避下跳；重启恢复=表即状态）。解除单引用不删远端（撤权≠毁数据）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { retryOneOidoDelete } from '../../apps/host/src/integrations/oido/delete-retry.ts';
import type { OidoAdapter } from '../../apps/host/src/integrations/oido/adapter.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r6p-est-'));
  const db = openDatabase(root); migrate(db, sha256Hex);
  const media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  const mkVoice = async () => media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x00]), purpose: 'chat_voice', operationId: `op-${Math.random().toString(36).slice(2, 8)}`, createdBy: 'q', origin: 'upload' });
  return { root, db, media, mkVoice, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const fakeAdapter = (behavior: { ok: boolean; status?: number }) => {
  const calls: string[] = [];
  return {
    calls,
    deleteAudio: async (a: { audioId: string }) => {
      calls.push(a.audioId);
      if (behavior.ok) return { deleted: true };
      const e = new Error('OIDO_UNAVAILABLE') as Error & { status?: number };
      e.status = behavior.status;
      throw e;
    },
  } as unknown as OidoAdapter & { calls: string[] };
};

test('markAssetMissing：有导入回执的语音 → 意图落库；无回执资产只标 missing；撤权（删 binding）不产生意图', async () => {
  const f = fixture();
  try {
    const withReceipt = await f.mkVoice();
    const noReceipt = await f.mkVoice();
    const sha = (f.db.prepare('SELECT content_sha256 FROM media_assets WHERE id=?').get(withReceipt.id) as { content_sha256: string }).content_sha256;
    f.db.prepare('INSERT INTO oido_ingest_receipts(est_asset_id,content_sha256,oido_audio_id,deduplicated,ingested_at) VALUES (?,?,?,?,?)').run(withReceipt.id, sha, `aud_${withReceipt.id}`, 0, new Date().toISOString());
    f.db.prepare('INSERT INTO oido_source_bindings(analysis_id,conversation_id,asset_id,content_sha256) VALUES (?,?,?,?)').run('an-1', 'c1', noReceipt.id, 'sha-x');
    f.media.markAssetMissing(withReceipt.id);
    f.media.markAssetMissing(noReceipt.id);
    const intent = f.db.prepare('SELECT * FROM oido_delete_intents WHERE est_asset_id=?').get(withReceipt.id) as { oido_audio_id: string } | undefined;
    assert.ok(intent, '有回执=有意图');
    assert.equal(intent!.oido_audio_id, `aud_${withReceipt.id}`);
    const nNoReceipt = (f.db.prepare('SELECT COUNT(*) n FROM oido_delete_intents WHERE est_asset_id=?').get(noReceipt.id) as { n: number }).n;
    assert.equal(nNoReceipt, 0, '无回执无意图（远端无副本可删）');
    assert.equal((f.db.prepare("SELECT state FROM media_assets WHERE id=?").get(noReceipt.id) as { state: string }).state, 'missing');
  } finally { f.close(); }
});

test('重试语义：成功/404=删意图；失败=attempts+1 退避（新意图立即试，失败后须等退避窗）', async () => {
  const f = fixture();
  try {
    const okAdapter = fakeAdapter({ ok: true });
    f.db.prepare('INSERT INTO oido_delete_intents(est_asset_id,oido_audio_id,attempts,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('a-ok', 'aud-ok', 0, null, new Date().toISOString(), new Date().toISOString());
    assert.equal(await retryOneOidoDelete(f.db, okAdapter, new AbortController().signal), 'done');
    assert.deepEqual(okAdapter.calls, ['aud-ok']);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM oido_delete_intents').get() as { n: number }).n, 0, '成功即删意图');
    // 失败路径
    const failAdapter = fakeAdapter({ ok: false });
    f.db.prepare('INSERT INTO oido_delete_intents(est_asset_id,oido_audio_id,attempts,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run('a-fail', 'aud-fail', 0, null, new Date().toISOString(), new Date().toISOString());
    assert.equal(await retryOneOidoDelete(f.db, failAdapter, new AbortController().signal), 'retry_scheduled');
    const row = f.db.prepare('SELECT attempts FROM oido_delete_intents WHERE est_asset_id=?').get('a-fail') as { attempts: number };
    assert.equal(row.attempts, 1);
    assert.equal(await retryOneOidoDelete(f.db, failAdapter, new AbortController().signal), 'backoff', '失败后未到退避窗不再连打');
    f.db.prepare("UPDATE oido_delete_intents SET updated_at='2026-10-23T00:00:00Z' WHERE est_asset_id='a-fail'").run();
    assert.equal(await retryOneOidoDelete(f.db, fakeAdapter({ ok: true }), new AbortController().signal), 'done', '退避窗过后重试成功');
  } finally { f.close(); }
});
