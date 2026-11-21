import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { HeartbeatCards, type HeartbeatSource } from '../../apps/host/src/modules/heartbeat/service.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';

const DAY = '2026-11-20';
const NEXT_DAY = '2026-11-21';
const AT = '2026-11-20T01:00:00.000Z';
const SOURCES = Array.from({ length: 10 }, (_, index): HeartbeatSource => ({
  kind: 'archive', namespace: 'estomago', id: `archive-${index + 1}`, revision: 2,
  identity: `archive:${index + 1}`, permissionScope: 'primary',
}));

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db, sha256Hex);
  db.prepare('INSERT INTO conversations(id,created_at) VALUES(?,?)').run('primary', AT);
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES('window','primary','ACTIVE',?,?)")
    .run(AT, AT);
  let now = Date.parse(AT);
  const cards = new HeartbeatCards(db, () => now);
  const run = (runId: string) => db.prepare(`
    INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,created_at,updated_at)
    VALUES(?,'heartbeat','primary','jiaming','keepwarm',1,?,'running',?,?)
  `).run(runId, runId, AT, AT);
  const end = (runId: string) => {
    db.prepare("UPDATE background_runs SET state='completed' WHERE id=?").run(runId);
    cards.closeRun(runId);
  };
  const request = (runId: string, operationId: string, id: string) => {
    const content = JSON.stringify({ heartbeat_card: { operation_id: operationId } });
    const payload = JSON.stringify({ messages: [{ role: 'tool', tool_call_id: operationId, content }] });
    db.prepare(`
      INSERT INTO provider_requests(id,window_id,purpose,seen_manifest_json,payload_json,background_run_id,dispatch_started_at,created_at)
      VALUES(?,'window','cache_keepalive','[]',?,?,?,?)
    `).run(id, payload, runId, AT, AT);
    return () => db.prepare('UPDATE provider_requests SET sent_at=? WHERE id=?').run(AT, id);
  };
  const prepare = (runId: string, cardNumber: number, operationId = 'draw') => {
    const operation = { runId, operationId };
    assert.equal(cards.claim({ ...operation, cardNumber }).status, 'claimed');
    assert.equal(cards.recordSource({ ...operation, result: 'ready' }).status, 'prepared');
    return operation;
  };
  const deliver = (runId: string, cardNumber: number) => {
    const op = prepare(runId, cardNumber);
    const providerRequestId = `request-${runId}`;
    const markSent = request(runId, op.operationId, providerRequestId);
    assert.equal(cards.startDispatch({ ...op, providerRequestId }), true);
    markSent();
    assert.equal(cards.recordDelivery({ ...op, outcome: 'delivered', providerRequestId }), true);
  };
  return { db, cards, run, end, request, prepare, deliver, advanceDays: (days: number) => { now += days * 86_400_000; } };
}

test('freezes a complete daily deck and changes to exhausted mode only on a later heartbeat', t => {
  const { cards, run, end, deliver } = fixture(t);
  run('short');
  assert.equal(cards.begin({ runId: 'short', businessDate: DAY, candidates: SOURCES.slice(0, 9) })?.mode, 'unprepared');
  assert.equal(cards.getDeck('primary', DAY), null);
  assert.equal(cards.begin({ runId: 'short', businessDate: DAY, candidates: SOURCES })?.mode, 'unprepared');
  end('short');
  run('duplicate');
  assert.equal(cards.begin({ runId: 'duplicate', businessDate: DAY, candidates: [...SOURCES.slice(0, 9), SOURCES[0]!] })?.mode, 'unprepared');
  end('duplicate');

  for (let cardNumber = 1; cardNumber <= 10; cardNumber++) {
    const runId = `run-${cardNumber}`;
    run(runId);
    const result = cards.begin({ runId, businessDate: DAY, candidates: cardNumber === 1 ? SOURCES : [...SOURCES].reverse() });
    assert.equal(result?.mode, 'draw');
    deliver(runId, cardNumber);
    const replay = cards.claim({ runId, operationId: 'draw', cardNumber });
    assert.equal(replay.status, 'delivered');
    if (replay.status !== 'delivered') assert.fail();
    assert.equal(replay.source.id, `archive-${cardNumber}`);
    assert.equal(cards.claim({ runId, operationId: 'draw', cardNumber: 99 }).status, 'operation_conflict');
    assert.equal(cards.claim({ runId, operationId: 'separate', cardNumber: 1 }).status, 'already_started');
    assert.equal(cards.begin({ runId, businessDate: NEXT_DAY })?.mode, 'draw');
    end(runId);
  }

  assert.deepEqual(cards.getDeck('primary', DAY)?.deliveredNumbers, [1,2,3,4,5,6,7,8,9,10]);
  run('keepwarm');
  assert.equal(cards.begin({ runId: 'keepwarm', businessDate: DAY })?.mode, 'exhausted_keepwarm');
  assert.equal(cards.claim({ runId: 'keepwarm', operationId: 'draw', cardNumber: 1 }).status, 'inactive');
  end('keepwarm');
  run('next-date');
  assert.equal(cards.begin({ runId: 'next-date', businessDate: NEXT_DAY, candidates: SOURCES })?.mode, 'unprepared');
});

test('withheld and unknown results do not consume; an unknown slot cannot turn zero available cards into exhaustion', t => {
  const { db, cards, run, end, request, prepare, deliver } = fixture(t);
  run('undispatched');
  cards.begin({ runId: 'undispatched', businessDate: DAY, candidates: SOURCES });
  const undispatched = prepare('undispatched', 1);
  request('undispatched', undispatched.operationId, 'withheld')();
  db.prepare('UPDATE provider_requests SET payload_wire_json=? WHERE id=?')
    .run(JSON.stringify({ messages: [{ role: 'tool', tool_call_id: undispatched.operationId,
      content: '{"error_code":"TOOL_RESULT_NOT_DELIVERED"}' }] }), 'withheld');
  assert.equal(cards.startDispatch({ ...undispatched, providerRequestId: 'withheld' }), false);
  assert.equal(cards.recordDelivery({ ...undispatched, outcome: 'delivered', providerRequestId: 'withheld' }), false);
  end('undispatched');
  assert.equal(cards.claim({ ...undispatched, cardNumber: 1 }).status, 'not_dispatched');
  assert.equal(cards.getDeck('primary', DAY)?.availableNumbers.includes(1), true);
  for (let number = 1; number < 10; number++) {
    const runId = `next-${number}`;
    run(runId);
    cards.begin({ runId, businessDate: DAY });
    deliver(runId, number);
    end(runId);
  }

  run('unknown');
  cards.begin({ runId: 'unknown', businessDate: DAY });
  const unknown = prepare('unknown', 10);
  request('unknown', unknown.operationId, 'unknown-request');
  assert.equal(cards.startDispatch({ ...unknown, providerRequestId: 'unknown-request' }), true);
  assert.equal(cards.recordDelivery({ ...unknown, outcome: 'delivered', providerRequestId: 'unknown-request' }), false);
  end('unknown');
  assert.equal(cards.claim({ ...unknown, cardNumber: 10 }).status, 'unknown');

  run('no-available');
  const result = cards.begin({ runId: 'no-available', businessDate: DAY });
  assert.equal(result?.mode, 'source_unavailable');
  assert.deepEqual(result?.deck?.availableNumbers, []);
  assert.equal(result?.deck?.deliveredNumbers.length, 9);
  assert.equal(result?.deck?.exhausted, false);
  assert.equal(cards.startDispatch({ ...unknown, providerRequestId: 'unknown-request' }), false);
});

test('image cards require the materialized images in the actual provider envelope', t => {
  const { db, cards, run, prepare, request } = fixture(t);
  run('photo');
  assert.equal(cards.begin({ runId: 'photo', businessDate: DAY, candidates: SOURCES })?.mode, 'draw');
  const operation = prepare('photo', 1);
  const providerRequestId = 'photo-request';
  const markSent = request('photo', operation.operationId, providerRequestId);
  const text = JSON.stringify({ heartbeat_card: { operation_id: operation.operationId, image_count: 1 } });
  const envelope = (content: unknown) => JSON.stringify({
    messages: [{ role: 'tool', tool_call_id: operation.operationId, content }],
  });
  db.prepare('UPDATE provider_requests SET payload_wire_json=? WHERE id=?')
    .run(envelope(text), providerRequestId);
  assert.equal(cards.startDispatch({ ...operation, providerRequestId }), false, 'an image reference in a text receipt is not an image');
  db.prepare('UPDATE provider_requests SET payload_wire_json=? WHERE id=?')
    .run(envelope([{ type: 'text', text }, { type: 'image', source: { type: 'base64', data_redacted: true } }]), providerRequestId);
  assert.equal(cards.startDispatch({ ...operation, providerRequestId }), true);
  markSent();
  assert.equal(cards.recordDelivery({ ...operation, outcome: 'delivered', providerRequestId }), true);
});

test('a failed source keeps the original number unavailable and correction count is stable on replay', t => {
  const { cards, run, end } = fixture(t);
  run('source-change');
  cards.begin({ runId: 'source-change', businessDate: DAY, candidates: SOURCES });
  const op = { runId: 'source-change', operationId: 'invalid-source' };
  assert.equal(cards.claim({ ...op, cardNumber: 5 }).status, 'claimed');
  assert.equal(cards.recordSource({ ...op, result: 'ready' }).status, 'prepared');
  const invalid = cards.recordSource({ ...op, result: 'invalid' });
  assert.deepEqual(invalid, { status: 'rejected', reason: 'source_invalid', remainingNumbers: [1,2,3,4,6,7,8,9,10], retryAllowed: true });
  assert.deepEqual(cards.claim({ ...op, cardNumber: 5 }), invalid);
  const second = cards.claim({ ...op, operationId: 'second', cardNumber: 5 });
  assert.deepEqual(second, invalid);
  const third = cards.claim({ ...op, operationId: 'unsupported-number', cardNumber: 0 });
  assert.deepEqual(third, { ...invalid, reason: 'corrections_exhausted', retryAllowed: false });
  assert.equal(cards.claim({ ...op, operationId: 'fourth', cardNumber: 6 }).status, 'rejected');
  end('source-change');

  run('next');
  const next = cards.begin({ runId: 'next', businessDate: DAY, candidates: [...SOURCES].reverse() });
  assert.deepEqual(next?.deck?.availableNumbers, [1,2,3,4,6,7,8,9,10]);
  const valid = cards.claim({ runId: 'next', operationId: 'sixth', cardNumber: 6 });
  assert.equal(valid.status, 'claimed');
  if (valid.status !== 'claimed') assert.fail();
  assert.equal(valid.source.id, 'archive-6');
});

test('cooldown follows source identity and only the original reserved-note response can replay', t => {
  const { cards, run, end, deliver, advanceDays } = fixture(t);
  const archive = SOURCES[1]!;
  const note: HeartbeatSource = { ...SOURCES[0]!, kind: 'reserved_note', namespace: 'content', id: 'note',
    identity: 'content:future_note:note' };
  const replay: HeartbeatSource = { ...SOURCES[2]!, kind: 'moments', namespace: 'content', id: 'original-response',
    identity: 'content:first_reserved_response:note', replay: 'first_reserved_response' };
  const candidates = [note, archive, replay, ...SOURCES.slice(3)];
  run('note');
  cards.begin({ runId: 'note', businessDate: DAY, candidates });
  assert.equal(cards.reservedNoteDeliveryStatus(note.identity), 'undelivered');
  deliver('note', 1);
  assert.equal(cards.reservedNoteDeliveryStatus(note.identity), 'delivered');
  assert.deepEqual(cards.getDeliveredDraw('note')?.source, note);
  end('note');
  run('archive');
  cards.begin({ runId: 'archive', businessDate: DAY });
  deliver('archive', 2);
  end('archive');
  run('replay');
  cards.begin({ runId: 'replay', businessDate: DAY });
  deliver('replay', 3);
  assert.equal(cards.isSourceEligible(replay), true);
  assert.equal(cards.getDeck('primary', DAY)?.availableNumbers.includes(3), false);
  assert.equal(cards.isSourceEligible({ ...replay, replay: undefined }), false);
  end('replay');
  const wrapper = { ...archive, kind: 'moments' as const, id: 'wrapped-archive', revision: 3 };
  assert.equal(cards.isSourceEligible(wrapper), false);
  assert.equal(cards.isSourceEligible({ ...note, revision: 3 }), false);
  advanceDays(31);
  assert.equal(cards.isSourceEligible(wrapper), true);
  assert.equal(cards.isSourceEligible({ ...note, revision: 3 }), false);
  assert.equal(cards.isSourceEligible({ ...replay, identity: note.identity }), false);
});
