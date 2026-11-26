import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ContentServer } from '../../apps/content/src/service.ts';

test('帖子和预留话固定读取正文及附件；源删除阻止读取和再编辑', async () => {
  assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
  const root = fs.mkdtempSync(path.join(process.env.ESTOMAGO_HOME!, 'source-revisions-'));
  const content = new ContentServer({ stateRoot: root, port: 0 });
  try {
    await content.start();
    const send = async (route: string, method = 'GET', body?: object, key?: string, revision?: number) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${content.token}`,
        'X-Actor': 'qiaosheng',
        'Content-Type': 'application/json',
      };
      if (key) headers['Idempotency-Key'] = key;
      if (revision) headers['If-Match'] = `"${revision}"`;
      const endpoint = route.startsWith('/internal/') ? route : '/api/v1/content/' + route;
      const response = await fetch(`http://127.0.0.1:${content.port}${endpoint}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, data: await response.json() };
    };

    for (const [collection, resourceType] of [['posts', 'post'], ['future-notes', 'future_note']]) {
      const created = await send(collection!, 'POST', { body: '初版', asset_ids: ['asset_old'] }, `${collection}:create`);
      assert.equal(created.status, 201);
      const route = `${collection}/${created.data.id}`;
      const replacement = { body: '新稿', asset_ids: ['asset_new'] };
      const edited = await send(route, 'PUT', replacement, `${collection}:edit`, 1);
      assert.equal(edited.status, 200);
      assert.equal(edited.data.revision, 2);
      assert.deepEqual(await send(route, 'PUT', replacement, `${collection}:edit`, 1), edited);
      assert.equal((await send(route, 'PUT', replacement, `${collection}:stale`, 1)).status, 409);

      const original = await send(`${route}?revision=1`);
      assert.equal(original.status, 200);
      assert.equal(original.data.body, '初版');
      assert.deepEqual(original.data.asset_ids, ['asset_old']);
      assert.equal(original.data.revision, 1);
      const latest = await send(route);
      assert.equal(latest.data.body, '新稿');
      assert.deepEqual(latest.data.asset_ids, ['asset_new']);
      const reference = await send(`references/${resourceType}/${created.data.id}`);
      assert.deepEqual(reference.data.asset_ids, ['asset_new']);
      const unavailable = await send(`${route}?revision=99`);
      assert.equal(unavailable.data.error.code, 'revision_unavailable');

      const deleted = await send(route, 'DELETE', undefined, `${collection}:delete`, 2);
      assert.equal(deleted.status, 200);
      assert.equal((await send(`${route}?revision=1`)).status, 410);
      assert.equal((await send(route, 'PUT', replacement, `${collection}:tombstone`, 3)).status, 409);
      assert.deepEqual((await send(`references/${resourceType}/${created.data.id}`)).data.asset_ids, []);
    }

    await send('future-notes', 'POST', { body: '甲' }, 'notes:first');
    await send('future-notes', 'POST', { body: '乙' }, 'notes:second');
    const first = await send('future-notes?limit=1');
    assert.equal(first.data.items.length, 1);
    const second = await send(`future-notes?limit=1&cursor=${first.data.next_cursor}`);
    assert.equal(second.data.items.length, 1);
    assert.notEqual(first.data.items[0].id, second.data.items[0].id);
    assert.equal(second.data.next_cursor, null);

    const note = await send('future-notes', 'POST', { body: '原留言' }, 'moment-source');
    const projection = {
      mode: 'draw', conversationId: 'primary', businessDate: '2026-11-20', version: 1, state: 'drawn_no_comment',
      card: { number: 1, source: { kind: 'reserved_note', namespace: 'content', id: note.data.id,
        revision: 1, identity: 'content:reserved_note:' + note.data.id, permissionScope: 'primary' } },
      messages: [], body: '此副本不应存进映射',
    };
    const ref = await send('/internal/heartbeat-projections/run-1', 'PUT', projection);
    assert.equal(ref.status, 200);
    assert.deepEqual(await send('/internal/heartbeat-projections/run-1', 'PUT', projection), ref);
    assert.equal((await send('posts')).data.items.length, 0);
    const refs = await send('posts?include_references=1');
    assert.equal(refs.data.items.length, 1);
    assert.equal(refs.data.items[0].body, null);
    assert.equal(refs.data.items[0].reference.body, undefined);

    const sourceUpdated = await send('future-notes/' + note.data.id, 'PUT', {
      body: '明确改写后的留言', _moment_ref: { post_id: ref.data.id, projection_revision: 1, block_id: 'card' },
    }, 'moment-source-edit', 1);
    assert.equal(sourceUpdated.status, 200);
    const display = await send('/internal/heartbeat-posts/' + ref.data.id + '/blocks/card',
      'PUT', { display_revision: sourceUpdated.data.revision }, 'moment-display-edit', 1);
    assert.equal(display.status, 200);
    assert.equal(display.data.observed_revision, 1);
    assert.equal(display.data.display_revision, 2);
    assert.equal((await send('future-notes/' + note.data.id + '?revision=1')).data.body, '原留言');

    const title = await send('/internal/heartbeat-posts/' + ref.data.id, 'PUT', { title: '阅读页标题' }, 'moment-title', 2);
    assert.equal(title.status, 200);
    assert.equal(title.data.title, '阅读页标题');
    assert.equal(title.data.body, null);
    assert.equal(title.data.display_edits.card.revision, 2);
    const tombstone = await send('/internal/heartbeat-posts/' + ref.data.id, 'DELETE', undefined, 'moment-delete', 3);
    assert.equal(tombstone.status, 200);
    const late = await send('/internal/heartbeat-projections/run-1', 'PUT', { ...projection, version: 2 });
    assert.equal(late.data.deleted, true);
    assert.equal((await send('posts?include_references=1')).data.items.length, 0);
    assert.equal((await send('future-notes/' + note.data.id)).data.body, '明确改写后的留言');
  } finally {
    await content.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
