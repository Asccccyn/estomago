// A quote remains eligible while its exact source revision/range is in the request's
// seen set, including after many later messages or repeated conversation_read calls.
// Synthetic local fixtures only; no model calls or memory writes.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { makeDb, tempRoot } from '../helpers.ts';

type Seen = { id: string; revision: number; char_start?: number; char_end?: number };
type Match = { messageId: string; revision: number; start: number; end: number; fragment: string };
type Result = Match[] | { error: string; index: number };

function fixture(t: TestContext) {
  const { db, root } = makeDb(tempRoot('quote-seen-scope-'), { seed: false });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const messages = new MessageService(db);
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  // Exercise the verifier without invoking the external memory service.
  const verifier = tools as unknown as { resolveQuotes(roomId: string, seen: readonly Seen[], quotes: string[]): Result };
  let serial = 0;
  const add = (content: string, room = 'scope-room'): Seen => {
    const submitted = messages.submitUserMessageWithTurn({ conversationId: room, content, clientMessageId: `scope-${serial++}`, occurredAt: '2026-10-17T00:00:00Z' });
    return { id: submitted.message.id, revision: 1 };
  };
  const later = () => Array.from({ length: 80 }, (_, i) => add(`synthetic later message ${i}`));
  const resolve = (seen: readonly Seen[], quotes: string[], room = 'scope-room') => verifier.resolveQuotes(room, seen, quotes);
  return { add, later, resolve, messages };
}

function matched(result: Result): Match[] {
  assert.ok(Array.isArray(result), 'an exact quote from a seen source must match');
  return result;
}

const noMatch = { error: 'QUOTE_MATCH_FAILED', index: 0 };

test('older exact quote remains usable after more than 60 later seen messages', (t) => {
  const f = fixture(t);
  const original = f.add('begin unique earlier quote end');
  const result = matched(f.resolve([original, ...f.later()], ['unique earlier quote']));
  assert.equal(result[0]!.messageId, original.id);
  assert.equal(result[0]!.revision, 1);
  assert.equal(result[0]!.start, 6);
  assert.equal(result[0]!.end, 26);
});

test('duplicate seen entries and rereading an older source cannot evict it', (t) => {
  const f = fixture(t);
  const original = f.add('unique reread source');
  const recent = f.add('unrelated newer source');
  const seen = [original, ...Array.from({ length: 80 }, () => ({ ...recent })), { ...original }];
  assert.equal(matched(f.resolve(seen, ['unique reread source']))[0]!.messageId, original.id);
});

test('removing an older source from the seen set or changing room still rejects it', (t) => {
  const f = fixture(t);
  const original = f.add('unique guarded source');
  const later = f.later();
  assert.deepEqual(f.resolve(later, ['unique guarded source']), noMatch);
  assert.deepEqual(f.resolve([original, ...later], ['unique guarded source'], 'different-room'), noMatch);
  assert.deepEqual(f.resolve([{ ...original, revision: 99 }, ...later], ['unique guarded source']), noMatch);
});

test('older seen revision remains eligible but unseen edited text does not', (t) => {
  const f = fixture(t);
  const original = f.add('unique original revision');
  const later = f.later();
  f.messages.editUserMessage(original.id, 'unique edited revision');
  const seen = [original, ...later];
  assert.equal(matched(f.resolve(seen, ['unique original revision']))[0]!.revision, 1);
  assert.deepEqual(f.resolve(seen, ['unique edited revision']), noMatch);
  assert.equal(matched(f.resolve([{ ...original, revision: 2 }, ...later], ['unique edited revision']))[0]!.revision, 2);
});

test('older partial read retains Unicode codepoint boundaries and rejects unread text', (t) => {
  const f = fixture(t);
  const original = f.add('未读𠮷已读原话尾部未读');
  const seen = [{ ...original, char_start: 3, char_end: 7 }, ...f.later()];
  const result = matched(f.resolve(seen, ['已读原话']))[0]!;
  assert.equal(result.start, 3);
  assert.equal(result.end, 7);
  assert.deepEqual(f.resolve(seen, ['未读𠮷']), noMatch);
  assert.deepEqual(f.resolve(seen, ['原话尾部']), noMatch);
});

test('older duplicate source references still cannot satisfy overlapping quotes twice', (t) => {
  const f = fixture(t);
  const original = f.add('first fragment; second fragment');
  const seen = [original, { ...original }, ...f.later()];
  assert.equal(matched(f.resolve(seen, ['first fragment', 'second fragment'])).length, 2);
  assert.deepEqual(f.resolve(seen, ['first fragment', 'first fragment']), { error: 'QUOTE_MATCH_FAILED', index: 1 });
});

test('identical text still resolves to the newest eligible source', (t) => {
  const f = fixture(t);
  const older = f.add('shared exact quote');
  const newer = f.add('shared exact quote');
  assert.equal(matched(f.resolve([older, newer, ...f.later()], ['shared exact quote']))[0]!.messageId, newer.id);
});
