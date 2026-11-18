import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { ConversationToolsService } from '../../apps/host/src/modules/conversation/service.ts';

test('开窗携带按实际确认的修订和区间计入回读，未携带的余段正常返回', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, sha256Hex);
  try {
    const now = '2026-11-17T00:00:00Z';
    const messages = new MessageService(db);
    messages.ensureConversation('c1');
    const carried = messages.submitUserMessageWithTurn({
      conversationId: 'c1', content: '甲🦋后', clientMessageId: 'carry', occurredAt: now,
    }).message;
    db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w1','c1','ACTIVE',?,?)").run(now, now);
    db.prepare(`INSERT INTO provider_requests(id,window_id,purpose,payload_json,seen_manifest_json,created_at,sent_at)
      VALUES('current','w1','chat',?,?,?,?)`).run(JSON.stringify({ messages: [{ role: 'user', content: '甲🦋' }] }),
      JSON.stringify([{ id: carried.id, revision: 1, visible: true, char_start: 0, char_end: 2 }]), now, now);
    const read = new ConversationToolsService({ db }).conversationRead({ from_sequence: carried.sequence, to_sequence: carried.sequence },
      { roomId: 'c1', windowId: 'w1', turnId: null, purpose: 'chat', activeReviewId: null,
        seenSequence: 0, seenMessages: [], requestId: 'current' });
    const [entry] = read.output.entries as Array<Record<string, unknown>>;
    assert.deepEqual(entry!.unread_parts, [{ start_char: 2, end_char: 3, text: '后' }]);
    assert.deepEqual(read.seenAdditions, [{ id: carried.id, revision: 1, char_start: 2, char_end: 3 }]);
  } finally { db.close(); }
});
