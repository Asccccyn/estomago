// P1 回忆意图门（她 2026-10-20 裁定）：纯函数矩阵 + 省略延续三态 + 真实接线。
//
// fixture 来源：Codex 联合审计 2026-10-20 evidence/trigger_fixture.json，字节原样
// vendor 到 tests/fixtures/surfacing-recall-gate.fixture.json（SHA256 在下方钉死）。
// **口径**：66 条全部是合成样本，标签由审计者预标、未经独立人工复核
// （label_source 字段）；这里的数字是"对该固定样本集的回归结果"，不是生产
// 准确率。防倒退负例由本批（程知行）标注，单列不混入原件。
// 规则按结构原则一次写定、跑一遍如实报，不按漏例反复改词表刷分。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { detectRecallNeed, extractExplicitDates, extractHypotheses, type RecentRecallState } from '../../apps/host/src/memory-surfacing/trigger.ts';
import { SurfacingService } from '../../apps/host/src/memory-surfacing/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { MariposaClient, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import {makeDb, tempRoot } from '../helpers.ts';

type Row = { id: string; category: string; text: string; recentRecall: boolean; expected: boolean; label_source: string };

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'surfacing-recall-gate.fixture.json');
const FIXTURE_SHA256 = 'c4c0e49ac6dcfd3b86f64d9e70ce8d410e9cb49d5313c2a093656d3097867c52';
const NOW = new Date('2026-10-20T12:00:00+08:00');     // 审计日；绝对日期过去/未来据此判
const BOUND: RecentRecallState = { boundLookup: { sourceMessageId: 'm0', sourceRevision: 1, sourceSequence: 1 } };
const UNBOUND: RecentRecallState = { boundLookup: null };

/** 模拟服务层两段式：fixture 的 recentRecall=true 视为"近期有已确定回忆对象的 lookup"。 */
function gate(text: string, recentRecall: boolean) {
  const first = detectRecallNeed(text, null, NOW);
  if (first.action !== 'needs_context') return first;
  return detectRecallNeed(text, recentRecall ? BOUND : UNBOUND, NOW);
}

const rows: Row[] = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

test('fixture 来源钉死：字节原样 vendor（SHA256）+ 36 正 / 30 负 + 标签口径为审计者预标', () => {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex'), FIXTURE_SHA256);
  assert.equal(rows.length, 66);
  assert.equal(rows.filter((r) => r.expected).length, 36);
  assert.equal(rows.filter((r) => !r.expected).length, 30);
  assert.ok(rows.every((r) => r.label_source.includes('NOT independently human reviewed')));
});

test('66 条矩阵：原 30 负例零误触；4 条漏句翻正；36 正例全部 lookup', () => {
  let TP = 0, FP = 0, FN = 0, TN = 0;
  const fn: string[] = []; const fp: string[] = [];
  const byId = new Map<string, ReturnType<typeof gate>>();
  for (const r of rows) {
    const got = gate(r.text, r.recentRecall);
    byId.set(r.id, got);
    const hit = got.action === 'lookup';
    if (hit && r.expected) TP++;
    else if (hit) { FP++; fp.push(`${r.id} ${r.text}`); }
    else if (r.expected) { FN++; fn.push(`${r.id} ${r.text}`); }
    else TN++;
  }
  console.log(`[recall-gate] TP=${TP} FP=${FP} FN=${FN} TN=${TN} precision=${(TP / (TP + FP)).toFixed(4)} recall=${(TP / (TP + FN)).toFixed(4)} (synthetic fixture, analyst prelabel)`);
  assert.deepEqual(fp, [], '原 30 条负例不得误触发');
  assert.deepEqual(fn, [], '36 条正例全部 lookup（审计 B/C 基线为 32）');
  // 她点名的 4 条漏句：具名断言，且必须是强信号（不是靠改 B 词表）
  for (const id of ['T007', 'T011', 'T025', 'T057']) {
    const got = byId.get(id)!;
    assert.equal(got.action, 'lookup', id);
    assert.equal(got.reason, 'explicit_history_question', id);
  }
  // T025 的过去指代来自绝对日期 2025-07-09（相对 NOW 为过去）
  assert.deepEqual(byId.get('T025')!.explicitDates, [{ year: 2025, month: 7, day: 9 }]);
  // "记得明天买牛奶" 不触发（无过去指代）；"明天还记得带去年的外套" 不触发（未来领句）
  assert.equal(byId.get('T043')!.action, 'skip');
  assert.equal(byId.get('T065')!.action, 'skip');
});

test('防倒退负例（本批标注，单列）：强信号放开后不得误触', () => {
  const guards = [
    '明天记得问他去年的事',            // 未来领句 + 过去宾语：是提醒不是回忆
    '下次记得带上去年买的那本书',      // 同上
    '去年的今天天气怎么样',            // 知识/天气问句，无回忆动词与过去事件谓词
    '以前的人冬天怎么取暖',            // 泛历史知识
    '历史上第一次世界大战是哪年',      // "第一次" 是历史词但非共同往事
    '2027年7月9日我们去哪',            // 未来日期
    '那件事你怎么看',                  // 无前文的看法征询，不是回忆
    '帮我记一下去年的开销总数',        // 写入/统计请求
    '明年今天我们会在哪',              // 未来
    '我去年就说过别这样',              // 陈述，无疑问
  ];
  const fired = guards.filter((t) => gate(t, false).action === 'lookup');
  assert.deepEqual(fired, []);
});

test('future event questions do not bypass the recall gate; mixed recall remains available', () => {
  for (const text of ['明年7.9的婚礼怎么安排？','明天那场婚礼在哪里？','下周项目怎么做？']) {
    assert.equal(gate(text, false).action, 'skip', text);
  }
  assert.equal(gate('明天去公园吧，还记得去年我们去海边的事吗？', false).action, 'lookup');
});

test('inherited dates use real date spans, including Chinese dates, never version numbers', () => {
  assert.equal(extractHypotheses('还记得v1.2发布吗，也是那次庆祝。')[1]!.inherited_date_span, null);
  const text = '二〇二六年七月九号图书馆夜读，也是山谷徒步。';
  const span = extractHypotheses(text)[1]!.inherited_date_span!;
  assert.equal([...text].slice(span.start_cp, span.end_cp).join(''), '二〇二六年七月九号');
});

test('省略表达三态：无状态 needs_context；近期有已确定回忆对象 → lookup；否则 skip', () => {
  for (const t of ['后来呢', '那次呢', '他当时怎么说', '为什么', '在哪里', '还有呢']) {
    assert.equal(detectRecallNeed(t, null, NOW).action, 'needs_context', t);
    const bound = detectRecallNeed(t, BOUND, NOW);
    assert.equal(bound.action, 'lookup', t);
    assert.equal(bound.reason, 'followup_bound');
    assert.deepEqual(bound.boundContext, BOUND.boundLookup);
    assert.equal(detectRecallNeed(t, UNBOUND, NOW).reason, 'followup_unbound', t);
  }
});

test('普通聊天零 I/O：非省略表达在第一段就定夺，永不返回 needs_context', () => {
  const needCtx = rows.filter((r) => detectRecallNeed(r.text, null, NOW).action === 'needs_context').map((r) => r.id);
  // 只有 followup 正例（T037–T042）与同文负例（T061–T063）需要近期状态
  assert.deepEqual(needCtx, ['T037', 'T038', 'T039', 'T040', 'T041', 'T042', 'T061', 'T062', 'T063']);
  assert.equal(detectRecallNeed('', null, NOW).reason, 'empty');
  assert.equal(detectRecallNeed('今天好累', null, NOW).reason, 'no_recall_signal');
  assert.equal(detectRecallNeed('不用回忆去年那件事了', null, NOW).reason, 'guard_negation');
});

test('日期提取与 M 侧 facts 同族：中文数字/年份/ISO/点分；字母前缀不作日期', () => {
  assert.deepEqual(extractExplicitDates('二〇二五年七月九号'), [{ year: 2025, month: 7, day: 9 }]);
  assert.deepEqual(extractExplicitDates('2026-07-08'), [{ year: 2026, month: 7, day: 8 }]);
  assert.deepEqual(extractExplicitDates('7.9记忆库做成了'), [{ year: null, month: 7, day: 9 }]);
  assert.deepEqual(extractExplicitDates('去年7月9日'), [{ year: null, month: 7, day: 9 }]);
  assert.deepEqual(extractExplicitDates('v1.2 发布那次'), []);
});

// ———————————————————————————————————————————————— 真实接线（SQLite + MessageService）

const T0 = '2026-10-20T09:00:00+08:00';

function compose(root: string) {
  const { db } = makeDb(root);
  const calls: string[] = [];
  const transport: MariposaTransport = async (cap) => {
    calls.push(cap);
    if (cap === 'memory.surfacing.prepare') return { ok: true, result: { status: 'prepared', candidate_snapshot_ref: 'sfr_1', selected_count: 1, reason_code: null } };
    return { ok: false, code: 'CAPABILITY_NOT_FOUND', httpStatus: 404 };
  };
  const svc = new SurfacingService(db, new MariposaClient({ transport }), {
    enabled: true, policy_revision: 1, prompt_prepare_revision: 'surface_prepare_v1',
    delivery_deadline_ms: 2000, max_added_tokens_per_turn: 4096, max_packet_bytes: 24576, worker_concurrency: 2,
  }, null);
  const messages = new MessageService(db, svc);
  messages.ensureConversation('c1');
  const jobsFor = (messageId: string) => (db.prepare('SELECT COUNT(*) n FROM surfacing_jobs WHERE source_message_id=?').get(messageId) as { n: number }).n;
  const archiveRows = () => (db.prepare("SELECT COUNT(*) n FROM outbox WHERE target='mariposa.archive'").get() as { n: number }).n;
  return { db, svc, messages, calls, jobsFor, archiveRows };
}

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('接线：flag 开 + 普通聊天 → 零浮现作业、零 Mariposa 调用；归档 outbox 照常落行', async () => {
  const ctx = compose(tempRoot('sfgate-skip-'));
  const u = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '今天好累', clientMessageId: 'n1', occurredAt: T0 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ctx.jobsFor(u.message.id), 0, '普通聊天不登记作业');
  assert.equal(ctx.calls.length, 0, '零 Mariposa 检索调用');
  assert.equal(ctx.archiveRows(), 1, '归档路径独立：outbox 有 mariposa.archive 行');
  await ctx.svc.stop();
  ctx.db.close();
});

test('接线：明确回忆 → 真实登记作业并进入既有 prepare 流程', async () => {
  const ctx = compose(tempRoot('sfgate-lookup-'));
  const u = ctx.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '还记得去年我们去海边的事吗', clientMessageId: 'r1', occurredAt: T0 });
  assert.equal(ctx.jobsFor(u.message.id), 1, '明确回忆登记作业');
  await waitUntil(() => ctx.calls.includes('memory.surfacing.prepare'));
  assert.equal(ctx.archiveRows(), 1);
  await ctx.svc.stop();
  ctx.db.close();
});

test('接线：省略表达只在近期有已确定回忆对象时延续；无前文/未命中不延续', async () => {
  // 无前文的"后来呢" → skip（读了近期状态，为空）
  const a = compose(tempRoot('sfgate-fu-none-'));
  const u0 = a.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '后来呢', clientMessageId: 'f0', occurredAt: T0 });
  assert.equal(a.jobsFor(u0.message.id), 0);
  await a.svc.stop(); a.db.close();

  // 前一轮明确回忆已 prepared → "后来呢" 延续（登记作业）；同时旧作业按原生命周期绑到本条
  const b = compose(tempRoot('sfgate-fu-bound-'));
  const u1 = b.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '还记得去年那件事吗', clientMessageId: 'f1', occurredAt: T0 });
  await waitUntil(() => b.svc.repo.jobByLogicalKey('c1', u1.message.id, 1, 1, 'surface_prepare_v1')?.state === 'prepared');
  const u2 = b.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '后来呢', clientMessageId: 'f2', occurredAt: T0 });
  assert.equal(b.jobsFor(u2.message.id), 1, '"后来呢" 延续为 lookup');
  assert.equal(b.svc.repo.jobByLogicalKey('c1', u1.message.id, 1, 1, 'surface_prepare_v1')?.target_message_id, u1.message.id, '旧作业只绑定自己的源消息，不漂移到本条');
  await b.svc.stop(); b.db.close();

  // 前一轮检索未命中（empty）→ "后来呢" 不延续
  const c = compose(tempRoot('sfgate-fu-empty-'));
  const v1 = c.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '还记得去年那件事吗', clientMessageId: 'g1', occurredAt: T0 });
  await waitUntil(() => c.svc.repo.jobByLogicalKey('c1', v1.message.id, 1, 1, 'surface_prepare_v1')?.state === 'prepared');
  const jid = c.svc.repo.jobByLogicalKey('c1', v1.message.id, 1, 1, 'surface_prepare_v1')!.id;
  assert.ok(c.svc.repo.transition(jid, ['prepared'], 'empty'));
  const v2 = c.messages.submitUserMessageWithTurn({ conversationId: 'c1', content: '后来呢', clientMessageId: 'g2', occurredAt: T0 });
  assert.equal(c.jobsFor(v2.message.id), 0, '未命中不延续');
  await c.svc.stop(); c.db.close();
});

// —— 2026-10-22 她反馈放宽（116 条生产判定全 no_recall_signal 的修正）——
test('宽召回（她 1022 反馈）：陈述式回忆与新词表变体触发 lookup；普通聊天仍不误触', () => {
  const now = new Date('2026-10-22T04:00:00.000Z');
  const hit = (t: string): void => {
    const r = detectRecallNeed(t, null, now);
    assert.equal(r.action, 'lookup', `应触发：${t}`);
  };
  const miss = (t: string): void => {
    const r = detectRecallNeed(t, null, now);
    assert.equal(r.action, 'skip', `不应触发：${t}`);
  };
  // 陈述式回忆（旧版被疑问标记硬门误杀）
  hit('我想起上次我们说的事了');
  hit('忽然想起那个晚上');
  hit('我又想起那时候的情形');
  // 新词表变体（那个/之前/前阵子/说起/提到/聊到/翻到）
  hit('你还记得那个电影吗');
  hit('他之前提过一个想法');
  hit('我们之前聊到的那个地方');
  hit('前几天你说的事情怎么样了');
  hit('我翻到了以前的照片');
  hit('跟你聊聊前阵子发生的事');
  // 新省略式（整句短问）
  const f = detectRecallNeed('后来怎么样', null, now);
  assert.equal(f.action, 'needs_context');
  // 普通聊天仍不触发（防误伤）
  miss('今天中午吃什么');
  miss('帮我记下明天下午三点开会');
  miss('记得吃药');
  miss('明天我们去公园吧');
  miss('这个东西怎么用');
  // 写入守卫原样
  miss('记下：上次说的那个地方');
});
