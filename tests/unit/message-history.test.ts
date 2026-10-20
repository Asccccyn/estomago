import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDb } from '../helpers.ts';
import { openDatabase, readSnapshot, type Db } from '../../apps/host/src/db/connection.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { shanghaiDayRange } from '../../apps/host/src/server/calendar-routes.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';

function fixture(t: TestContext) {
  const { db, root } = makeDb();
  const messages = new MessageService(db), events = new EventService(db);
  messages.ensureConversation('c1'); messages.ensureConversation('c2');
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, root, messages, events };
}

function seed(db: Db, seq: number, createdAt = '2026-10-19T01:00:00.000Z', conversationId = 'c1') {
  const id = `${conversationId}-m${seq}`, content = `synthetic ${seq}`;
  db.prepare("INSERT INTO messages(id,conversation_id,sequence,speaker,kind,current_revision,published_at,created_at) VALUES (?,?,?,'owner','text',1,?,?)").run(id, conversationId, seq, createdAt, createdAt);
  db.prepare("INSERT INTO message_revisions(id,message_id,revision,kind,content,content_hash,occurred_at,received_at,source) VALUES (?,?,1,'text',?,?,?,?,'fixture')")
    .run(`${id}-r1`, id, content, sha256Hex(content), createdAt, createdAt);
  return id;
}

test('首屏只取最近50条；向上分页精确终止，无重复和遗漏，序号空隙不影响游标', t => {
  const f = fixture(t);
  for (let i = 1; i <= 123; i++) seed(f.db, i * 2);
  seed(f.db, 9999, undefined, 'c2');
  const initial = f.messages.listMessagePage({ conversationId: 'c1', latest: true, limit: 50 });
  assert.equal(initial.messages.length, 50);
  assert.equal(initial.before_sequence, 148); assert.equal(initial.after_sequence, 246);
  assert.equal(initial.has_earlier, true); assert.equal(initial.has_later, false);
  const older = f.messages.listMessagePage({ conversationId: 'c1', beforeSequence: initial.before_sequence!, limit: 50 });
  assert.equal(older.before_sequence, 48); assert.equal(older.after_sequence, 146);
  assert.equal(older.has_earlier, true); assert.equal(older.has_later, true);
  const oldest = f.messages.listMessagePage({ conversationId: 'c1', beforeSequence: older.before_sequence!, limit: 50 });
  assert.equal(oldest.messages.length, 23); assert.equal(oldest.has_earlier, false);
  assert.deepEqual([...oldest.messages, ...older.messages, ...initial.messages].map(m => m.sequence), Array.from({ length: 123 }, (_, i) => (i + 1) * 2));
  assert.equal(f.messages.listMessagePage({ conversationId: 'c1', beforeSequence: 2, limit: 50 }).messages.length, 0);
});

test('正向分页和恰好满页的边界不靠页大小猜测', t => {
  const f = fixture(t);
  for (let i = 1; i <= 100; i++) seed(f.db, i);
  const first = f.messages.listMessagePage({ conversationId: 'c1', afterSequence: 0, limit: 50 });
  assert.equal(first.has_earlier, false); assert.equal(first.has_later, true);
  const second = f.messages.listMessagePage({ conversationId: 'c1', afterSequence: first.after_sequence!, limit: 50 });
  assert.equal(second.messages.length, 50); assert.equal(second.has_later, false);
  assert.equal(second.before_sequence, 51); assert.equal(second.after_sequence, 100);
  const latest = f.messages.listMessagePage({ conversationId: 'c1', latest: true, limit: 100 });
  assert.equal(latest.messages.length, 100); assert.equal(latest.has_earlier, false);
});

test('日期按上海创建日锚定第一条，向后读全局序号；编辑不会移动日期位置', t => {
  const f = fixture(t);
  seed(f.db, 1, '2026-10-18T15:59:59.999Z');
  const anchor = seed(f.db, 2, '2026-10-18T16:00:00.000Z');
  seed(f.db, 3, '2026-10-19T15:59:59.999Z');
  seed(f.db, 4, '2026-10-19T16:00:00.000Z');
  seed(f.db, 1, '2026-10-18T16:00:00.000Z', 'c2');
  f.messages.editUserMessage(anchor, 'edited today does not change original creation date');
  const dateRange = { date: '2026-10-19', ...shanghaiDayRange('2026-10-19')! };
  const page = f.messages.listMessagePage({ conversationId: 'c1', dateRange, limit: 50 });
  assert.deepEqual(page.messages.map(m => m.sequence), [2, 3, 4]);
  assert.equal(page.messages[0]!.current_revision, 2);
  assert.equal(page.before_sequence, 2); assert.equal(page.has_earlier, true);
  assert.equal(page.timezone, 'Asia/Shanghai'); assert.equal(page.empty_date, false);
  const nextDay = f.messages.listMessagePage({ conversationId: 'c1', dateRange: { date: '2026-10-20', ...shanghaiDayRange('2026-10-20')! } });
  assert.deepEqual(nextDay.messages.map(m => m.sequence), [4]);
  const emptyDate = f.messages.listMessagePage({ conversationId: 'c1', dateRange: { date: '2026-10-18', ...shanghaiDayRange('2026-10-18')! } });
  assert.deepEqual(emptyDate.messages.map(m => m.sequence), [1, 2, 3, 4]);
  const absent = f.messages.listMessagePage({ conversationId: 'c1', dateRange: { date: '2026-10-17', ...shanghaiDayRange('2026-10-17')! } });
  assert.deepEqual(absent.messages, []); assert.equal(absent.empty_date, true);
  assert.equal(absent.before_sequence, null); assert.equal(absent.after_sequence, null);
});

test('历史读取保留附件且无写入，不创建窗口、回合或模型请求', t => {
  const f = fixture(t);
  const id = seed(f.db, 1);
  f.db.prepare("INSERT INTO message_attachments(message_id,revision,position,asset_id,presentation,derived_text,derived_source,created_at) VALUES (?,1,0,'a1','voice','trusted transcript','fixture','now')").run(id);
  const changes = () => (f.db.prepare('SELECT total_changes() n').get() as { n: number }).n;
  const before = changes();
  const page = readSnapshot(f.db, () => f.messages.listMessagePage({ conversationId: 'c1', latest: true, limit: 50 }));
  assert.equal(page.messages[0]!.revision.attachments[0]!.derived_text, 'trusted transcript');
  assert.equal(changes(), before);
  for (const table of ['turns', 'attempts', 'windows', 'provider_requests']) assert.equal((f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
});

test('只读快照将消息页与事件水位绑定：并发提交留给水位之后的SSE，不被跳过', t => {
  const f = fixture(t);
  seed(f.db, 1);
  const writer = openDatabase(path.join(f.root, 'data'));
  try {
    const writerMessages = new MessageService(writer), writerEvents = new EventService(writer);
    let newMessageId = '';
    const snapshot = readSnapshot(f.db, () => {
      const page = f.messages.listMessagePage({ conversationId: 'c1', latest: true, limit: 50 });
      const posted = writerMessages.submitUserMessageWithTurn({ conversationId: 'c1', content: 'published after snapshot', clientMessageId: 'concurrent' });
      newMessageId = posted.message.id;
      writerEvents.publish('message.persisted', { conversationId: 'c1', turnId: posted.turnId, attemptId: posted.attemptId, payload: { message: posted.message } });
      return { page, event_cursor: f.events.maxSequence() };
    });
    assert.equal(snapshot.page.messages.length, 1);
    assert.equal(snapshot.event_cursor, 0, 'the watermark cannot include a commit absent from the message snapshot');
    assert.ok(f.events.maxSequence() > snapshot.event_cursor);
    assert.equal(f.messages.listMessagePage({ conversationId: 'c1', latest: true }).messages.at(-1)!.id, newMessageId);
  } finally { writer.close(); }
});
