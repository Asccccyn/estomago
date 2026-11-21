import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import { makeDb } from '../helpers.ts';
import { associateMomentEdit, recoverMomentEdits } from '../../apps/host/src/integrations/content/moment-edit-outbox.ts';
import type { IncomingMessage } from 'node:http';
import { decorateFutureNoteResponse, decorateMomentResponse, handleMomentReference } from '../../apps/host/src/server/routes/content-moments.ts';

const path = 'http://est.test/api/v1/content/moment-references/photo-post/blocks/card';

test('reference write recovers the confirmed source result and retries only the display association', async t => {
  const { db, root } = makeDb();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const contentPath = '/api/v1/content/future-notes/my-note';
  const displayPath = '/internal/heartbeat-posts/photo-post/blocks/card';
  const oldFetch = globalThis.fetch;
  const receipts = new Map<string, { fingerprint: string; body: unknown }>();
  let owner = 'qiaosheng';
  let sourceWrites = 0, displayWrites = 0, sourceRevision = 1, mappingRevision = 1;
  let displayEdits: Record<string, unknown> = {};
  const projection = {
    mode: 'draw', conversationId: 'primary', businessDate: '2026-11-20', version: 1, state: 'drawn',
    card: { number: 1, source: { kind: 'reserved_note', namespace: 'content', id: 'my-note', revision: 1, identity: 'note', permissionScope: 'primary' } },
    messages: [{ messageId: 'reply', revision: 1, sequence: 7 }],
  };
  const note = () => ({ id: 'my-note', revision: sourceRevision, author: owner, body: sourceRevision === 1 ? '原版' : '新版', asset_ids: [] });
  const mapping = () => ({ kind: 'reference', id: 'photo-post', revision: mappingRevision, reference: projection, display_edits: displayEdits });
  const fingerprint = (path: string, method: string, precondition: string, payload: unknown) => JSON.stringify([path, method, precondition, payload]);
  const result = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  globalThis.fetch = (async (raw, init) => {
    const url = new URL(String(raw));
    assert.equal(new Headers(init?.headers).get('x-actor'), 'qiaosheng');
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (url.pathname === '/api/v1/content/posts/photo-post') return result(mapping());
    if (url.pathname === contentPath) {
      if (url.search === '?revision=1') return result({ ...note(), revision: 1, body: '原版' });
      return result(note());
    }
    if (url.pathname === '/api/v1/content/operations/resolve') {
      const con = receipts.get(payload.idempotency_key);
      if (!con) return result({ outcome: 'new' });
      const same = con.fingerprint === fingerprint(payload.path, payload.method, payload.if_match, payload.body);
      return same ? result({ outcome: 'replay', status: 200, body: con.body }) : result({ outcome: 'conflict', status: 409, body: { error: { code: 'idempotency_conflict' } } });
    }
    if (url.pathname === displayPath) {
      displayWrites++;
      if (displayWrites === 1) return result({ error: { code: 'fake_offline' } }, 503);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('if-match'), '"1"');
      assert.deepEqual(payload, { display_revision: 2 });
      const replay = receipts.get(headers.get('idempotency-key')!);
      if (replay) {
        displayWrites--;
        return result(replay.body);
      }
      mappingRevision++;
      displayEdits = { card: { revision: 2, editor: 'qiaosheng' } };
      const body = { id: 'photo-post', block_id: 'card', source_id: 'my-note', source_revision: 2, observed_revision: 1, display_revision: 2, revision: 2 };
      receipts.set(headers.get('idempotency-key')!, { fingerprint: fingerprint(displayPath, 'PUT', '"1"', payload), body });
      return result(body);
    }
    assert.fail(`Unexpected Content path ${url.pathname}`);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = oldFetch; });

  const deps: Parameters<typeof handleMomentReference>[2] = {
    db,
    contentClient: { baseUrl: 'http://content.test', token: 'synthetic-only' },
    contentOps: {
      async write(options: { path: string; method: string; headers: Record<string, string>; body: unknown }) {
        sourceWrites++;
        assert.equal(options.path, contentPath);
        assert.equal(options.headers['if-match'], '"1"');
        assert.deepEqual(options.body, { body: '新版', _moment_ref: { post_id: 'photo-post', projection_revision: 1, block_id: 'card' } });
        sourceRevision++;
        const body = note();
        receipts.set(options.headers['idempotency-key']!, {
          fingerprint: fingerprint(options.path, options.method, '"1"', options.body), body,
        });
        return { status: 200, body };
      },
    } as never,
    messages: { getMessageAtRevision: (_conversation: string, id: string) => id === 'decline'
      ? { speaker: 'system', revision: { content: '[心跳唤醒] 本轮未抽卡', attachments: [] } }
      : { speaker: 'assistant', revision: { content: '真实发言', attachments: [] } } } as never,
    heartbeat: {
      sources: { resolve: async (source: { revision: number }) =>
        ({ status: 'available', text: source.revision === 1 ? '原版' : '新版', assetIds: [], imageIds: [] }) } as never,
      noteStatus: (_id, _conversation, deleted) => ({
        delivery_state: 'unknown', frozen_card: { number: 1, revision: 1, available: !deleted },
      }),
    },
  };
  const send = (body: string) => {
    const request = Readable.from([Buffer.from(JSON.stringify({ body, expected_source_revision: 1 }))]) as unknown as IncomingMessage;
    request.method = 'PUT';
    return handleMomentReference(request, new URL(path), deps, { 'if-match': '"1"', 'idempotency-key': 'one-browser-operation' });
  };
  const waiting = await send('新版');
  assert.equal(waiting?.status, 502);
  assert.equal((waiting?.body as { source_committed: boolean }).source_committed, true);
  assert.equal(sourceRevision, 2);
  assert.equal(mappingRevision, 1);
  assert.equal((await send('改变请求同一个键'))?.status, 409);

  const outbox = db.prepare("SELECT state,payload_ref FROM outbox WHERE target='content.moment_display_edit'").get();
  assert.equal(outbox?.state, 'unknown_outcome');
  assert.deepEqual(JSON.parse(String(outbox?.payload_ref)), { postId: 'photo-post', ifMatch: '"1"', sourceRevision: 2 });
  await recoverMomentEdits(db, deps.contentClient!, 5);
  assert.equal(db.prepare("SELECT state FROM outbox WHERE target='content.moment_display_edit'").get()?.state, 'acked');
  const recovered = await send('新版');
  assert.equal(recovered?.status, 200);
  assert.deepEqual(await send('新版'), recovered);
  assert.equal(sourceWrites, 1);
  assert.equal(displayWrites, 2);
  const feed = await decorateMomentResponse(new URL('http://est.test/api/v1/content/posts?include_references=1'), { items: [mapping()] }, deps) as
    { items: Array<{ reference?: unknown; blocks: Array<{ text?: string; observed_revision?: number; editable: boolean }> }> };
  assert.equal(feed.items[0]?.reference, undefined);
  assert.deepEqual(feed.items[0]?.blocks.map(block => [block.text, block.observed_revision, block.editable]), [['新版', 1, true], ['真实发言', 1, false]]);
  const declinedFeed = await decorateMomentResponse(new URL('http://est.test/api/v1/content/posts?include_references=1'), {
    items: [{ ...mapping(), reference: { ...projection, card: null, state: 'declined', messages: [{ messageId: 'decline', revision: 1, sequence: 8 }] } }],
  }, deps) as { items: Array<{ blocks: Array<{ text?: string }> }> };
  assert.deepEqual(declinedFeed.items[0]?.blocks.map(block => block.text), ['[心跳唤醒] 本轮未抽卡']);
  const original = await handleMomentReference({ method: 'GET' } as IncomingMessage, new URL(path + '?revision=1'), deps, {});
  assert.equal((original?.body as { text: string }).text, '原版');

  owner = 'jiaming';
  assert.equal((await send('新版'))?.status, 403, 'existing receipts still observe current author permission');
  const deletedNote = decorateFutureNoteResponse('/api/v1/content/future-notes/my-note', { ...note(), deleted: true }, deps) as
    { delivery_state: string; frozen_card: { available: boolean } };
  assert.equal(deletedNote.delivery_state, 'unknown');
  assert.equal(deletedNote.frozen_card.available, false);
});

test('projection CAS conflict and deletion are terminal association outcomes', async t => {
  const { db, root } = makeDb();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const oldFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = (async () => new Response('{}', { status: ++writes === 1 ? 409 : 410 })) as typeof fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const client = { baseUrl: 'http://content.test', token: 'synthetic-only' };
  const edit = { postId: 'post-1', ifMatch: '"1"', sourceRevision: 2 };
  assert.equal((await associateMomentEdit(db, client, 'cas-conflict', edit))?.status, 409);
  assert.equal((await associateMomentEdit(db, client, 'deleted', edit))?.status, 410);
  await recoverMomentEdits(db, client, 5);
  assert.equal(writes, 2);
  const states = db.prepare("SELECT state FROM outbox WHERE target='content.moment_display_edit'").all().map(row => row.state);
  assert.deepEqual(states, ['failed', 'failed']);
});
