import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZashideleMoments } from '../../apps/host/src/integrations/zashidele/moments.ts';

test('the living-room adapter preserves source truth and only forwards its read credential and pagination', async t => {
  const credentialRef = 'ESTOMAGO_SYNTHETIC_ZASH_FEED_TOKEN';
  process.env[credentialRef] = 'zash-synthetic-fixture-token';
  t.after(() => { delete process.env[credentialRef]; });
  const entry = {
    id: 'post-1', revision: 'a'.repeat(64), author_id: 'source-author', author_name: '原作者',
    author_kind: 'human', scope: 'attendees', source_kind: 'manual_post',
    created_at: '2026-11-20T02:00:00.000Z', text: '合成帖子', defaultAudienceIds: ['not-forwarded'],
  };
  const config = { base_url: 'https://zash.fixture/prefix', credential_ref: credentialRef, archive_credential_ref: null };
  const touched: Array<{ url: string; method?: string; redirect?: string; auth: string | null }> = [];
  const feed = new ZashideleMoments(config, async (url, init) => {
    const href = String(url);
    touched.push({ url: href, method: init?.method, redirect: init?.redirect, auth: new Headers(init?.headers).get('Authorization') });
    if (href.endsWith('/removed')) return new Response('', { status: 404 });
    if (href.endsWith('/revoked')) return new Response('', { status: 401 });
    return Response.json({ items: [entry], next_cursor: 'next' });
  });
  const page = await feed.read(null, new URLSearchParams({ limit: '1', cursor: 'old', humanId: 'do-not-forward' }));
  assert.equal(page.status, 200);
  assert.deepEqual(touched, [{ url: 'https://zash.fixture/prefix/api/integrations/estomago/moments?limit=1&cursor=old',
    method: 'GET', redirect: 'error', auth: 'Bearer zash-synthetic-fixture-token' }]);
  const { defaultAudienceIds, ...expected } = entry;
  assert.deepEqual(page.body, { items: [expected], next_cursor: 'next' });
  assert.equal((await feed.read('removed', new URLSearchParams())).status, 404);
  assert.equal((await feed.read('revoked', new URLSearchParams())).status, 403);
  assert.equal((await feed.read('..', new URLSearchParams())).status, 400);
  const withDoubleSlash = new ZashideleMoments({ ...config, base_url: 'https://zash.fixture//untrusted.example' }, async url => {
    assert.equal(new URL(String(url)).origin, 'https://zash.fixture');
    return Response.json({ items: [], next_cursor: null });
  });
  assert.equal((await withDoubleSlash.read(null, new URLSearchParams())).status, 200);
});
