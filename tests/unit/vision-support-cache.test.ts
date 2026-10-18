// 视觉元数据有效期不等于 prompt 缓存 TTL；全部 fetch/时钟离线注入。
import { test, beforeEach, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { clearVisionSupportCache, refreshVisionSupport, setVisionSupportForTests, visionSupportCached } from '../../apps/host/src/media/model-input.ts';

const MODEL = 'anthropic/claude-vision-test-1';
const BASE = 'https://openrouter.ai/api/v1';
const OTHER_BASE = 'https://other.example.invalid/api/v1';
const HOUR = 60 * 60 * 1000;
const START = Date.parse('2026-10-17T12:00:00Z');
const metadata = (modalities: unknown = ['text', 'image']) => ({ data: [{ id: MODEL, architecture: { input_modalities: modalities } }] });
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function clock(t: TestContext): { at: (offset: number) => void } {
  let now = START;
  t.mock.method(Date, 'now', () => now);
  return { at: (offset) => { now = START + offset; } };
}
beforeEach(clearVisionSupportCache);
afterEach(clearVisionSupportCache);

test('verified true and false remain fresh for 24 hours, rather than five minutes', (t) => {
  const time = clock(t);
  setVisionSupportForTests(MODEL, true);
  setVisionSupportForTests('anthropic/text-only-test', false);
  for (const age of [6 * 60 * 1000, 23 * HOUR, 24 * HOUR]) {
    time.at(age);
    assert.equal(visionSupportCached(MODEL), true);
    assert.equal(visionSupportCached('anthropic/text-only-test'), false);
  }
  time.at(24 * HOUR + 1);
  assert.equal(visionSupportCached(MODEL), null);
  assert.equal(visionSupportCached('anthropic/text-only-test'), null);
});

test('expired verified support survives temporary network, timeout, 429 and 5xx failures', async (t) => {
  const time = clock(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => response(metadata()));
  assert.equal(await refreshVisionSupport(BASE, MODEL), true);
  time.at(24 * HOUR + 1);
  assert.equal(visionSupportCached(MODEL), null, 'expiry still asks for a metadata refresh');
  const failures = [
    async (): Promise<Response> => { throw new TypeError('fetch failed'); },
    async (): Promise<Response> => { throw new DOMException('timed out', 'TimeoutError'); },
    ...[429, 500, 502, 503].map((status) => async () => response({}, status)),
  ];
  for (const fail of failures) {
    fetch.mock.mockImplementation(fail);
    assert.equal(await refreshVisionSupport(BASE, MODEL), true);
    assert.equal(visionSupportCached(MODEL), null, 'failed refresh does not start a fresh 24-hour TTL');
  }
});

test('network failure while reading a 200 response body can reuse recent verified support', async (t) => {
  const time = clock(t);
  setVisionSupportForTests(MODEL, true);
  time.at(25 * HOUR);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')); } })));
  assert.equal(await refreshVisionSupport(BASE, MODEL), true);
  fetch.mock.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('timed out', 'TimeoutError')); } })));
  assert.equal(await refreshVisionSupport(BASE, MODEL), true);
  time.at(48 * HOUR + 1);
  assert.equal(await refreshVisionSupport(BASE, MODEL), null);
});

test('repeated failed refreshes never extend the original 48-hour hard deadline', async (t) => {
  const time = clock(t);
  setVisionSupportForTests(MODEL, true);
  t.mock.method(globalThis, 'fetch', async () => response({}, 503));
  for (const age of [25 * HOUR, 47 * HOUR, 48 * HOUR]) {
    time.at(age);
    assert.equal(await refreshVisionSupport(BASE, MODEL), true);
  }
  time.at(48 * HOUR + 1);
  assert.equal(await refreshVisionSupport(BASE, MODEL), null);
});

test('observed hard expiry cannot revive after the wall clock rolls back from 49 to 25 hours', async (t) => {
  const time = clock(t);
  t.mock.method(globalThis, 'fetch', async () => response({}, 503));
  for (const check of ['cached', 'refresh']) {
    time.at(0);
    setVisionSupportForTests(MODEL, true);
    time.at(49 * HOUR);
    assert.equal(check === 'cached' ? visionSupportCached(MODEL) : await refreshVisionSupport(BASE, MODEL), null);
    time.at(25 * HOUR);
    assert.equal(await refreshVisionSupport(BASE, MODEL), null, 'hard-expired evidence was removed permanently');
  }
});

test('monotonic age enforces the hard deadline even when wall time moves backwards', async (t) => {
  const time = clock(t);
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.method(globalThis, 'fetch', async () => response({}, 503));
  setVisionSupportForTests(MODEL, true);
  time.at(47 * HOUR);
  elapsed = 47 * HOUR;
  assert.equal(await refreshVisionSupport(BASE, MODEL), true);
  time.at(25 * HOUR);
  elapsed = 49 * HOUR;
  assert.equal(await refreshVisionSupport(BASE, MODEL), null, '49 elapsed hours exceeds the deadline despite a 25-hour wall age');
  assert.equal(visionSupportCached(MODEL), null);
  setVisionSupportForTests(MODEL, true);
  time.at(24 * HOUR);
  assert.equal(visionSupportCached(MODEL), null, 'wall time before verification invalidates the evidence');
  time.at(25 * HOUR);
  assert.equal(await refreshVisionSupport(BASE, MODEL), null, 'an invalidated entry cannot revive after the clock recovers');
});

test('first lookup with no verified support remains blocked on temporary failure', async (t) => {
  clock(t);
  const fetch = t.mock.method(globalThis, 'fetch', async (): Promise<Response> => { throw new TypeError('offline'); });
  assert.equal(await refreshVisionSupport(BASE, MODEL), null);
  setVisionSupportForTests(MODEL, null);
  fetch.mock.mockImplementation(async () => response({}, 429));
  assert.equal(await refreshVisionSupport(BASE, MODEL), null);
});

test('an explicit non-image capability replaces previous true and cannot be revived by failure', async (t) => {
  const time = clock(t);
  setVisionSupportForTests(MODEL, true);
  time.at(25 * HOUR);
  const fetch = t.mock.method(globalThis, 'fetch', async () => response(metadata(['text'])));
  assert.equal(await refreshVisionSupport(BASE, MODEL), false);
  assert.equal(visionSupportCached(MODEL), false);
  fetch.mock.mockImplementation(async () => response({}, 503));
  assert.equal(await refreshVisionSupport(BASE, MODEL), null);
  assert.equal(visionSupportCached(MODEL), false);
  time.at(50 * HOUR);
  assert.equal(await refreshVisionSupport(BASE, MODEL), null);
});

test('missing models, invalid modalities and malformed JSON invalidate prior support', async (t) => {
  const time = clock(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => response({}));
  const invalid = [{ data: [] }, { data: [{ id: MODEL }] }, metadata([]), metadata([1]), metadata(null), null];
  for (const body of invalid) {
    time.at(0);
    setVisionSupportForTests(MODEL, true);
    time.at(25 * HOUR);
    fetch.mock.mockImplementation(async () => response(body));
    assert.equal(await refreshVisionSupport(BASE, MODEL), null);
    fetch.mock.mockImplementation(async () => response({}, 503));
    assert.equal(await refreshVisionSupport(BASE, MODEL), null, 'invalid evidence cannot fall back to old true');
  }
  setVisionSupportForTests(MODEL, true);
  fetch.mock.mockImplementation(async () => new Response('invalid JSON'));
  assert.equal(await refreshVisionSupport(BASE, MODEL), null);
  assert.equal(visionSupportCached(MODEL), null);
});

test('evidence is isolated by exact model and normalized API source', async (t) => {
  const time = clock(t);
  setVisionSupportForTests(MODEL, true, BASE);
  assert.equal(visionSupportCached(MODEL, BASE + '/'), true);
  assert.equal(visionSupportCached(MODEL, OTHER_BASE), null);
  assert.equal(visionSupportCached('anthropic/claude-other-test', BASE), null);
  time.at(25 * HOUR);
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => { urls.push(url); return response({}, 503); });
  assert.equal(await refreshVisionSupport(OTHER_BASE, MODEL), null);
  assert.equal(await refreshVisionSupport(BASE, 'anthropic/claude-other-test'), null);
  assert.equal(await refreshVisionSupport(BASE + '/', MODEL), true);
  assert.deepEqual(urls, [OTHER_BASE + '/models', BASE + '/models', BASE + '/models']);
});

test('non-transient HTTP failure does not reuse verified support', async (t) => {
  clock(t);
  setVisionSupportForTests(MODEL, true);
  const fetch = t.mock.method(globalThis, 'fetch', async () => response({}, 403));
  assert.equal(await refreshVisionSupport(BASE, MODEL), null);
  fetch.mock.mockImplementation(async () => response({}, 503));
  assert.equal(await refreshVisionSupport(BASE, MODEL), null);
});
