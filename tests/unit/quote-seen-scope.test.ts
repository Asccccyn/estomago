// 勾选式话语（她 2026-10-18 裁定）：resolveQuoteRefs 只按消息序号取已见
// 原文——可见性门保留 D13（所见修订号）/O06（片段级已读范围）语义。
// Synthetic local fixtures only; no model calls or memory writes.
import { test, type TestContext } from 'node:test';
import { assembleTestTools, makeDb, tempRoot } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';

type Seen = { id: string; revision: number; char_start?: number; char_end?: number };
type Ref = { seq: number; from?: number; to?: number };
type Match = { messageId: string; revision: number; sequence: number; start: number; end: number; fragment: string };
type Result = Match[] | { error: string; index: number };

function fixture(t: TestContext) {
  const { db, root } = makeDb(tempRoot('quote-seen-scope-'), { seed: false });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const messages = new MessageService(db);
  const { tools: tools } = assembleTestTools({ db: db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db) });
  // Exercise the resolver without invoking the external memory service.
  const verifier = tools as unknown as { resolveQuoteRefs(roomId: string, seen: readonly Seen[], refs: Ref[]): Result };
  let serial = 0;
  const add = (content: string, room = 'scope-room'): Seen & { seq: number } => {
    const submitted = messages.submitUserMessageWithTurn({ conversationId: room, content, clientMessageId: `scope-${serial++}`, occurredAt: '2026-10-17T00:00:00Z' });
    return { id: submitted.message.id, revision: 1, seq: submitted.message.sequence };
  };
  const later = () => Array.from({ length: 80 }, (_, i) => add(`synthetic later message ${i}.`));
  const resolve = (seen: readonly Seen[], refs: Ref[], room = 'scope-room') => verifier.resolveQuoteRefs(room, seen, refs);
  return { add, later, resolve, messages };
}

function matched(result: Result): Match[] {
  assert.ok(Array.isArray(result), 'a seq in the seen set must resolve');
  return result;
}

const notSeen = { error: 'QUOTE_REF_SEQ_NOT_SEEN', index: 0 };

test('older message remains selectable after more than 60 later seen messages', (t) => {
  const f = fixture(t);
  const original = f.add('begin unique earlier quote end');
  const result = matched(f.resolve([original, ...f.later()], [{ seq: original.seq }]));
  assert.equal(result[0]!.messageId, original.id);
  assert.equal(result[0]!.revision, 1);
  assert.equal(result[0]!.fragment, 'begin unique earlier quote end');
});

test('duplicate seen entries cannot make a sentence be recorded twice', (t) => {
  const f = fixture(t);
  const original = f.add('first sentence. second sentence.');
  const seen = [original, { ...original }, ...f.later()];
  assert.equal(matched(f.resolve(seen, [{ seq: original.seq, from: 1, to: 1 }, { seq: original.seq, from: 2, to: 2 }])).length, 2);
  assert.deepEqual(f.resolve(seen, [{ seq: original.seq, from: 1, to: 1 }, { seq: original.seq, from: 1, to: 1 }]), { error: 'QUOTE_REF_DUPLICATE', index: 1 });
});

test('unseen seq / wrong room / unseen revision are all rejected', (t) => {
  const f = fixture(t);
  const original = f.add('unique guarded source.');
  const later = f.later();
  assert.deepEqual(f.resolve(later, [{ seq: original.seq }]), notSeen, '不在已见集合');
  assert.deepEqual(f.resolve([original, ...later], [{ seq: original.seq }], 'different-room'), notSeen, '房间不符');
  assert.deepEqual(f.resolve([{ ...original, revision: 99 }, ...later], [{ seq: original.seq }]), notSeen, '所见修订号不符（编辑后旧请求）');
});

test('older seen revision stays eligible; edits do not alter what was seen', (t) => {
  const f = fixture(t);
  const original = f.add('unique original revision.');
  const later = f.later();
  f.messages.editUserMessage(original.id, 'unique edited revision.');
  const seen = [original, ...later];
  assert.equal(matched(f.resolve(seen, [{ seq: original.seq }]))[0]!.revision, 1, '按所见修订抄录（当时看见的正文）');
  assert.equal(matched(f.resolve([{ ...original, revision: 2 }, ...later], [{ seq: original.seq }]))[0]!.fragment, 'unique edited revision.', '新修订在已见集合时按新正文');
});

test('partial read: sentence selection must stay inside the read codepoint range', (t) => {
  const f = fixture(t);
  const original = f.add('未读𠮷已读原话尾部未读。');
  const seen = [{ ...original, char_start: 3, char_end: 8 }, ...f.later()];
  // 第 1 句=整条；勾选整句落在已读范围（3..8 覆盖"已读原话尾部"）之外 → 拒
  assert.deepEqual(f.resolve(seen, [{ seq: original.seq }]), { error: 'QUOTE_REF_RANGE_NOT_SEEN', index: 0 }, '整句勾选超出已读码点范围');
  // 部分阅读场景下句子级勾选只有落在范围内才行——本夹具整句必然越界，
  // 范围校验由 hold-quote 的 emoji 用例覆盖码点口径
});

test('two refs on one message resolve in order', (t) => {
  const f = fixture(t);
  const original = f.add('one. two. three.');
  const result = matched(f.resolve([original, ...f.later()], [{ seq: original.seq, from: 3, to: 3 }, { seq: original.seq, from: 1, to: 1 }]));
  assert.equal(result[0]!.fragment, ' three.', '第 3 句（含句间空格——连续区间如实）');
  assert.equal(result[1]!.fragment, 'one.');
});
