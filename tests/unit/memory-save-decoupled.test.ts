import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assembleTestTools, makeDb } from '../helpers.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { freezeWindowTools } from '../../apps/host/src/runtime/tool-discovery.ts';

function fixture(t: any) {
  const { db, root } = makeDb();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const messages = new MessageService(db); messages.ensureConversation('c1');
  const sub = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '合成消息，未归档', clientMessageId: 'm1' });
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w1','c1','ACTIVE','now','now')").run();
  const calls: Array<{ cap: string; payload: Record<string, unknown> }> = [];
  let syncs = 0;
  const client = new MariposaClient({ transport: async (cap, payload) => {
    calls.push({ cap, payload });
    assert.equal(cap, 'memory.hold', '保存不触发读取、同步或绑定远端调用');
    const plan = Array.isArray(payload.categories) && payload.categories.includes('plan');
    return { ok: true, result: { operation_id: payload.operation_id, memory_id: 'saved-1', version: 1, binding_ids: [], committed_at: '2026-11-05T04:00:00Z', ...(plan ? { plan_ids: ['plan_server_id'] } : {}) } };
  } });
  const { tools } = assembleTestTools({ db, mariposa: client, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), archiveSync: { drainOnce: async () => { syncs++; } } });
  const ctx = { roomId: 'c1', windowId: 'w1', turnId: sub.turnId, requestId: 'save-request', toolCallId: 'save-call', purpose: 'chat' as const, activeReviewId: null, seenSequence: 1, seenMessages: [] };
  const args = { original_title: '合成记忆', categories: ['daily'], text: '独立记忆正文', creation_mode: 'contemporaneous' };
  return { db, tools, calls, ctx, args, syncs: () => syncs };
}

test('零已读、无来源收据直接保存；以后绑定失败不撤销或重写记忆', async t => {
  const f = fixture(t);
  const saved = await f.tools.execute('memory_hold', f.args, f.ctx);
  assert.deepEqual(saved, { ok: true, output: { saved: true, memory_id: 'saved-1', version: 1, source_status: 'unbound' } });
  assert.equal(f.syncs(), 0);
  assert.equal(f.calls[0]!.payload.our_words, undefined);
  assert.equal(f.calls[0]!.payload.event_source_ranges, undefined);
  // 包4裁定6：手工绑定已退出模型面——旧名称被拒，同样不影响已保存记忆
  const bind = await f.tools.execute('memory_source_bind', { memory_id: 'saved-1', start_seq: 1, end_seq: 1 }, f.ctx);
  assert.equal(bind.ok, false);
  assert.equal(bind.output.error_code, 'TOOL_NOT_IN_ALLOWLIST');
  assert.equal(f.calls.length, 1, '不重新写入记忆');
  assert.equal((f.db.prepare('SELECT state FROM tool_side_effects').get() as any).state, 'committed');
});

test('记录新计划保留 plan 分类，让 Mariposa 发号并将关联 ID 返回给模型', async t => {
  const f = fixture(t);
  const saved = await f.tools.execute('memory_hold', { ...f.args, categories: ['plan'] }, f.ctx);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.output.plan_ids, ['plan_server_id']);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.payload.categories, ['plan']);
  assert.equal(f.calls[0]!.payload.plan_ids, undefined);
});

test('通话期间写记忆可以关联已有计划，创建新计划受既有通话限制', async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO voice_calls(call_id,conversation_id,state,started_at) VALUES ('call-plan','c1','active',?)").run(new Date().toISOString());
  const args = { ...f.args, categories: ['plan'] };
  const denied = await f.tools.execute('memory_hold', args, f.ctx);
  assert.equal(denied.output.error_code, 'TOOL_UNAVAILABLE_IN_CALL');
  assert.equal(f.calls.length, 0);
  const linked = await f.tools.execute('memory_hold', { ...args, plan_ids: ['plan_server_id'] }, f.ctx);
  assert.equal(linked.ok, true);
  assert.deepEqual(f.calls[0]!.payload.plan_ids, ['plan_server_id']);
});

test('真实旧冻结定义携带未读引用及来源范围：仍保存，并明确告知附件未执行', async t => {
  const f = fixture(t);
  const old = JSON.parse(fs.readFileSync(new URL('../fixtures/window-tools-before-autonomy.json', import.meta.url), 'utf8'));
  freezeWindowTools(f.db, 'w1', [old.catalog.find((s: any) => s.function.name === 'memory_hold')], 'legacy');
  const saved = await f.tools.execute('memory_hold', { ...f.args, quotes: [{ seq: 99 }], source_ranges: [{ start_seq: 98, end_seq: 99 }] }, f.ctx);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.output.source_status, 'unbound');
  assert.match(String(saved.output.note), /未执行/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.syncs(), 0);
  assert.equal(f.calls[0]!.payload.our_words, undefined);
  assert.equal(f.calls[0]!.payload.event_source_ranges, undefined);
});
