// R04（复审 2026-10-07）：死信恢复以冻结 batch 为原子一致性单位。
// 真实链路演练（复审验收原文）：真实 drain 失败（403 领域冲突）→ 行 failed
// + 批 dead → outbox-requeue --apply 原子复活（批 dead→in_flight + 成员行
// failed→pending 同事务）→ 条件恢复后再 drain：同 op 重发、真实 ACK、批/行
// acked、收据落表、后续消息继续前进。
// 反例（旧码）：脚本"已重排 1 行"后批仍 dead → 再 drain 0 个远端请求、
// 行被 BATCH_DEAD 原地打回 failed。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { Logger } from '../../apps/host/src/observability/logging.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { ArchiveSyncService } from '../../apps/host/src/integrations/mariposa/archive-sync.ts';
import { MariposaClient, type IngestRequest, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { tempRoot } from '../helpers.ts';

const REPO = path.resolve(fileURLToPath(import.meta.url), '../../..');
type Row = Record<string, unknown>;

test('R04：真实失败→dead 批→requeue 原子复活→原 op 有效 ACK→后续消息前进', async () => {
  const root = tempRoot('r04-');
  const config = buildConfig({
    archive: { enabled: true, source_scope: 'estomago-primary-live' },
    integrations: { mariposa: { base_url: 'http://mariposa.test', credential_ref: 'T' } },
  });
  buildPaths(root);
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const logger = new Logger(path.join(root, 'logs'));
  const events = new EventService(db);
  const messages = new MessageService(db);
  messages.ensureConversation('c1');

  const seenOps: string[] = [];
  let mode: 'forbid' | 'ok' = 'forbid';
  const committed = new Map<string, Record<string, unknown>>();
  const transport: MariposaTransport = async (capability, payload) => {
    if (capability !== 'source.ingest') return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
    const req = payload as unknown as IngestRequest;
    seenOps.push(req.operation_id);
    if (mode === 'forbid') return { ok: false, code: 'FORBIDDEN', httpStatus: 403 };
    const prev = committed.get(req.operation_id);
    if (prev) return { ok: true, result: prev };
    const ack = {
      operation_id: req.operation_id, committed_at: new Date().toISOString(),
      messages: req.messages.map((m) => ({ origin_message_id: m.origin_message_id, revision: m.revision, source_conversation_id: 'mc', source_message_id: `msrc-${m.origin_message_id}-r${m.revision}`, content_hash: m.content_hash })),
    };
    committed.set(req.operation_id, ack as Row);
    return { ok: true, result: ack };
  };
  const client = new MariposaClient({ transport });
  const sync = new ArchiveSyncService({ db, events, logger, client, config });

  // ① 真实失败制造 dead（不是手工插行）
  messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '会失败的第一句', clientMessageId: 'k1' });
  const s1 = await sync.drainOnce();
  assert.ok((s1.dead ?? 0) >= 1, `真实失败应判 dead：${JSON.stringify(s1)}`);
  const batch = db.prepare('SELECT operation_id, state, attempts FROM ingest_batches').get() as { operation_id: string; state: string; attempts: number };
  assert.equal(batch.state, 'dead', '真实失败留下 dead 批');
  const st = () => (db.prepare("SELECT state FROM outbox WHERE target='mariposa.archive'").all() as Array<{ state: string }>);
  assert.ok(st().every((r) => r.state === 'failed'), '成员行 failed');

  // ② 恢复脚本：批原子复活（子进程跑真实脚本，同库 WAL）
  const out = execFileSync('node', [path.join(REPO, 'scripts/outbox-requeue.mjs'), '--apply', '--conversation', 'c1'], {
    env: { ...process.env, ESTOMAGO_HOME: root }, encoding: 'utf8',
  });
  assert.ok(out.includes('已原子复活批 1 个'), `复活输出：${out.slice(-500)}`);
  assert.equal((db.prepare('SELECT state FROM ingest_batches WHERE operation_id = ?').get(batch.operation_id) as { state: string }).state, 'in_flight', '批复活为可消费态');
  assert.ok(st().every((r) => r.state === 'pending'), '成员行 pending（attempt 计数保留）');
  assert.equal((db.prepare('SELECT attempt FROM outbox LIMIT 1').get() as { attempt: number }).attempt, 1, '不重置计数');

  // ③ 条件恢复（上游 403 解除）→ 再 drain：原 op 重发并拿到有效 ACK
  const callsBefore = seenOps.length;
  mode = 'ok';
  const s2 = await sync.drainOnce();
  assert.ok(seenOps.length > callsBefore, '恢复后必须发起远端请求（反例：旧码 0 请求原地 BATCH_DEAD）');
  assert.equal(seenOps[callsBefore], batch.operation_id, '同 op 重发（幂等身份不变，不换 key 绕幂等）');
  assert.equal((db.prepare('SELECT state FROM ingest_batches WHERE operation_id = ?').get(batch.operation_id) as { state: string }).state, 'acked', '批 acked');
  assert.ok(st().every((r) => r.state === 'acked'), '成员行 acked');
  assert.ok((db.prepare('SELECT COUNT(*) n FROM source_sync_receipts').get() as { n: number }).n >= 1, '收据落表');

  // ④ 后续消息继续前进（dead 不再级联卡流）
  messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '恢复后的新消息', clientMessageId: 'k2' });
  const s3 = await sync.drainOnce();
  assert.ok((s3.acked ?? 0) >= 1, `后续消息应前进：${JSON.stringify(s3)}`);
  assert.ok((db.prepare('SELECT state FROM outbox').all() as Array<{ state: string }>).every((r) => r.state === 'acked'));
  db.close();
});
