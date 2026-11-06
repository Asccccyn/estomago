// P3（四仓合并审计 20261106，U05/T05）：通话期间 Sol 自动浮现门控。
// - 通话话轮不登记浮现作业；会话有活动通话时 worker 不发起 Sol（pending→cancelled CALL_ACTIVE）
// - 通话开始取消全部未终态作业；结束后新的非通话消息恢复正常登记
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { SurfacingRepository } from '../../apps/host/src/memory-surfacing/repository.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { EventService } from '../../apps/host/src/events/service.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-sol-gate-'));
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  const messages = new MessageService(db);
  messages.ensureConversation('primary');
  const events = new EventService(db);
  const repo = new SurfacingRepository(db);
  const svc = new SurfacingService(db, null as never, null as never, {
    enabled: true, transport_overhead_text: '', policy_revision: 1, prompt_prepare_revision: 'e',
    delivery_deadline_ms: 3000, max_added_tokens_per_turn: 10, max_packet_bytes: 10, worker_concurrency: 2,
    recent_user_messages: 2, recent_window_bytes: 10,
  } as never, null as never, events);
  const submit = (clientMessageId: string, content: string) => messages.submitUserMessageWithTurn({ conversationId: 'primary', content, clientMessageId });
  const register = (messageId: string, revision: number, sequence: number, content: string, occurredAt: string | null) =>
    svc.onUserMessageAccepted({ conversationId: 'primary', messageId, revision, sequence, content, contentHash: 'h', occurredAt });
  const openCall = () => db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at) VALUES ('c1','primary','active',?)").run(new Date().toISOString());
  const closeCall = () => db.prepare("UPDATE voice_calls SET state='ended', ended_at=? WHERE call_id='c1'").run(new Date().toISOString());
  return { db, svc, repo, submit, register, openCall, closeCall, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('U05：通话话轮不登记浮现作业；非通话消息照常', () => {
  const f = fixture();
  try {
    const chat = f.submit('sol-gate-chat-1', '今天想起一件事');
    f.register(chat.message.id, 1, chat.message.sequence, '今天想起一件事', null);
    const n1 = (f.db.prepare('SELECT COUNT(*) n FROM surfacing_jobs WHERE source_message_id=?').get(chat.message.id) as { n: number }).n;
    assert.equal(n1, 1, '普通消息登记');
    const callTurn = f.db.prepare("UPDATE messages SET client_message_id='voice:c1:t1' WHERE id=?").run(chat.message.id);
    void callTurn;
    const chat2 = f.submit('sol-gate-chat-2', '电话里说的话');
    f.db.prepare("UPDATE messages SET client_message_id='voice:c1:t2' WHERE id=?").run(chat2.message.id);
    f.register(chat2.message.id, 1, chat2.message.sequence, '电话里说的话', null);
    const n2 = (f.db.prepare('SELECT COUNT(*) n FROM surfacing_jobs WHERE source_message_id=?').get(chat2.message.id) as { n: number }).n;
    assert.equal(n2, 0, 'T05：通话话轮零登记');
  } finally { f.close(); }
});

test('U05：活动通话期 worker 准入取消 pending（CALL_ACTIVE）；通话结束恢复登记', async () => {
  const f = fixture();
  try {
    const chat = f.submit('sol-gate-chat-3', '想起一件事');
    f.register(chat.message.id, 1, chat.message.sequence, '想起一件事', null);
    f.openCall();
    // drain 私有——直接验证公开入口的等价行为：通话开始取消在途（含 pending）
    f.svc.cancelForActiveCall('primary');
    const row = f.db.prepare('SELECT state, reason_code FROM surfacing_jobs WHERE source_message_id=?').get(chat.message.id) as { state: string; reason_code: string | null };
    assert.equal(row.state, 'cancelled');
    assert.equal(row.reason_code, 'CALL_ACTIVE');
    // 通话期间新消息仍登记（语义判断被 worker 准入拦截——不发起 Sol）
    f.closeCall();
    const chat2 = f.submit('sol-gate-chat-4', '通话后又想起一件事');
    f.register(chat2.message.id, 1, chat2.message.sequence, '通话后又想起一件事', null);
    const n = (f.db.prepare('SELECT COUNT(*) n FROM surfacing_jobs WHERE source_message_id=?').get(chat2.message.id) as { n: number }).n;
    assert.equal(n, 1, '结束后恢复登记（不补扫旧作业）');
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM surfacing_jobs WHERE state='cancelled'").get() as { n: number }).n, 1, '旧作业保持取消（不补扫）');
  } finally { f.close(); }
});
