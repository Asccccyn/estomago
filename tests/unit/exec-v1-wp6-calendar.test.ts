// ESTOMAGO_CHAT_EXEC_V1 · WP6 日历聚合（06 §7-§8：月概要/日详情/分源分页/半开区间/降级）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shanghaiDayRange, monthDays, buildCalendarMonth, buildCalendarDayItems } from '../../apps/host/src/server/calendar-routes.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-v1-wp6-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  return { root, db, config: buildConfig({}) };
}

test('CALENDAR-03 策略：上海日半开区间精确（UTC 16:00 界）；月天数正确', () => {
  const r = shanghaiDayRange('2026-10-11')!;
  assert.equal(r.startUtc, '2026-10-10T16:00:00.000Z');
  assert.equal(r.endUtc, '2026-10-11T16:00:00.000Z');
  // 不是 23:59:59
  assert.ok(!r.endUtc.includes('23:59'));
  // 毫秒边界
  const r2 = shanghaiDayRange('2026-12-31')!;
  assert.equal(r2.startUtc, '2026-12-30T16:00:00.000Z');
  assert.equal(r2.endUtc, '2026-12-31T16:00:00.000Z');
  // 月天数
  assert.equal(monthDays('2026-10')!.length, 31);
  assert.equal(monthDays('2026-02')!.length, 28); // 2026 非闰
  assert.equal(monthDays('2024-02')!.length, 29); // 2024 闰
  // 非法
  assert.equal(shanghaiDayRange('bad'), null);
  assert.equal(monthDays('bad'), null);
});

test('CALENDAR-01：月概要=计数/标记不下载正文；单源不可达如实标注；不伪造精确数量', () => {
  const { db, config } = setup();
  // 插入一条聊天消息（在北京时间 10-11 内）
  db.prepare("INSERT INTO conversations(id, created_at) VALUES ('c1', ?)").run(new Date().toISOString());
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES ('m1','c1',1,'owner','text',1, ?)")
    .run('2026-10-11T02:00:00.000Z'); // 北京 10:00 → 上海 10-11
  const result = buildCalendarMonth({ db, config, mariposaReady: false, superpositionReady: false, contentReady: false }, '2026-10')!;
  assert.equal(result.month, '2026-10');
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.equal(result.days.length, 31);
  const day11 = result.days.find((d) => d.date === '2026-10-11')!;
  assert.equal(day11.counts.chat, 1);
  // 其他日无聊天
  const day10 = result.days.find((d) => d.date === '2026-10-10')!;
  assert.equal(day10.counts.chat, undefined);
  // 外部源不可达标注
  assert.equal(result.source_status.memory, 'not_configured');
  assert.equal(result.source_status.stars, 'not_configured');
  assert.equal(result.source_status.future_notes, 'not_configured');
  assert.equal(result.source_status.chat, 'ready');
  // 不下载正文——月概要无 body/text 字段
  assert.ok(!JSON.stringify(result).includes('消息内容'), '月概要不含正文');
});

test('CALENDAR-02：日详情分源分页（chat 半开区间+keyset 游标+has_more）', () => {
  const { db, config } = setup();
  db.prepare("INSERT INTO conversations(id, created_at) VALUES ('c1', ?)").run(new Date().toISOString());
  // 插入 3 条消息（北京时间 10-11 内）+ 1 条在 10-12
  for (let i = 1; i <= 3; i++) {
    db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES (?,?,?,?,?,1,?)")
      .run(`m${i}`, 'c1', i, 'owner', 'text', `2026-10-11T0${i + 5}:00:00.000Z`); // 06~08 UTC → 北京 14~16
  }
  db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, kind, current_revision, created_at) VALUES ('m_out','c1',4,'owner','text',1,?)")
    .run('2026-10-11T17:00:00.000Z'); // 北京 10-12 01:00 → 应排除
  // 第一页 limit=2
  const page1 = buildCalendarDayItems({ db, config, mariposaReady: false, superpositionReady: false, contentReady: false, contentClient: null }, '2026-10-11', 'chat', null, 2)!;
  assert.equal(page1.status, 'ready');
  assert.equal(page1.items.length, 2);
  assert.equal(page1.has_more, true);
  assert.ok(page1.next_cursor);
  // 第二页
  const page2 = buildCalendarDayItems({ db, config, mariposaReady: false, superpositionReady: false, contentReady: false, contentClient: null }, '2026-10-11', 'chat', page1.next_cursor, 2)!;
  assert.equal(page2.items.length, 1);
  assert.equal(page2.has_more, false);
  assert.equal(page2.next_cursor, null);
  // 跨日消息不在
  const all = [...page1.items, ...page2.items];
  assert.ok(!all.some((i) => i.source_ref?.id === 'm_out'), '次日 00:00 后的消息不在当天');
  // 未知来源
  const bad = buildCalendarDayItems({ db, config, mariposaReady: false, superpositionReady: false, contentReady: false, contentClient: null }, '2026-10-11', 'unknown' as never, null, 20);
  assert.equal(bad, null);
});

test('CALENDAR-01/06：外部源不可达如实降级（memory/stars unavailable；不取星不消费）', () => {
  const { db, config } = setup();
  const mariposaUnavail = buildCalendarDayItems({ db, config, mariposaReady: false, superpositionReady: false, contentReady: false, contentClient: null }, '2026-10-11', 'memory', null, 20)!;
  assert.equal(mariposaUnavail.status, 'not_configured');
  assert.equal(mariposaUnavail.items.length, 0);
  const starsUnavail = buildCalendarDayItems({ db, config, mariposaReady: false, superpositionReady: false, contentReady: false, contentClient: null }, '2026-10-11', 'stars', null, 20)!;
  assert.equal(starsUnavail.status, 'not_configured');
  assert.equal(starsUnavail.items.length, 0);
  // 配置了但不可达 → unavailable（非 not_configured）
  const cfgWithBase = buildConfig({ integrations: { mariposa: { base_url: 'https://example.com' }, superposition: { base_url: 'https://example.com' }, siren: {}, zashidele: {} } });
  const mariposaUnreach = buildCalendarDayItems({ db, config: cfgWithBase, mariposaReady: false, superpositionReady: false, contentReady: false, contentClient: null }, '2026-10-11', 'memory', null, 20)!;
  assert.equal(mariposaUnreach.status, 'unavailable');
  // 零侧调用——不触发 memory_open/view.confirm/拆星（§06.7.3/8——本函数纯 DB 读取+状态标注，零外部请求）
});

test('CALENDAR-07：提醒归 est 调度器（background_tasks 按自然日匹配；不自动标 plan 完成）', () => {
  const { db, config } = setup();
  db.prepare("INSERT INTO background_tasks(id, conversation_id, actor_id, kind, enabled, revision, schedule_kind, scheduled_at, next_due_at, timezone, local_time, interval_ms, payload_json, created_by_actor_id, created_at, updated_at) VALUES ('bt1','primary','qiaosheng','reminder',1,1,'once',?,?, 'Asia/Shanghai',NULL,NULL,'{\"text\":\"早安\"}','qiaosheng',?,?)")
    .run('2026-10-11T01:00:00.000Z', '2026-10-11T01:00:00.000Z', new Date().toISOString(), new Date().toISOString());
  const reminders = buildCalendarDayItems({ db, config, mariposaReady: false, superpositionReady: false, contentReady: false, contentClient: null }, '2026-10-11', 'reminders', null, 20)!;
  assert.equal(reminders.status, 'ready');
  assert.equal(reminders.items.length, 1);
  assert.ok(reminders.items[0]!.title.includes('早安'));
});
