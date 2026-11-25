// 心跳保温与休息意图（v2.1）：本地快速路径 + R1/R4 修复 + 迁移 v92 + 夜间四小时与白天恢复单元验证。
// 隔离临时库；无网络、无模型。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyRestLocally, classifyRestRecoveryMode, detectRestIntent } from '../../apps/host/src/runtime/conversation-rest.ts';
import { ConversationActivityService } from '../../apps/host/src/runtime/wake-activity.ts';
import { bindMessageLifecycle } from '../../apps/host/src/application/message-lifecycle.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { EventService } from '../../apps/host/src/events/service.ts';
import { SystemAlertService } from '../../apps/host/src/observability/system-alerts.ts';
import { BackgroundSettingsService } from '../../apps/host/src/runtime/background-settings.ts';
import { BackgroundScheduler } from '../../apps/host/src/runtime/background-scheduler.ts';
import { keepwarmDispatchGate } from '../../apps/host/src/runtime/background-keepwarm-gate.ts';

function database(t: Pick<TestContext, 'after'>, prefix: string, upTo?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = openDatabase(root);
  migrate(db, sha256Hex, upTo);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db };
}

test('T-A05 + R4：本地休息意图判定与 Sol 分流——明确表达、午睡、未来续聊与否定转述均正确', () => {
  const rest = ['晚安，我睡了', '我们睡吧', '晚安', '晚安！', '晚安，爱你', '我先睡了，明天再聊', '我睡了，你也早点休息', '跟你说晚安',
    '那我也睡了', '我睡觉了', '去睡觉啦', '我先去休息了', '我好困，先睡了', '困死了，睡了', '晚安，明天见', '晚安，梦里见', '晚安，不要熬夜',
    '晚安，醒了叫我', '晚安不要熬夜', 'char晚安', '今天发生了很多很多事，工作也很累，就不一一说了，总之先这样吧，我先睡了', "I'm going to bed, good night",
    '晚安，等会再聊', '晚安，明天再继续聊', '我去午睡了', '先去睡个午觉'];
  const resume = ['我醒了', '我已经醒了', '我刚醒了', '早安，继续聊', '我回来了，我们接着聊', '早安', '早上好', '我起床了', '起来了', '我回来了', '继续聊吧',
    '今天睡得特别好，一起床就看到阳光，早安', '早安，今天几点出门？', '我醒了，你继续睡', '我没说我睡了，我还醒着呢'];
  const neither = ['昨天你说了晚安', '晚安这个功能怎么改', '我还不睡，先聊一会', '为什么说晚安还会叫醒', '“晚安”', '“晚安”是什么意思', '你先睡吧，我再玩一会',
    '我不想说晚安', '宝宝睡了，我们轻声聊', '我家宝宝睡了', '我们睡吧？', '我们睡吧?',
    '睡了吗', '今晚早点睡', '等会再睡', '我今天下午睡了午觉，现在精神很好', '早点睡哦', '我还不困，再陪我聊会儿', '不要说晚安', '别跟我说晚安了',
    '你醒了吗', '醒了叫我', '我还没醒', '明天起床叫我', '半夜又醒了', '他醒了', '昨天你说早安',
    '我说的是“晚安”这个词', '我去修一下服务器',
    '爱你', '再抱一下', '🌙', '', '   ', '哈哈哈', '今天天气真好'];
  for (const text of rest) assert.equal(detectRestIntent(text), 'rest', text);
  for (const text of resume) assert.equal(detectRestIntent(text), 'resume', text);
  for (const text of neither) assert.equal(detectRestIntent(text), null, text);
  assert.equal(detectRestIntent(undefined), null);
  assert.equal(detectRestIntent(42), null);

  // 本地快速路径 vs Sol 语义分流：简单直白走本地，口语/否定/引用/谈别人/暂离走 Sol
  assert.deepEqual(classifyRestLocally('晚安'), { kind: 'clear_rest', restKind: 'sleep' });
  assert.deepEqual(classifyRestLocally('我去睡了'), { kind: 'clear_rest', restKind: 'sleep' });
  assert.deepEqual(classifyRestLocally('我去午睡了'), { kind: 'clear_rest', restKind: 'nap_or_wait' });
  assert.deepEqual(classifyRestLocally('今天天气真好'), { kind: 'clear_not_rest' });
  for (const semantic of [
    '晚安，明天再继续聊',
    '我没说我睡了，我还醒着呢',
    '宝宝睡了，我们轻声聊',
    '今天撑不住了，先到这，明天说',
    '我去修一下服务器',
    '我说的是“晚安”这个词',
  ]) {
    assert.deepEqual(classifyRestLocally(semantic), { kind: 'needs_sol' }, semantic);
  }

  // 02:00:00 整点分界
  assert.deepEqual(classifyRestRecoveryMode(Date.parse('2026-11-24T22:30:00+08:00'), 'sleep'), { mode: 'morning_0800', morningDate: '2026-11-25' });
  assert.deepEqual(classifyRestRecoveryMode(Date.parse('2026-11-25T01:59:59+08:00'), 'sleep'), { mode: 'morning_0800', morningDate: '2026-11-25' });
  assert.deepEqual(classifyRestRecoveryMode(Date.parse('2026-11-25T02:00:00+08:00'), 'sleep'), { mode: 'next_user_message', morningDate: null });
  assert.deepEqual(classifyRestRecoveryMode(Date.parse('2026-11-25T04:00:00+08:00'), 'sleep'), { mode: 'next_user_message', morningDate: null });
  assert.deepEqual(classifyRestRecoveryMode(Date.parse('2026-11-25T07:30:00+08:00'), 'sleep'), { mode: 'next_user_message', morningDate: null });
  assert.deepEqual(classifyRestRecoveryMode(Date.parse('2026-11-25T08:15:00+08:00'), 'sleep'), { mode: 'next_user_message', morningDate: null });
  assert.deepEqual(classifyRestRecoveryMode(Date.parse('2026-11-24T22:30:00+08:00'), 'nap_or_wait'), { mode: 'next_user_message', morningDate: null });
});

test('T-A01：49 分 59 秒不到期，50 分钟按原锚点到期；新真实对话、有效维护回执照旧更新目标', (t) => {
  const { db } = database(t, 'rest-anchor-');
  const activity = new ConversationActivityService(db);
  const first = '2026-10-23T14:00:00.000Z';
  activity.noteRealPublication('primary', 'm1', 1, first);
  const due = Date.parse(first) + 50 * 60_000;
  const target = (nowMs: number) => {
    const next = activity.nextKeepwarmTarget({ conversationId: 'primary', windowId: 'w1' });
    assert.ok(next.scheduled);
    return { ...next, notYet: nowMs < next.dueAtMs };
  };
  assert.deepEqual(target(due - 1_000), { scheduled: true, dueAtMs: due, basis: 'real_message', activityRevision: 1, notYet: true });
  assert.equal(target(due).notYet, false, '满 50 分钟即到期');
  activity.noteMaintenanceReceipt({ conversationId: 'primary', capturedActivityRevision: 1, requestId: 'r1', windowId: 'w1', dispatchStartedAtIso: '2026-10-23T14:10:00.000Z' });
  assert.deepEqual(target(due), { scheduled: true, dueAtMs: Date.parse('2026-10-23T14:10:00.000Z') + 50 * 60_000, basis: 'maintenance', activityRevision: 1, notYet: true },
    '有效维护回执按其派发时刻续温');
  activity.noteRealPublication('primary', 'm2', 1, '2026-10-23T14:20:00.000Z');
  assert.deepEqual(target(due), { scheduled: true, dueAtMs: Date.parse('2026-10-23T14:20:00.000Z') + 50 * 60_000, basis: 'real_message', activityRevision: 2, notYet: true },
    '新真实对话重设锚点并使旧回执失效');
});

test('H07 + R1 + v92 迁移：旧库升级保住有效休息与恢复模式，同键重放不改、新消息决定覆盖旧决定', (t) => {
  const { db } = database(t, 'rest-migration-', 91);
  const at = '2026-10-23T14:00:00.000Z'; // 22:00 Asia/Shanghai
  db.prepare("INSERT INTO conversation_activity(conversation_id,activity_revision,last_real_activity_at,resting,rest_decided_at,rest_source,rest_message_id,updated_at) VALUES ('legacy-night',7,?,1,?,'owner_message','m-old',?)").run(at, at, at);
  const atCatchup = '2026-10-23T19:00:00.000Z'; // 03:00 Asia/Shanghai
  db.prepare("INSERT INTO conversation_activity(conversation_id,activity_revision,last_real_activity_at,resting,rest_decided_at,rest_source,rest_message_id,updated_at) VALUES ('legacy-catchup',2,?,1,?,'owner_message','m-old2',?)").run(atCatchup, atCatchup, atCatchup);
  db.prepare("INSERT INTO conversation_activity(conversation_id,activity_revision,last_real_activity_at,updated_at) VALUES ('legacy-awake',3,?,?)").run(at, at);
  migrate(db, sha256Hex);
  migrate(db, sha256Hex);
  const activity = new ConversationActivityService(db);
  assert.deepEqual(activity.restState('legacy-night'), { resting: true, decided_at: at, source: 'owner_message', recovery_mode: 'morning_0800', morning_date: '2026-10-24' });
  assert.deepEqual(activity.restState('legacy-catchup'), { resting: true, decided_at: atCatchup, source: 'owner_message', recovery_mode: 'next_user_message', morning_date: null });
  assert.deepEqual(activity.restState('legacy-awake'), { resting: false, decided_at: null, source: null, recovery_mode: null, morning_date: null });
  assert.equal(activity.get('legacy-awake')!.consecutive_unanswered_count, 0, '旧库连续次数默认 0');
  assert.equal(activity.nextKeepwarmTarget({ conversationId: 'legacy-awake', windowId: 'w1' }).dueAtMs, Date.parse(at) + 50 * 60_000, '原排程不变');

  // R1：同消息重放不改决定时间；新消息的晚安覆盖旧决定和恢复条件
  const nightDecided = '2026-10-23T14:30:00.000Z'; // 22:30+08:00
  assert.equal(activity.noteRestDecision('legacy-awake', { kind: 'rest', source: 'owner_message', messageId: 'm-gn-1', atIso: nightDecided }), true);
  assert.equal(activity.noteRestDecision('legacy-awake', { kind: 'rest', source: 'owner_message', messageId: 'm-gn-1', atIso: '2026-10-23T14:35:00.000Z' }), false, '同消息重放不改决定');
  assert.equal(activity.get('legacy-awake')!.rest_recovery_mode, 'morning_0800');

  const morningCatchup = '2026-10-23T23:30:00.000Z'; // 07:30+08:00
  assert.equal(activity.noteRestDecision('legacy-awake', { kind: 'rest', source: 'owner_message', messageId: 'm-gn-2', atIso: morningCatchup }), true, '新消息的休息决定必须覆盖旧决定');
  assert.equal(activity.get('legacy-awake')!.rest_recovery_mode, 'next_user_message');
  assert.equal(activity.get('legacy-awake')!.rest_decided_at, morningCatchup);
  assert.equal(activity.get('legacy-awake')!.rest_message_id, 'm-gn-2');
  assert.deepEqual({ revision: activity.get('legacy-awake')!.activity_revision, anchor: activity.get('legacy-awake')!.last_real_activity_at }, { revision: 3, anchor: at }, '直接调用 noteRestDecision 不动锚点');

  // 界面恢复：同一操作键回放首次结果
  const first = activity.resumeRest('legacy-awake', { actorId: 'qiaosheng', operationId: 'ui-2' });
  assert.equal(first.changed, true);
  assert.equal(first.source, 'control');
  assert.deepEqual(activity.resumeRest('legacy-awake', { actorId: 'qiaosheng', operationId: 'ui-2' }), { ...first, duplicate: true });
  assert.equal(activity.resumeRest('nobody-resting', { actorId: 'qiaosheng', operationId: 'ui-3' }).changed, false);
});

test('T-A04：正常夜休在 21:45–07:59:59 零领取，08:00 给晨间兜底机会；自主预约照常', async (t) => {
  const { db } = database(t, 'rest-scheduler-');
  const config = buildConfig({});
  const settings = new BackgroundSettingsService(db, config);
  settings.applyUpdate({ expectedRevision: 0, patch: { keepwarm_enabled: true, keepwarm_daily_cost_cap_usd: 1, autonomous_enabled: true, autonomous_daily_cost_cap_usd: 1 } });
  let now = Date.parse('2026-10-23T21:40:00+08:00');
  const iso = new Date(now).toISOString();
  db.prepare("INSERT INTO conversations(id, owner_service, scope, title, created_at) VALUES ('primary','estomago','private',NULL,?)").run(iso);
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('w-rest','primary','ACTIVE',?,?)").run(iso, iso);
  db.prepare("UPDATE background_tasks SET next_due_at = ? WHERE kind = 'keepwarm'").run(iso);
  const appointment = '2026-10-25T09:00:00+08:00';
  db.prepare("INSERT INTO background_tasks(id,conversation_id,actor_id,kind,enabled,revision,schedule_kind,scheduled_at,next_due_at,timezone,payload_json,created_by_actor_id,origin,created_at,updated_at) VALUES ('auto','primary','jiaming','autonomous',1,1,'once',?,?,'Asia/Shanghai','{}','jiaming','self_schedule',?,?)").run(appointment, appointment, iso, iso);
  const executed: string[] = [];
  const scheduler = new BackgroundScheduler({ db, config, settings, alerts: new SystemAlertService(db, new EventService(db)), now: () => now, tickMs: 60_000, executor: { async executeRun(input) { executed.push(input.kind); return { outcome: 'noop' }; } } });
  scheduler.start();
  t.after(() => scheduler.stop());
  const activity = new ConversationActivityService(db);
  activity.noteRealPublication('primary', 'm1', 1, new Date(now - 3_000_001).toISOString());
  const heartbeatRuns = () => (db.prepare("SELECT COUNT(*) n FROM background_runs WHERE kind='keepwarm'").get() as { n: number }).n;
  const shownDue = () => (db.prepare("SELECT next_due_at FROM background_tasks WHERE kind='keepwarm'").get() as { next_due_at: string | null }).next_due_at;
  await scheduler.tick();
  assert.deepEqual(executed, ['keepwarm'], '未休息时照常领取');
  const before = heartbeatRuns();

  // 21:40 正常晚安：夜间零派发，任务行保留次晨 08:00 条件目标（R5）
  assert.equal(activity.noteRestDecision('primary', { kind: 'rest', source: 'owner_message', messageId: 'm-goodnight', atIso: iso }), true);
  const expectedMorningIso = new Date('2026-10-24T08:00:00+08:00').toISOString();
  for (const [label, time] of [
    ['21:45', '2026-10-23T21:45:00+08:00'],
    ['23:30', '2026-10-23T23:30:00+08:00'],
    ['00:10', '2026-10-24T00:10:00+08:00'],
    ['07:59:59', '2026-10-24T07:59:59+08:00'],
  ] as const) {
    now = Date.parse(time);
    await scheduler.tick();
    assert.equal(activity.resting('primary'), true, label);
    assert.equal(heartbeatRuns(), before, `${label} 没有新的心跳执行`);
    assert.equal(shownDue(), expectedMorningIso, `${label} 保留次晨 08:00 条件目标`);
  }
  now = Date.parse('2026-10-24T08:00:00+08:00');
  await scheduler.tick();
  assert.equal(heartbeatRuns(), before + 1, '08:00 执行当日晨间兜底');
  const morningRun = db.prepare("SELECT occurrence_key FROM background_runs WHERE kind='keepwarm' ORDER BY rowid DESC LIMIT 1").get() as { occurrence_key: string };
  assert.equal(morningRun.occurrence_key, 'morning-wake:primary:2026-10-24');

  // 显式自主预约在同一时段照常执行
  now = Date.parse('2026-10-24T08:05:00+08:00');
  db.prepare("UPDATE background_tasks SET next_due_at = ? WHERE id = 'auto'").run(new Date(now).toISOString());
  await scheduler.tick();
  assert.deepEqual(executed, ['keepwarm', 'keepwarm', 'autonomous']);

  // 处于休息时普通资格门在读牌组前即拒绝
  assert.equal(activity.noteRestDecision('primary', { kind: 'rest', source: 'owner_message', messageId: 'm-nap', atIso: new Date(now).toISOString(), restKind: 'nap_or_wait' }), true);
  assert.equal(keepwarmDispatchGate({ db, activity, conversationId: 'primary', windowId: 'w-rest', inputActivityRevision: null, nowMs: now }).resultCode, 'KEEPWARM_RESTING');
});

test('T-A05/T-A06：休息由首次接受的输入建立；重复提交、编辑、模型回复不触发；夜间<4h保持暂停、白天新消息自动恢复；语音条按可信转写判定', async (t) => {
  const { root, db } = database(t, 'rest-acceptance-');
  // 固定上海夜间 22:00 测试夜间行为
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T22:00:00+08:00') });
  const activity = new ConversationActivityService(db);
  const messages = new MessageService(db, bindMessageLifecycle({ surfacing: null, activity, voiceObservations: null }), activity);
  const submit = (content: string, clientMessageId: string, attachments: Parameters<MessageService['submitUserMessageWithTurn']>[0]['attachments'] = []) =>
    messages.submitUserMessageWithTurn({ conversationId: 'primary', content, clientMessageId, attachments });

  const earlier = submit('先聊一句', 'm-earlier');
  const goodnight = submit('晚安，我睡了', 'm-goodnight');
  assert.equal(activity.restState('primary').resting, true, '接纳入口同事务建立休息');
  assert.equal(activity.restState('primary').recovery_mode, 'morning_0800');
  assert.equal(activity.get('primary')!.rest_message_id, goodnight.message.id);
  assert.deepEqual({ revision: activity.get('primary')!.activity_revision, duplicate: submit('晚安，我睡了', 'm-goodnight').duplicate }, { revision: 2, duplicate: true }, '重复提交不重复受理');

  messages.editUserMessage(earlier.message.id, '我醒了');
  assert.equal(activity.restState('primary').resting, true, '编辑更早的旧消息不改变休息');
  const revBeforeSelfEdit = activity.get('primary')!.user_appearance_revision;
  messages.editUserMessage(goodnight.message.id, '我还在，继续聊');
  assert.equal(activity.restState('primary').resting, false, '尚未派发前编辑当条休息消息为继续聊可撤销该条休息');
  assert.equal(activity.get('primary')!.user_appearance_revision, revBeforeSelfEdit, '编辑本身不计为新的用户出现');
  const goodnight2 = submit('晚安，我睡了', 'm-goodnight-2');
  assert.equal(activity.restState('primary').resting, true);
  assert.equal(activity.get('primary')!.rest_message_id, goodnight2.message.id);
  messages.publishAssistantMessage({ conversationId: 'primary', turnId: 'turn-assistant', content: '早安，我醒了' });
  assert.equal(activity.restState('primary').resting, true, '模型回复不解除休息');

  // 夜间 22:01 补话（间隔 < 4 小时）：保持夜间暂停，不提前恢复
  t.mock.timers.setTime(Date.parse('2026-11-24T22:01:00+08:00'));
  for (const [index, line] of ['爱你', '再抱一下', '晚安', '🌙'].entries()) submit(line, `m-followup-${index}`);
  assert.equal(activity.restState('primary').resting, true, '夜间间隔不足 4 小时补话保持暂停');

  // 切到白天 10:00：语音条按已接受的可信转写判定；新普通消息无需说“我醒了”即恢复
  t.mock.timers.setTime(Date.parse('2026-11-25T10:00:00+08:00'));
  const config = buildConfig({});
  const media = new MediaService(db, buildPaths(root).mediaDir, config);
  const voice = async (id: string, transcript?: string) => {
    const pcm = Buffer.alloc(3200, id.length);
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
    const saved = await media.saveBuffer({ bytes: wav, purpose: 'chat_voice', operationId: `rest-voice-${id}`, createdBy: 'test', origin: 'upload' });
    if (transcript !== undefined) {
      db.prepare("INSERT INTO voice_transcripts(asset_id,conversation_id,operation_key,content_sha256,state,derived_text,derived_source,created_at,updated_at) VALUES (?,'primary',?,?,'ready',?,'siren:transcribe',?,?)")
        .run(saved.id, `t:${id}`, saved.content_sha256, transcript, new Date().toISOString(), new Date().toISOString());
    }
    return submit('', id, [{ asset_id: saved.id, presentation: 'voice' }]);
  };
  await voice('m-voice-rest', '我去午睡了');
  assert.equal(activity.restState('primary').resting, true, '语音转写里明确午睡即进入休息');
  assert.equal(activity.restState('primary').recovery_mode, 'next_user_message');
  t.mock.timers.setTime(Date.parse('2026-11-25T10:05:00+08:00'));
  await voice('m-voice-resume', '喝口水继续聊');
  assert.equal(activity.restState('primary').resting, false, '白天新普通消息自动恢复，无需特地说早安/我醒了');
});
