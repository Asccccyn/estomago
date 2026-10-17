// ESTOMAGO_CHAT_EXEC_V1 · WP1 系统红点服务行为（05 §2-§5；ALERT-02/03/04/05/06 服务面）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';

function makeAlerts() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-v1-alerts-'));
  const db = openDatabase(root);
  migrate(db, sha256Hex);
  const events = new EventService(db);
  const alerts = new SystemAlertService(db, events);
  return { db, events, alerts };
}

test('ALERT-02：已读与恢复独立——已读清红点但 open 保留；已读不 resolve；恢复后历史仍在', () => {
  const { db, alerts } = makeAlerts();
  const a = alerts.observe({ code: 'CACHE_KEEPWARM_FAILED', scopeKind: 'system', dedupeKey: 'keepwarm:win-1', observationId: 'obs-1', safeSummary: { title: '保温失败', count: 1 } });
  // 未读
  let s = alerts.summary('qiaosheng');
  assert.equal(s.unread_anomaly_count, 1);
  assert.equal(s.open_count, 1);
  // 已读：红点可消失，待处理仍在
  const item = alerts.list({ actorId: 'qiaosheng' }).items[0]!;
  alerts.markRead('qiaosheng', [{ alert_id: a.alertId, seen_event_sequence: item.last_event_sequence }]);
  s = alerts.summary('qiaosheng');
  assert.equal(s.unread_anomaly_count, 0);
  assert.equal(s.open_count, 1); // 已读≠恢复
  // 真实恢复（内部接口，带证据）→ 历史保留
  alerts.resolve('keepwarm:win-1', { summary: { action_taken: 'cache_renewed_confirmed' } });
  const resolvedList = alerts.list({ actorId: 'qiaosheng', lifecycle: 'resolved' }).items;
  assert.equal(resolvedList.length, 1);
  assert.equal(resolvedList[0]!.lifecycle, 'resolved');
  assert.notEqual(resolvedList[0]!.resolved_at, null);
  assert.equal(alerts.summary('qiaosheng').open_count, 0);
  // 已读动作本身没有产生模型调用/新异常（纯 DB 写，无 SSE alert.changed 之外的事件）
  const alertEvents = (db.prepare("SELECT payload_ref FROM runtime_stream_events WHERE kind = 'system.alert.changed'").all() as Array<{ payload_ref: string }>).map((r) => JSON.parse(r.payload_ref));
  assert.equal(alertEvents.length, 2); // open + resolved；已读不逐条发事件
  db.close();
});

test('ALERT-03：并发新告警不被"全部已读"吞掉——seen 单调不减，新版本/新告警保持未读', () => {
  const { alerts } = makeAlerts();
  const a = alerts.observe({ code: 'USAGE_MISSING', scopeKind: 'system', dedupeKey: 'usage:req-1', observationId: 'obs-a1' });
  const seq1 = alerts.list({ actorId: 'qiaosheng' }).items[0]!.last_event_sequence;
  alerts.markRead('qiaosheng', [{ alert_id: a.alertId, seen_event_sequence: seq1 }]);
  // 同一故障复发（新 observation）→ 新版本 sequence 更大，重新未读
  alerts.observe({ code: 'USAGE_MISSING', scopeKind: 'system', dedupeKey: 'usage:req-1', observationId: 'obs-a2' });
  let s = alerts.summary('qiaosheng');
  assert.equal(s.unread_anomaly_count, 1); // 102 未被旧已读吞掉
  // seen 倒退的旧快照提交不生效
  const cur = alerts.list({ actorId: 'qiaosheng' }).items[0]!;
  const before = alerts.summary('qiaosheng');
  alerts.markRead('qiaosheng', [{ alert_id: a.alertId, seen_event_sequence: seq1 - 1 }]);
  assert.equal(alerts.summary('qiaosheng').unread_anomaly_count, before.unread_anomaly_count); // 不倒退→仍按当前版本未读状态
  assert.ok(cur.last_event_sequence > seq1);
  // 快照之后到达的另一个新告警：两页面/重连读同一后端快照（非 localStorage 单点）
  alerts.observe({ code: 'CACHE_PARAMETER_REJECTED', scopeKind: 'system', dedupeKey: 'cache:param-1', observationId: 'obs-b1' });
  s = alerts.summary('qiaosheng');
  assert.equal(s.unread_anomaly_count, 2);
  assert.equal(s.highest_open_severity, 'warning');
});

test('ALERT-04：乱序重放不增加真实异常次数（observation_id 消费账本，非只比较 last_dedupe）', () => {
  const { db, alerts } = makeAlerts();
  alerts.observe({ code: 'RAW_ARCHIVE_FAILED', scopeKind: 'system', dedupeKey: 'archive:conv-1', observationId: 'obs-r1' });
  alerts.observe({ code: 'RAW_ARCHIVE_FAILED', scopeKind: 'system', dedupeKey: 'archive:conv-1', observationId: 'obs-r2' });
  let item = alerts.list({ actorId: 'qiaosheng' }).items[0]!;
  assert.equal(item.occurrence_count, 2);
  assert.equal(item.unread, true);
  // 旧 observation 乱序重放（stream/重试双源重复投递）→ 不当新复发
  const dup = alerts.observe({ code: 'RAW_ARCHIVE_FAILED', scopeKind: 'system', dedupeKey: 'archive:conv-1', observationId: 'obs-r1' });
  assert.equal(dup.counted, false);
  assert.equal(dup.duplicateObservation, true);
  item = alerts.list({ actorId: 'qiaosheng' }).items[0]!;
  assert.equal(item.occurrence_count, 2); // 仍 2，不是 3
  // 消费账本有两条真实输入
  const n = (db.prepare('SELECT COUNT(*) AS n FROM system_alert_observations').get() as { n: number }).n;
  assert.equal(n, 2);
  // 真正的新故障（新 observation）→ 3
  alerts.observe({ code: 'RAW_ARCHIVE_FAILED', scopeKind: 'system', dedupeKey: 'archive:conv-1', observationId: 'obs-r3' });
  assert.equal(alerts.list({ actorId: 'qiaosheng' }).items[0]!.occurrence_count, 3);
  db.close();
});

test('ALERT-05：正常关闭=info 不冒 critical；真实越界=critical；别名归一到正名；未注册 code 拒绝', () => {
  const { alerts } = makeAlerts();
  // AUTONOMOUS_DISABLED：正常终止（关掉自主后旧闭包被门拦住）——info，不进异常未读计数
  const normal = alerts.observe({ code: 'AUTONOMOUS_DISABLED', scopeKind: 'background_run', scopeId: 'run-1', dedupeKey: 'auto:run-1', observationId: 'obs-n1' });
  assert.equal(alerts.summary('qiaosheng').unread_anomaly_count, 0); // info 不计入 warning/critical 未读
  assert.ok(normal.alertId.length > 0);
  // 真实越界：关闭已生效仍派发 → critical
  alerts.observe({ code: 'DISPATCH_AFTER_DISABLED', scopeKind: 'background_run', scopeId: 'run-2', dedupeKey: 'dispatch:run-2', observationId: 'obs-x1', safeSummary: { switch_revision: 3, run_id: 'run-2' } });
  const s = alerts.summary('qiaosheng');
  assert.equal(s.unread_anomaly_count, 1);
  assert.equal(s.highest_open_severity, 'critical');
  // 来源细分名归一：BACKGROUND_BUDGET_EXHAUSTED → BACKGROUND_BUDGET_REACHED（warning，聚合一次可读提醒）
  alerts.observe({ code: 'BACKGROUND_BUDGET_EXHAUSTED', scopeKind: 'background_run', scopeId: 'run-3', dedupeKey: 'budget:run-3', observationId: 'obs-x2' });
  const items = alerts.list({ actorId: 'qiaosheng' }).items;
  assert.ok(items.some((i) => i.code === 'BACKGROUND_BUDGET_REACHED'));
  assert.ok(!items.some((i) => i.code === 'BACKGROUND_BUDGET_EXHAUSTED'));
  // 降级尝试被拒（warning 不能标成 info 隐藏）
  alerts.observe({ code: 'RETRY_BUDGET_EXCEEDED', severity: 'info', scopeKind: 'system', dedupeKey: 'retry:1', observationId: 'obs-x3' });
  assert.equal(alerts.list({ actorId: 'qiaosheng' }).items.find((i) => i.dedupe === undefined && i.code === 'RETRY_BUDGET_EXCEEDED')!.severity, 'critical');
  // 未注册 code：拒绝（不得任意字符串变红点）
  assert.throws(() => alerts.observe({ code: 'MY_RANDOM_STRING', scopeKind: 'system', dedupeKey: 'x', observationId: null }));
});

test('ALERT-06：错误信息不泄漏——payload 白名单元数据；safe_summary 私密键被丢弃；正文不进任何告警面', () => {
  const { db, alerts } = makeAlerts();
  alerts.observe({
    code: 'MEDIA_OR_TOOL_FAILED', scopeKind: 'integration', scopeId: 'siren', dedupeKey: 'siren:op-9',
    observationId: 'obs-p1',
    safeSummary: { title: '语音转写失败', count: 2, body: '她说的私密正文内容', api_key: 'sk-secret', url_query: '?token=abc', action_taken: 'aggregated' },
  });
  const item = alerts.list({ actorId: 'qiaosheng' }).items[0]!;
  assert.equal((item.safe_summary as { body?: string }).body, undefined); // 白名单外键丢弃
  assert.equal((item.safe_summary as { api_key?: string }).api_key, undefined);
  assert.equal((item.safe_summary as { title?: string }).title, '语音转写失败'); // 白名单内保留
  // SSE 事件 payload 只含元数据字段（无 summary 正文/无 dedupe_key 原文）
  const ev = JSON.parse((db.prepare("SELECT payload_ref FROM runtime_stream_events WHERE kind = 'system.alert.changed' ORDER BY sequence DESC LIMIT 1").get() as { payload_ref: string }).payload_ref);
  assert.deepEqual(Object.keys(ev).sort(), ['alert_id', 'code', 'lifecycle', 'occurrence_count', 'revision', 'severity']);
  db.close();
});

test('分页与过滤：default 20 / max 100 / lifecycle / unread_only / opaque cursor 不截断冒充完整', () => {
  const { alerts } = makeAlerts();
  for (let i = 0; i < 25; i++) alerts.observe({ code: 'USAGE_MISSING', scopeKind: 'system', dedupeKey: `usage:req-${i}`, observationId: `obs-page-${i}` });
  const page1 = alerts.list({ actorId: 'qiaosheng' }); // 默认 limit=20
  assert.equal(page1.items.length, 20);
  assert.equal(page1.has_more, true);
  assert.ok(page1.next_cursor);
  const page2 = alerts.list({ actorId: 'qiaosheng', cursor: page1.next_cursor });
  assert.equal(page2.items.length, 5);
  assert.equal(page2.has_more, false);
  assert.equal(page2.next_cursor, null);
  // 两页无重复无遗漏
  const ids = new Set([...page1.items, ...page2.items].map((i) => i.alert_id));
  assert.equal(ids.size, 25);
  // unread_only + 已读过滤
  alerts.markRead('qiaosheng', page1.items.map((i) => ({ alert_id: i.alert_id, seen_event_sequence: i.last_event_sequence })));
  const unreadPage = alerts.list({ actorId: 'qiaosheng', unreadOnly: true });
  assert.equal(unreadPage.items.length, 5); // 只剩第二页未读
  assert.ok(unreadPage.items.every((i) => i.unread));
  // 超过 max_limit 拒绝（不静默截断成"完整结果"）
  assert.throws(() => alerts.list({ actorId: 'qiaosheng', limit: 101 }));
});

test('准备态Bootstrap缺口绑定真实窗口：保持次数/故障事实，同事务发布新版本且可按窗口恢复', () => {
  const { db, events, alerts } = makeAlerts();
  try {
    const summary = { title: '心情文字未载全', detail: '已保留同快照核验过的 I 和计划。',
      window_id: 'pending:primary', reason: 'BOOTSTRAP_PAGE_TRANSPORT', count: 1, retryable: true };
    const observed = alerts.observe({ code: 'BOOTSTRAP_INCOMPLETE', scopeKind: 'integration', scopeId: 'mariposa',
      dedupeKey: 'bootstrap:pending:primary', observationId: 'prepare-failure-1', safeSummary: summary });
    const before = alerts.list({ actorId: 'qiaosheng' }).items[0]!;
    const subscriber = events.subscribe('primary');
    try {
      alerts.bindPreparedBootstrap('primary', 'window-real');
      const after = alerts.list({ actorId: 'qiaosheng' }).items[0]!;
      assert.equal(after.alert_id, observed.alertId);
      assert.equal(after.lifecycle, 'open');
      assert.equal(after.resolved_at, null);
      assert.equal(after.occurrence_count, before.occurrence_count);
      assert.equal(after.first_occurred_at, before.first_occurred_at);
      assert.equal(after.last_occurred_at, before.last_occurred_at);
      assert.equal(after.revision, before.revision + 1);
      assert.ok(after.last_event_sequence > before.last_event_sequence);
      assert.deepEqual(after.safe_summary, { ...summary, window_id: 'window-real' });
      const stored = db.prepare('SELECT dedupe_key FROM system_alerts WHERE id = ?').get(observed.alertId) as { dedupe_key: string };
      assert.equal(stored.dedupe_key, 'bootstrap:window-real');
      assert.equal(subscriber.queue.length, 1);
      assert.equal(subscriber.queue[0]!.sequence, after.last_event_sequence);
      const payload = JSON.parse(subscriber.queue[0]!.payload);
      assert.equal(payload.occurrence_count, 1);
      assert.equal(payload.revision, after.revision);
      assert.equal(payload.lifecycle, 'open');
      assert.doesNotMatch(subscriber.queue[0]!.payload, /心情文字|计划|pending/);
      alerts.bindPreparedBootstrap('primary', 'window-real');
      assert.equal(events.maxSequence(), after.last_event_sequence, '重复绑定不再发事件');
      assert.equal(alerts.resolve('bootstrap:pending:primary', { summary: { action_taken: 'test' } }).resolved, false);
      assert.equal(alerts.resolve('bootstrap:window-real', { summary: { action_taken: 'snapshot_verified_complete' } }).resolved, true);
      assert.equal(alerts.summary('qiaosheng').open_count, 0);
    } finally { events.unsubscribe(subscriber); }
  } finally { db.close(); }
});

test('准备态来源不存在或已恢复时绑定无副作用，不复活历史', () => {
  const { db, events, alerts } = makeAlerts();
  try {
    alerts.bindPreparedBootstrap('missing', 'window-new');
    assert.equal(alerts.list({ actorId: 'qiaosheng' }).items.length, 0);
    assert.equal(events.maxSequence(), 0);
    alerts.observe({ code: 'BOOTSTRAP_INCOMPLETE', scopeKind: 'integration', scopeId: 'mariposa',
      dedupeKey: 'bootstrap:pending:primary', observationId: null });
    alerts.resolve('bootstrap:pending:primary', { summary: { action_taken: 'snapshot_verified_complete' } });
    const before = db.prepare('SELECT * FROM system_alerts').all();
    const sequence = events.maxSequence();
    alerts.bindPreparedBootstrap('primary', 'window-new');
    assert.deepEqual(db.prepare('SELECT * FROM system_alerts').all(), before);
    assert.equal(events.maxSequence(), sequence);
  } finally { db.close(); }
});

test('真实窗口已有任何告警历史时不合并准备态缺口，不增加次数或覆盖目标', () => {
  const { db, events, alerts } = makeAlerts();
  try {
    for (const key of ['bootstrap:pending:primary', 'bootstrap:window-existing']) {
      alerts.observe({ code: 'BOOTSTRAP_INCOMPLETE', scopeKind: 'integration', scopeId: 'mariposa',
        dedupeKey: key, observationId: null, safeSummary: { reason: 'SYNTHETIC_GAP', window_id: key } });
    }
    alerts.resolve('bootstrap:window-existing', { summary: { action_taken: 'snapshot_verified_complete' } });
    const before = db.prepare('SELECT * FROM system_alerts ORDER BY id').all();
    const sequence = events.maxSequence();
    alerts.bindPreparedBootstrap('primary', 'window-existing');
    assert.deepEqual(db.prepare('SELECT * FROM system_alerts ORDER BY id').all(), before);
    assert.equal(events.maxSequence(), sequence);
    assert.equal(alerts.summary('qiaosheng').open_count, 1);
  } finally { db.close(); }
});
