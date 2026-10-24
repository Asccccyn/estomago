// R8′（2026-10-23）：媒体索引后台独立边界——检索不再前台补索引（不占会话串行链），
// 补全由独立循环有界批次执行；检索不完整与 no_match 分开如实报。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMediaBackfillTick, MEDIA_BACKFILL_BATCH_PER_TICK } from '../../apps/host/src/media/index/backfill.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');

function fakeIndex(opts: { pendingRooms: Record<string, string[]>; available?: boolean; fingerprint?: string | null; failEvery?: number } ) {
  const calls: string[] = [];
  const done = new Set<string>();
  let n = 0;
  const svc = {
    available: opts.available ?? true,
    workerFingerprint: async () => (opts.fingerprint === undefined ? 'fp-test' : opts.fingerprint),
    roomsWithUnindexedImages: (_ns?: string) => Object.entries(opts.pendingRooms).filter(([, ids]) => ids.some((id) => !done.has(id))).map(([room]) => room),
    unindexedImagesInRoom: (roomId: string, _ns?: string) => (opts.pendingRooms[roomId] ?? []).filter((id) => !done.has(id)),
    indexImage: async (assetId: string) => {
      n += 1;
      if (opts.failEvery && n % opts.failEvery === 0) throw new Error('worker 503');
      calls.push(assetId);
      done.add(assetId);
      return { indexed: true as const };
    },
  };
  return { svc, calls };
}

test('一跳有界：单房间 ≤5 图、其余房间下跳；中止即停', async () => {
  const { svc, calls } = fakeIndex({ pendingRooms: { r1: ['a1','a2','a3','a4','a5','a6','a7'], r2: ['b1'] } });
  const ac = new AbortController();
  const n1 = await runMediaBackfillTick(svc as never, ac.signal);
  assert.equal(n1, MEDIA_BACKFILL_BATCH_PER_TICK);
  assert.deepEqual(calls, ['a1','a2','a3','a4','a5'], '一跳只做前 5 张，a6/a7/r2 下跳');
  const n2 = await runMediaBackfillTick(svc as never, ac.signal);
  assert.ok(calls.includes('a6') && calls.includes('a7'));
  ac.abort();
  const n3 = await runMediaBackfillTick(svc as never, ac.signal);
  assert.equal(n3, 0, '中止后零动作');
});

test('worker 指纹不可用=本跳跳过（不重算整批）；单图失败不断跳、下跳再试', async () => {
  const off = fakeIndex({ pendingRooms: { r1: ['a1'] }, fingerprint: null });
  assert.equal(await runMediaBackfillTick(off.svc as never, new AbortController().signal), 0);
  assert.equal(off.calls.length, 0);
  const flaky = fakeIndex({ pendingRooms: { r1: ['a1','a2'] }, failEvery: 2 });
  await runMediaBackfillTick(flaky.svc as never, new AbortController().signal);
  assert.deepEqual(flaky.calls, ['a1'], '失败图跳过、成功图计数');
});
