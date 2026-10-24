import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConfig, validateConfig } from '../../apps/host/src/config/schema.ts';
import { keepwarmSleepState } from '../../apps/host/src/runtime/keepwarm-sleep.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundScheduler } from '../../apps/host/src/runtime/background-scheduler.ts';

test('睡眠时段：23:00 含、08:00 不含；跨午夜、显式时区、日间时段与关闭', () => {
  const window = buildConfig({}).background.keepwarm.sleep_window;
  for (const [time, blocked] of [['22:59:59', false], ['23:00:00', true], ['00:00:00', true], ['07:59:59', true], ['08:00:00', false]] as const) {
    assert.equal(keepwarmSleepState(window, Date.parse(`2026-10-23T${time}+08:00`)).blocked, blocked, time);
  }
  const la = { ...window, timezone: 'America/Los_Angeles' };
  assert.equal(keepwarmSleepState(la, Date.parse('2026-07-23T23:00:00-07:00')).blocked, true, '夏令时');
  assert.equal(keepwarmSleepState(la, Date.parse('2026-12-23T08:00:00-08:00')).blocked, false, '冬令时');
  const nap = { ...window, start: '13:00', end: '14:00' };
  assert.equal(keepwarmSleepState(nap, Date.parse('2026-10-23T13:00:00+08:00')).blocked, true);
  assert.equal(keepwarmSleepState(nap, Date.parse('2026-10-23T14:00:00+08:00')).blocked, false);
  assert.equal(keepwarmSleepState({ ...window, enabled: false }, Date.parse('2026-10-23T01:00:00+08:00')).blocked, false);
});

test('睡眠配置拒绝非法时间、同起止和无效时区；旧配置获得默认睡眠门', () => {
  for (const patch of [{ start: '9:00' }, { end: '24:00' }, { start: '08:00', end: '08:00' }, { timezone: 'Invalid/Zone' }]) {
    assert.ok(validateConfig({ background: { keepwarm: { sleep_window: patch } } }).issues.some(i => i.path.startsWith('background.keepwarm.sleep_window')));
  }
  const config = buildConfig({});
  assert.deepEqual(config.background.keepwarm.sleep_window, { enabled: true, start: '23:00', end: '08:00', timezone: 'Asia/Shanghai' });
  assert.equal(config.background.keepwarm.enabled, false, '不会自动开启付费保温');
  assert.equal(keepwarmSleepState({ ...config.background.keepwarm.sleep_window, timezone: 'Invalid/Zone' }, Date.now()).code, 'KEEPWARM_SLEEP_CONFIG_INVALID', '绕过配置校验也不放行');
});

test('睡眠 tick 零心跳领取；自主预约正常；跨边界 model/tool 及重试零新增派发与预占', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepwarm-sleep-'));
  const db = openDatabase(root);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  migrate(db, sha256Hex);
  const config = buildConfig({});
  const settings = new BackgroundSettingsService(db, config);
  settings.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1, autonomous_enabled: true, autonomous_daily_cost_cap_usd: 1 } });
  let now = Date.parse('2026-10-23T23:00:00+08:00');
  const iso = new Date(now).toISOString();
  db.prepare("UPDATE background_tasks SET next_due_at = ? WHERE kind = 'keepwarm'").run(iso);
  db.prepare("INSERT INTO background_tasks(id,conversation_id,actor_id,kind,enabled,revision,schedule_kind,scheduled_at,next_due_at,timezone,payload_json,created_by_actor_id,origin,created_at,updated_at) VALUES ('auto','primary','jiaming','autonomous',1,1,'once',?,?,'Asia/Shanghai','{}','jiaming','self_schedule',?,?)").run(iso, iso, iso, iso);
  const executed: string[] = [];
  const scheduler = new BackgroundScheduler({ db, config, settings, alerts: new SystemAlertService(db, new EventService(db)), now: () => now, tickMs: 60_000, executor: { async executeRun(input) { executed.push(input.kind); return { outcome: 'noop' }; } } });
  t.after(() => scheduler.stop());
  scheduler.start();
  await scheduler.tick();
  assert.deepEqual(executed, ['autonomous']);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM background_runs WHERE kind = 'keepwarm'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT next_due_at FROM background_tasks WHERE kind = 'keepwarm'").get() as { next_due_at: string | null }).next_due_at, null);
  // 已排队 run 的派发入口不依赖调度快照。进入睡眠前允许一个，之后绝不新增。
  db.prepare("INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,state,created_at,updated_at) VALUES ('kw','bgt_keepwarm_system','primary','jiaming','keepwarm',1,'kw-sleep','running',?,?)").run(iso, iso);
  const dispatch = (key: string, kind: 'model' | 'tool', attemptNo = 1) => scheduler.recordDispatchStart({ runId: 'kw', logicalActionKey: key, attemptNo, dispatchKind: kind, capabilityName: null, reservedCostMicroUsd: 10 });
  now = Date.parse('2026-10-23T22:59:59+08:00');
  assert.equal(dispatch('before', 'model').allowed, true);
  now = Date.parse('2026-10-23T23:00:00+08:00');
  assert.equal(dispatch('retry', 'model', 2).allowed, false);
  assert.equal(dispatch('tool', 'tool').allowed, false);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM background_dispatches').get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT reserved_cost_micro_usd n FROM background_runs WHERE id = 'kw'").get() as { n: number }).n, 10, '拒绝不写新预占，保留睡前已发生费用');
});
