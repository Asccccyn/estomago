import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendBackgroundPage, backgroundInputTime, backgroundInputToIso } from '../../apps/web/react/src/background-controls-model.ts';

test('预约输入与显示均使用北京时间，不受设备时区或跨日影响', () => {
  assert.equal(backgroundInputToIso('2026-10-24T00:05'), '2026-10-23T16:05:00.000Z');
  assert.equal(backgroundInputTime('2026-10-23T16:05:00.000Z'), '2026-10-24T00:05');
  assert.equal(backgroundInputTime(null), '');
  assert.throws(() => backgroundInputToIso('2026-02-30T08:00'));
});

test('后台列表续页按任务或运行ID去重并保留稳定次序', () => {
  const page = appendBackgroundPage([{ task_id: 'a', revision: 1 }, { task_id: 'b', revision: 1 }], [{ task_id: 'b', revision: 2 }, { task_id: 'c', revision: 1 }], 'task_id');
  assert.deepEqual(page, [{ task_id: 'a', revision: 1 }, { task_id: 'b', revision: 2 }, { task_id: 'c', revision: 1 }]);
});
