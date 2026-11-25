import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendBackgroundPage, backgroundInputTime, backgroundInputToIso, keepwarmStatusText } from '../../apps/web/react/src/background-controls-model.ts';

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

test('T-A02：心跳状态文案只转述服务端资格，开关关闭、休息中、当前或到点时在睡眠时段都不展示可执行时间', () => {
  const window = { start: '23:00', end: '08:00', timezone: 'Asia/Shanghai' };
  const format = (iso: string) => iso.slice(0, 16);
  assert.equal(keepwarmStatusText({ blocked_reason: 'KEEPWARM_DISABLED' }, window, format), '心跳保温已关闭');
  assert.equal(keepwarmStatusText({ blocked_reason: 'KEEPWARM_RESTING', resting: true, rest_decided_at: '2026-11-24T21:00:00.000Z' }, window, format),
    '休息中：乔乔说晚安后暂停，等她明确醒来或在这里恢复（2026-11-24T21:00 起）');
  assert.equal(keepwarmStatusText({ blocked_reason: 'KEEPWARM_SLEEP_WINDOW', sleep_window_active: true }, window, format), '睡眠时段暂停（23:00–08:00，Asia/Shanghai）');
  // The page must not fall back to a timestamp the scheduler has already declared unexecutable.
  assert.equal(keepwarmStatusText({ blocked_reason: 'KEEPWARM_SLEEP_WINDOW', sleep_window_active: false, scheduled: false, next_keepwarm_at: '2026-11-24T23:30:00.000Z' }, window, format),
    '下次到点落在睡眠时段，届时暂停（23:00–08:00，Asia/Shanghai）');
  assert.equal(keepwarmStatusText({ blocked_reason: 'KEEPWARM_SLEEP_CONFIG_INVALID' }, window, format), '睡眠时段配置无效，心跳已暂停');
  assert.equal(keepwarmStatusText({ blocked_reason: null, scheduled: true, next_keepwarm_at: '2026-11-24T15:30:00.000Z', next_keepwarm_basis: 'maintenance' }, window, format), '下次 2026-11-24T15:30（按上次维护）');
  assert.equal(keepwarmStatusText({ blocked_reason: null, scheduled: true, next_keepwarm_at: '2026-11-24T15:30:00.000Z', next_keepwarm_basis: 'real_message' }, window, format), '下次 2026-11-24T15:30（按最后消息）');
  assert.equal(keepwarmStatusText({ blocked_reason: null, scheduled: false }, window, format), '暂无排程（还没有真实聊天）');
  assert.equal(keepwarmStatusText(undefined, undefined, format), '暂无排程（还没有真实聊天）');
});

test('普通保温排在前面时仍显示服务端的晨间目标和顺延依据', () => {
  assert.equal(keepwarmStatusText({
    scheduled: true,
    next_keepwarm_at: '2026-11-25T00:15:00.000Z',
    next_keepwarm_basis: 'maintenance',
    morning_wake: {
      scheduled: true,
      target_at: '2026-11-25T00:30:00.000Z',
      basis: 'morning_postponed',
      postponed_by_at: '2026-11-24T23:40:00.000Z',
    },
  }, undefined, (at) => backgroundInputTime(at).slice(-5)), '下次 08:15（按上次维护） · 晨间唤醒预计 08:30（按 07:40 聊天顺延）');
});
