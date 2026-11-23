// 心跳保温修复 2026-11-23（C03/C04）：乔乔明确晚安后的休息状态、恢复，以及它在
// 计时、调度、资格门和消息接纳入口上的实际行为。隔离临时库；无网络、无模型。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectRestIntent } from '../../apps/host/src/runtime/conversation-rest.ts';
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

test('T-A05：休息意图只认她本人明确的表达——引用、提问、讨论功能、否定、继续聊天、对别人说都不算', () => {
  const rest = ['晚安，我睡了', '我们睡吧', '晚安', '晚安！', '晚安，爱你', '我先睡了，明天再聊', '我睡了，你也早点休息', '跟你说晚安',
    '那我也睡了', '我睡觉了', '去睡觉啦', '我先去休息了', '我好困，先睡了', '困死了，睡了', '晚安，明天见', '晚安，梦里见', '晚安，不要熬夜',
    '晚安，醒了叫我', '晚安不要熬夜', 'char晚安', '今天发生了很多很多事，工作也很累，就不一一说了，总之先这样吧，我先睡了', "I'm going to bed, good night", '晚安，等会再聊'];
  const resume = ['我醒了', '早安，继续聊', '我回来了，我们接着聊', '早安', '早上好', '我起床了', '起来了', '我回来了', '继续聊吧',
    '今天睡得特别好，一起床就看到阳光，早安', '早安，今天几点出门？', '我醒了，你继续睡'];
  const neither = ['昨天你说了晚安', '晚安这个功能怎么改', '我还不睡，先聊一会', '为什么说晚安还会叫醒', '“晚安”', '“晚安”是什么意思', '你先睡吧，我再玩一会',
    '睡了吗', '今晚早点睡', '等会再睡', '我午睡了', '我今天下午睡了午觉，现在精神很好', '早点睡哦', '我还不困，再陪我聊会儿', '不要说晚安', '别跟我说晚安了',
    '你醒了吗', '醒了叫我', '我还没醒', '明天起床叫我', '半夜又醒了', '他醒了', '昨天你说早安',
    '爱你', '再抱一下', '🌙', '', '   ', '哈哈哈', '今天天气真好'];
  for (const text of rest) assert.equal(detectRestIntent(text), 'rest', text);
  for (const text of resume) assert.equal(detectRestIntent(text), 'resume', text);
  for (const text of neither) assert.equal(detectRestIntent(text), null, text);
  assert.equal(detectRestIntent(undefined), null);
  assert.equal(detectRestIntent(42), null);
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

test('H07：v91 迁移可重跑；旧行按“未休息”读取；旧程序的写入形状仍可用；休息决定不动锚点和活动版本', (t) => {
  const { db } = database(t, 'rest-migration-', 90);
  const at = '2026-10-23T14:00:00.000Z';
  // 修复前就已存在的会话：没有休息字段，也没有任何历史可据以猜测她是否已睡。
  db.prepare("INSERT INTO conversation_activity(conversation_id,activity_revision,last_real_activity_at,updated_at) VALUES ('legacy',7,?,?)").run(at, at);
  migrate(db, sha256Hex);
  migrate(db, sha256Hex);
  const activity = new ConversationActivityService(db);
  assert.deepEqual(activity.restState('legacy'), { resting: false, decided_at: null, source: null });
  assert.equal(activity.nextKeepwarmTarget({ conversationId: 'legacy', windowId: 'w1' }).dueAtMs, Date.parse(at) + 50 * 60_000, '原排程不变');
  db.prepare("INSERT INTO conversation_activity(conversation_id,activity_revision,updated_at) VALUES ('written-by-old-shape',1,?)").run(at);
  assert.equal(activity.restState('written-by-old-shape').resting, false);

  const decided = '2026-10-23T21:00:00.000Z';
  assert.equal(activity.noteRestDecision('legacy', { kind: 'rest', source: 'owner_message', messageId: 'm-goodnight', atIso: decided }), true);
  assert.equal(activity.noteRestDecision('legacy', { kind: 'rest', source: 'owner_message', messageId: 'm-goodnight-again', atIso: '2026-10-23T21:05:00.000Z' }), false, '重复晚安不改首次决定');
  const row = activity.get('legacy')!;
  assert.deepEqual({ resting: row.resting, at: row.rest_decided_at, source: row.rest_source, message: row.rest_message_id }, { resting: 1, at: decided, source: 'owner_message', message: 'm-goodnight' });
  assert.deepEqual({ revision: row.activity_revision, anchor: row.last_real_activity_at }, { revision: 7, anchor: at }, '休息不是真实消息：锚点与活动版本都不动');
  assert.equal(activity.noteRestDecision('legacy', { kind: 'resume', source: 'owner_message', messageId: 'm-morning', atIso: '2026-10-24T01:00:00.000Z' }), true);
  assert.equal(activity.noteRestDecision('legacy', { kind: 'resume', source: 'owner_message', messageId: 'm-morning-2', atIso: '2026-10-24T01:01:00.000Z' }), false, '重复恢复是空操作');
  assert.deepEqual(activity.restState('legacy'), { resting: false, decided_at: '2026-10-24T01:00:00.000Z', source: 'owner_message' });

  // 界面恢复：同一操作键回放首次结果；不同键再次恢复不改动任何东西。
  assert.deepEqual(activity.resumeRest('legacy', { actorId: 'qiaosheng', operationId: 'ui-1' }), { resting: false, decided_at: '2026-10-24T01:00:00.000Z', source: 'owner_message', changed: false, duplicate: false });
  activity.noteRestDecision('legacy', { kind: 'rest', source: 'owner_message', messageId: 'm-goodnight-3', atIso: '2026-10-24T02:00:00.000Z' });
  const first = activity.resumeRest('legacy', { actorId: 'qiaosheng', operationId: 'ui-2' });
  assert.equal(first.changed, true);
  assert.equal(first.source, 'control');
  const anchorBefore = activity.get('legacy')!.last_real_activity_at;
  assert.deepEqual(activity.resumeRest('legacy', { actorId: 'qiaosheng', operationId: 'ui-2' }), { ...first, duplicate: true });
  assert.equal(activity.get('legacy')!.last_real_activity_at, anchorBefore, '界面操作不重设 50 分钟锚点');
  assert.equal(activity.resumeRest('nobody-resting', { actorId: 'qiaosheng', operationId: 'ui-3' }).changed, false);
});

test('T-A04：休息期间调度 tick 不领取心跳、不保留到期目标；资格门在读取牌组之前就结束；自主预约照常', async (t) => {
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
  const openHeartbeats = () => (db.prepare("SELECT COUNT(*) n FROM background_runs WHERE kind='keepwarm' AND state IN ('claimed','running','cancelling')").get() as { n: number }).n;
  const heartbeatRuns = () => (db.prepare("SELECT COUNT(*) n FROM background_runs WHERE kind='keepwarm'").get() as { n: number }).n;
  const shownDue = () => (db.prepare("SELECT next_due_at FROM background_tasks WHERE kind='keepwarm'").get() as { next_due_at: string | null }).next_due_at;
  await scheduler.tick();
  assert.deepEqual(executed, ['keepwarm'], '未休息时照常领取');
  const before = heartbeatRuns();

  // 21:40 她明确说睡：之后再过多少个 tick、过午夜、到 08:00，都不会自己恢复。
  assert.equal(activity.noteRestDecision('primary', { kind: 'rest', source: 'owner_message', messageId: 'm-goodnight', atIso: iso }), true);
  for (const [label, time] of [['21:45', '2026-10-23T21:45:00+08:00'], ['23:30', '2026-10-23T23:30:00+08:00'], ['00:10', '2026-10-24T00:10:00+08:00'], ['08:00', '2026-10-24T08:00:00+08:00']] as const) {
    now = Date.parse(time);
    // 即使领取前一刻还留着一个到期值，领取时也按当下状态拦住。
    db.prepare("UPDATE background_tasks SET next_due_at = ? WHERE kind = 'keepwarm'").run(new Date(now).toISOString());
    await scheduler.tick();
    assert.equal(activity.resting('primary'), true, label);
    assert.equal(heartbeatRuns(), before, `${label} 没有新的心跳执行`);
    assert.equal(shownDue(), null, `${label} 页面读不到可执行时间`);
  }

  // char说话不会解除；显式自主预约在同一时段照常执行。
  activity.noteRealPublication('primary', 'assistant-says-goodnight', 1, iso);
  assert.equal(activity.resting('primary'), true);
  now = Date.parse('2026-10-24T08:05:00+08:00');
  db.prepare("UPDATE background_tasks SET next_due_at = ? WHERE id = 'auto'").run(new Date(now).toISOString());
  await scheduler.tick();
  assert.deepEqual(executed, ['keepwarm', 'autonomous']);
  assert.equal(heartbeatRuns(), before);

  // 资格门在读取牌组之前就结束，所以抽卡轮和十张耗尽后的“回 1”走的是同一个门。
  activity.noteRealPublication('primary', 'm2', 1, new Date(now - 3_000_001).toISOString());
  assert.deepEqual(keepwarmDispatchGate({ db, activity, conversationId: 'primary', windowId: 'w-rest', inputActivityRevision: null, nowMs: now }), {
    decision: 'noop', resultCode: 'KEEPWARM_RESTING', detail: '乔乔已休息：等她明确回来或手动恢复' });

  // 她明确回来：按原真实活动和缓存资格重新计算，只领取一次，不补休息期间的机会。
  assert.equal(activity.noteRestDecision('primary', { kind: 'resume', source: 'owner_message', messageId: 'm-morning', atIso: iso }), true);
  await scheduler.tick();
  assert.deepEqual(executed, ['keepwarm', 'autonomous', 'keepwarm']);
  assert.equal(activity.resting('primary'), false);
});

test('T-A05/T-A06：休息只由她本人首次正式接受的输入建立——重复提交、编辑、模型回复不触发；语音条按已接受的转写判定', async (t) => {
  const { root, db } = database(t, 'rest-acceptance-');
  const activity = new ConversationActivityService(db);
  const messages = new MessageService(db, bindMessageLifecycle({ surfacing: null, activity, voiceObservations: null }), activity);
  const submit = (content: string, clientMessageId: string, attachments: Parameters<MessageService['submitUserMessageWithTurn']>[0]['attachments'] = []) =>
    messages.submitUserMessageWithTurn({ conversationId: 'primary', content, clientMessageId, attachments });

  const goodnight = submit('晚安，我睡了', 'm-goodnight');
  assert.equal(activity.restState('primary').resting, true, '接纳入口同事务建立休息');
  assert.equal(activity.get('primary')!.rest_message_id, goodnight.message.id);
  assert.deepEqual({ revision: activity.get('primary')!.activity_revision, duplicate: submit('晚安，我睡了', 'm-goodnight').duplicate }, { revision: 1, duplicate: true }, '重复提交不重复受理');
  assert.equal(activity.get('primary')!.rest_decided_at, activity.restState('primary').decided_at);

  messages.editUserMessage(goodnight.message.id, '我醒了');
  assert.equal(activity.restState('primary').resting, true, '编辑旧消息不改变休息');
  messages.publishAssistantMessage({ conversationId: 'primary', turnId: 'turn-assistant', content: '早安，我醒了' });
  assert.equal(activity.restState('primary').resting, true, '模型回复不解除休息');
  for (const [index, line] of ['爱你', '再抱一下', '晚安', '🌙'].entries()) submit(line, `m-followup-${index}`);
  assert.equal(activity.restState('primary').resting, true, '睡前补话、重复晚安和孤立表情不因“有新消息”而解除');
  assert.equal(activity.get('primary')!.activity_revision, 6, '这些仍是真实消息，照常推进活动版本');

  // 她说“还不睡”时并没有在休息；这句话也不会误建休息。
  assert.equal(detectRestIntent(submit('我还不睡，先聊一会', 'm-not-yet').message.revision.content), null);
  assert.equal(activity.restState('primary').resting, true);

  // 语音条：宿主只接受同字节的就绪转写，判定读的是这份已接受的文字。
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
  assert.equal(detectRestIntent((await voice('m-voice-noop')).message.revision.content), null, '没有转写的语音条不产生休息决定');
  await voice('m-voice-resume', '早安，我醒了');
  assert.equal(activity.restState('primary').resting, false, '语音里明确说醒来即恢复');
  await voice('m-voice-rest', '晚安');
  assert.deepEqual(activity.restState('primary'), { resting: true, decided_at: activity.get('primary')!.rest_decided_at, source: 'owner_message' });
  submit('我醒了', 'm-awake');
  assert.equal(activity.restState('primary').resting, false);
});
