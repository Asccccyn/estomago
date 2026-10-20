import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDb } from '../helpers.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { MessageRetryService, MessageRetryError } from '../../apps/host/src/messages/retry.ts';

function fixture(t: TestContext) {
  const { db, root } = makeDb();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w1','c1','ACTIVE','2026-10-19T01:00:00Z','2026-10-19T01:00:00Z')").run();
  db.prepare("UPDATE conversations SET active_window_id='w1' WHERE id='c1'").run();
  const trajectory = { messages: [{ role: 'system', content: [{ type: 'text', text: 'frozen-prefix' }] }], boundary: { messageIndex: 0, contentIndex: 0 }, manifest: [] };
  db.prepare("INSERT INTO window_trajectories(window_id,messages_json,last_boundary_json,manifest_json,updated_at) VALUES ('w1',?,?,?,'2026-10-19T01:00:00Z')")
    .run(JSON.stringify(trajectory.messages), JSON.stringify(trajectory.boundary), JSON.stringify(trajectory.manifest));
  const submitted = messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '  original\nmessage  ', clientMessageId: 'm1' });
  db.prepare("UPDATE turns SET state='failed', completed_at='2026-10-19T01:01:00Z' WHERE id=?").run(submitted.turnId);
  db.prepare("UPDATE attempts SET state='failed', blocked_reason='OR_NETWORK_ERROR:retry_later', window_id='w1', completed_at='2026-10-19T01:01:00Z' WHERE id=?").run(submitted.attemptId);
  const retry = new MessageRetryService(db, messages, 'openrouter');
  const input = { conversationId: 'c1', messageId: submitted.message.id, content: submitted.message.revision.content, expectedRevision: 1, operationKey: 'retry-1' };
  const counts = () => Object.fromEntries(['messages', 'message_revisions', 'attempts', 'outbox', 'message_retry_receipts'].map(table => [table, (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n]));
  return { db, messages, retry, submitted, input, counts };
}

test('同文字重试复用消息/修订/窗口，只新增 attempt；同键丢回执重放不重复生成', t => {
  const f = fixture(t);
  const before = f.counts();
  const trajectory = f.db.prepare('SELECT * FROM window_trajectories').get();
  const first = f.retry.retry({ ...f.input, content: '  original\r\nmessage  ' });
  assert.equal(first.message.id, f.submitted.message.id);
  assert.equal(first.message.current_revision, 1);
  assert.equal(first.turn_id, f.submitted.turnId);
  assert.notEqual(first.attempt_id, f.submitted.attemptId);
  assert.deepEqual(f.counts(), { ...before, attempts: 2, message_retry_receipts: 1 });
  assert.deepEqual(f.db.prepare('SELECT * FROM window_trajectories').get(), trajectory);
  const attempt = f.db.prepare('SELECT attempt_no,input_revision,retry_window_id,state FROM attempts WHERE id=?').get(first.attempt_id);
  assert.deepEqual({ ...attempt }, { attempt_no: 2, input_revision: 1, retry_window_id: 'w1', state: 'pending' });
  const replay = f.retry.retry(f.input);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.attempt_id, first.attempt_id);
  assert.equal(f.counts().attempts, 2);
  assert.throws(() => f.retry.retry({ ...f.input, operationKey: 'fresh-click' }), (e: unknown) => e instanceof MessageRetryError && e.code === 'RETRY_NOT_FAILED');
});

test('编辑重试原子保存新修订与附件、原 turn 新 attempt；成功后旧 If-Match 同键仍可重放', t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO message_attachments(message_id,revision,position,asset_id,presentation,caption,derived_text,derived_source,created_at) VALUES (?,1,0,'voice1','voice','caption','trusted transcript','siren:transcribe','2026-10-19T01:00:00Z')").run(f.input.messageId);
  const before = f.counts();
  const editedInput = { ...f.input, content: '  revised\nmessage  ', tokenEstimateJson: '{"scope":"test"}' };
  const first = f.retry.retry(editedInput);
  assert.equal(first.message.current_revision, 2);
  assert.equal(first.message.revision.content, editedInput.content);
  assert.equal(first.message.revision.supersedes_revision, 1);
  assert.equal(first.message.revision.attachments[0]!.derived_text, 'trusted transcript');
  assert.equal(first.message.revision.attachments[0]!.caption, 'caption');
  assert.equal((f.db.prepare('SELECT content FROM message_revisions WHERE message_id=? AND revision=1').get(f.input.messageId) as { content: string }).content, f.input.content);
  assert.equal((f.db.prepare('SELECT input_revision FROM attempts WHERE id=?').get(first.attempt_id) as { input_revision: number }).input_revision, 2);
  assert.deepEqual(f.counts(), { ...before, message_revisions: 2, attempts: 2, outbox: 2, message_retry_receipts: 1 });
  f.db.prepare("UPDATE turns SET state='completed' WHERE id=?").run(first.turn_id);
  f.db.prepare("UPDATE attempts SET state='completed' WHERE id=?").run(first.attempt_id);
  const replay = f.retry.retry(editedInput);
  assert.equal(replay.attempt_id, first.attempt_id);
  assert.equal(replay.message.reply_status!.state, 'completed');
  assert.equal(replay.message.reply_status!.can_retry, false);
  assert.throws(() => f.retry.retry({ ...editedInput, content: 'other' }), (e: unknown) => e instanceof MessageRetryError && e.code === 'idempotency_conflict');
  assert.throws(() => f.retry.retry({ ...editedInput, operationKey: 'new' }), (e: unknown) => e instanceof MessageRetryError && e.code === 'revision_conflict');
});

test('修订与 attempt 同事务：attempt 插入失败不留下半个编辑', t => {
  const f = fixture(t);
  const before = f.counts();
  f.db.exec("CREATE TRIGGER reject_retry BEFORE INSERT ON attempts WHEN NEW.attempt_no>1 BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(() => f.retry.retry({ ...f.input, content: 'changed' }), /fixture failure/);
  assert.deepEqual(f.counts(), before);
  assert.equal(f.messages.getMessage(f.input.messageId)!.revision.content, f.input.content);
});

test('受阻且尚无接受响应的最新输入可重试；空白文本无附件拒绝', t => {
  const f = fixture(t);
  f.db.prepare("UPDATE turns SET state='blocked' WHERE id=?").run(f.submitted.turnId);
  f.db.prepare("UPDATE attempts SET state='blocked', blocked_reason='MODEL_VISION_UNAVAILABLE' WHERE id=?").run(f.submitted.attemptId);
  assert.equal(f.retry.decorate([f.messages.getMessage(f.input.messageId)!])[0]!.reply_status!.can_retry, true);
  assert.throws(() => f.retry.retry({ ...f.input, content: ' \n　' }), (e: unknown) => e instanceof MessageRetryError && e.code === 'blank_content');
  assert.equal(f.counts().attempts, 1);
});

test('保留原附件时可清空文字，创建的新修订继续引用同一附件', t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO message_attachments(message_id,revision,position,asset_id,presentation,created_at) VALUES (?,1,0,'image1','image','now')").run(f.input.messageId);
  const result = f.retry.retry({ ...f.input, content: '' });
  assert.equal(result.message.current_revision, 2);
  assert.equal(result.message.revision.content, '');
  assert.equal(result.message.revision.attachments[0]!.asset_id, 'image1');
  assert.equal((f.db.prepare('SELECT COUNT(*) n FROM message_attachments WHERE message_id=?').get(f.input.messageId) as { n: number }).n, 2);
});

test('不安全的重发在修订前拒绝，批量消息状态和请求门一致', async t => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['RETRY_NOT_LATEST', f => { f.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'later', clientMessageId: 'later' }); }],
    ['RETRY_NOT_LATEST', f => { f.messages.publishSystemNotice({ conversationId: 'c1', content: 'later notice', clientMessageId: 'notice' }); }],
    ['RETRY_HAS_REPLY', f => { f.messages.publishAssistantMessage({ conversationId: 'c1', turnId: f.submitted.turnId, content: 'partial reply' }); }],
    ['RETRY_HAS_TOOL_ACTIVITY', f => { f.db.prepare("INSERT INTO tool_side_effects(id,turn_id,kind,state,created_at,updated_at) VALUES ('fx',?,'hold','unknown','now','now')").run(f.submitted.turnId); }],
    ['RETRY_INPUT_IN_HISTORY', f => { f.db.prepare("UPDATE window_trajectories SET manifest_json=? WHERE window_id='w1'").run(JSON.stringify([{ id: f.input.messageId, revision: 1, seq: 1 }])); }],
    ['RETRY_CONTEXT_UNAVAILABLE', f => { f.db.prepare('DELETE FROM window_trajectories').run(); }],
    ['RETRY_CONTEXT_CHANGED', f => { f.db.prepare("UPDATE attempts SET window_id='older-window' WHERE id=?").run(f.submitted.attemptId); }],
    ['RETRY_NOT_FAILED', f => { f.db.prepare("INSERT INTO attempts(id,turn_id,attempt_no,input_revision,state) VALUES ('newer',?,2,1,'running')").run(f.submitted.turnId); }],
    ['RETRY_CONVERSATION_BUSY', f => { f.db.prepare("INSERT INTO turns(id,conversation_id,trigger,state,created_at) VALUES ('other','c1','background','running','now')").run(); }],
    ['RETRY_ROUTE_PENDING', f => { f.db.prepare("INSERT INTO route_decisions(id,conversation_id,turn_id,attempt_id,input_hash,source_evidence,state,version,created_at) VALUES ('route','c1',?,?,'hash','fixture','pending',1,'now')").run(f.submitted.turnId, f.submitted.attemptId); }],
  ];
  for (const [reason, setup] of cases) await t.test(reason, child => {
    const f = fixture(child); setup(f); const before = f.counts();
    const status = f.retry.decorate(f.messages.listMessages({ conversationId: 'c1' })).find(m => m.id === f.input.messageId)!.reply_status!;
    assert.equal(status.can_retry, false); assert.equal(status.reason, reason);
    assert.throws(() => f.retry.retry({ ...f.input, content: 'must not save' }), (e: unknown) => e instanceof MessageRetryError && e.code === reason);
    assert.deepEqual(f.counts(), before);
    assert.equal(f.messages.getMessage(f.input.messageId)!.current_revision, 1);
  });
});

test('历史任一请求已收到响应即拒绝；只有 dispatch_started 不冒充收到响应', async t => {
  for (const evidence of ['sent_at', 'generation_id', 'outcome', 'dispatch_only']) await t.test(evidence, child => {
    const f = fixture(child);
    f.db.prepare("INSERT INTO provider_requests(id,window_id,attempt_id,turn_id,purpose,seen_manifest_json,created_at,dispatch_started_at,sent_at,generation_id,outcome) VALUES ('p1','w1',?,?,'chat','[]','now','now',?,?,?)")
      .run(f.submitted.attemptId, f.submitted.turnId, evidence === 'sent_at' ? 'now' : null, evidence === 'generation_id' ? 'g1' : null, evidence === 'outcome' ? 'completed' : 'error');
    const status = f.retry.decorate([f.messages.getMessage(f.input.messageId)!])[0]!.reply_status!;
    assert.equal(status.can_retry, evidence === 'dispatch_only');
    if (evidence !== 'dispatch_only') assert.equal(status.reason, 'RETRY_RESPONSE_STARTED');
  });
});
