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

test('v2.1：单开关状态文案只转述服务端资格（关闭/夜休次晨兜底/补觉不预告08:00/连续三次/下次心跳）', () => {
  const window = { start: '23:00', end: '08:00', timezone: 'Asia/Shanghai' };
  const format = (iso: string) => backgroundInputTime(iso).slice(-5);
  assert.equal(keepwarmStatusText({ blocked_reason: 'KEEPWARM_DISABLED' }, window, format), '已关闭 · 等待手动开启');
  assert.equal(
    keepwarmStatusText({
      blocked_reason: 'KEEPWARM_RESTING',
      resting: true,
      rest_recovery_mode: 'morning_0800',
      morning_wake: { scheduled: true, target_at: '2026-11-25T00:00:00.000Z', basis: 'morning_baseline' },
    }, window, format),
    '已开启 · 正常夜休暂停，次晨 08:00 有条件兜底',
  );
  // Catch-up sleep (>=02:00) or nap must NEVER preview 08:00.
  assert.equal(
    keepwarmStatusText({
      blocked_reason: 'KEEPWARM_RESTING_WAIT_USER',
      resting: true,
      rest_recovery_mode: 'next_user_message',
      morning_wake: { scheduled: false, reason: 'WAIT_NEXT_USER_MESSAGE' },
    }, window, format),
    '已开启 · 正在补觉，等你下条消息',
  );
  assert.equal(
    keepwarmStatusText({
      blocked_reason: 'KEEPWARM_CONSECUTIVE_LIMIT',
      consecutive_unanswered_count: 3,
      morning_wake: { scheduled: true, target_at: '2026-11-26T00:00:00.000Z', basis: 'morning_baseline' },
    }, window, format),
    '已开启 · 连续三次未出现，今日暂停（次晨 08:00 恢复）',
  );
  assert.equal(
    keepwarmStatusText({
      blocked_reason: 'KEEPWARM_SLEEP_WINDOW',
      sleep_window_active: true,
      morning_wake: { scheduled: true, target_at: '2026-11-25T00:00:00.000Z', basis: 'morning_baseline' },
    }, window, format),
    '已开启 · 夜间暂停（23:00–08:00，Asia/Shanghai），次晨 08:00 有条件兜底',
  );
  assert.equal(
    keepwarmStatusText({
      blocked_reason: 'KEEPWARM_SLEEP_WINDOW',
      sleep_window_active: false,
      scheduled: false,
      next_keepwarm_at: '2026-11-24T15:30:00.000Z',
    }, window, format),
    '已开启 · 下次到点落在睡眠时段，届时暂停（23:00–08:00，Asia/Shanghai）',
  );
  assert.equal(keepwarmStatusText({ blocked_reason: 'KEEPWARM_SLEEP_CONFIG_INVALID' }, window, format), '已开启 · 睡眠时段配置无效，心跳已暂停');
  assert.equal(
    keepwarmStatusText({ blocked_reason: null, scheduled: true, next_keepwarm_at: '2026-11-24T22:52:00.000Z', next_keepwarm_basis: 'real_message' }, window, format),
    '已开启 · 下次心跳 06:52',
  );
  assert.equal(
    keepwarmStatusText({ blocked_reason: null, scheduled: true, next_keepwarm_at: '2026-11-25T00:00:00.000Z', next_keepwarm_basis: 'morning_baseline' }, window, format),
    '已开启 · 下次心跳 08:00（晨间兜底）',
  );
  assert.equal(keepwarmStatusText({ blocked_reason: null, scheduled: false }, window, format), '已开启 · 暂无排程（还没有真实聊天）');
  assert.equal(keepwarmStatusText(undefined, undefined, format), '已开启 · 暂无排程（还没有真实聊天）');
});
