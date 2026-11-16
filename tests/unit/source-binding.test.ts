// 包2 批C（BIND，2026-11-16）：午夜来源绑定——隔离验证（mock GLM transport + 桩 M 客户端
// + 真实 SQLite/迁移）。覆盖：日界分批归属（上海 00:00；E 提交事实为准）、任务行幂等
// （UNIQUE(memory_id) 不重复入队）、GLM 无可靠匹配=合法终态不再重判、命中范围→同步
// 收据→M 绑定写入成功/重叠跳过/未同步待原文、凭据未配置=如实未启用、不唤醒（无任何
// 消息写入）。真实 GLM/付费调用未执行（BIND-09 待授权）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex, genId } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { GlmChatAdapter, type GlmChatTransport } from '../../apps/host/src/integrations/glm/chat.ts';
import { SourceBindingService } from '../../apps/host/src/modules/sourcebinding/service.ts';
import type { MariposaClient, MariposaCallResult } from '../../apps/host/src/integrations/mariposa/client.ts';

process.env.EST_TEST_GLM_KEY = 'test-glm-key';

let root: string;
let db: ReturnType<typeof openDatabase>;
type BindCall = { memoryId: string; members: Array<{ source_message_id: string; content_hash: string }> };
let bindCalls: BindCall[];
let bindResult: 'ok' | 'overlap' | 'transport_error';
let notFoundNext = false; // 下一次 sourceBindingBind 拒 NOT_FOUND（一次性）
let memoryGetResult: MariposaCallResult;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-sbind-'));
  db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  bindCalls = [];
  bindResult = 'ok';
  notFoundNext = false;
  memoryGetResult = { ok: true, result: { memory_id: 'mem_x', version: 3, original_title: '海边的对话', text: '我们聊了在海边看落日的事。' } };
});

after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.EST_TEST_GLM_KEY; });

function stubMariposa(): MariposaClient {
  return {
    withSignal: () => stubMariposa(),
    memoryGet: async () => memoryGetResult,
    sourceBindingBind: async (memoryId: string, sel: { conversation_id?: string; members: BindCall['members'] }) => {
      // 模拟真实 M 的会话解析（BIND-09 生产首批 27 条 NOT_FOUND 的教训）：conversation_id
      // 必须是收据的 source_conversation_id（种子='sc1'）；传 E 会话 id 一律 NOT_FOUND。
      if (sel.conversation_id !== 'sc1') return { ok: false, code: 'NOT_FOUND', httpStatus: 404 };
      if (notFoundNext) { notFoundNext = false; return { ok: false, code: 'NOT_FOUND', httpStatus: 404 }; }
      bindCalls.push({ memoryId, members: sel.members });
      if (bindResult === 'transport_error') throw new Error('connection reset');
      if (bindResult === 'overlap') return { ok: false, code: 'EVENT_SOURCE_OVERLAP', httpStatus: 409 };
      return { ok: true, result: { binding_id: 'bnd_' + bindCalls.length } };
    },
  } as unknown as MariposaClient;
}

/** 造一条已提交 hold 事实 + 会话消息（含 M 同步收据）。 */
function seedHoldAndConversation(memoryId: string, committedAt: string): { turnId: string; conversationId: string; msgIds: string[] } {
  const conversationId = 'conv_' + memoryId;
  const turnId = 'turn_' + memoryId;
  db.prepare("INSERT INTO conversations(id, title, created_at) VALUES (?,NULL,?)").run(conversationId, committedAt);
  db.prepare("INSERT INTO turns(id, conversation_id, state, trigger, input_message_id, created_at) VALUES (?,?,?,?,NULL,?)").run(turnId, conversationId, 'completed', 'user_input', committedAt);
  const msgIds: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const id = 'msg_' + memoryId + '_' + i;
    db.prepare("INSERT INTO messages(id, conversation_id, sequence, speaker, turn_id, kind, client_message_id, current_revision, published_at, created_at) VALUES (?,?,?,?,?,'text',NULL,1,?,?)")
      .run(id, conversationId, i, i === 2 ? 'assistant' : 'owner', turnId, committedAt, committedAt);
    const content = i === 2 ? '我把落日的照片发给你了' : `第${i}句：海边的风好大`;
    db.prepare("INSERT INTO message_revisions(message_id, revision, kind, content, content_hash, occurred_at, received_at, source) VALUES (?,1,'text',?,?,?,?,'user_input')")
      .run(id, content, sha256Hex(content), committedAt, committedAt);
    msgIds.push(id);
  }
  // hold 回合输入锚 = sequence 3（±30 覆盖全部）
  db.prepare('UPDATE turns SET input_message_id = ? WHERE id = ?').run(msgIds[2], turnId);
  // M 同步收据（members 身份源）
  for (const id of msgIds) {
    db.prepare('INSERT INTO source_sync_receipts(id, origin_message_id, revision, source_message_id, source_conversation_id, content_hash, operation_id, committed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(genId('ssr'), id, 1, 'sm_' + id, 'sc1', sha256Hex(id), 'op_sync_' + memoryId, 'acked', committedAt);
  }
  db.prepare("INSERT INTO tool_side_effects(id, review_id, turn_id, window_id, kind, state, verified, memory_id, operation_id, tool_call_id, seen_sequence, created_at, updated_at) VALUES (?,?,?,NULL,'hold','committed',1,?,?,?,0,?,?)")
    .run(genId('tse'), null, turnId, memoryId, 'op_' + memoryId, 'call_' + memoryId, committedAt, committedAt);
  return { turnId, conversationId, msgIds };
}

function makeService(glmTransport: GlmChatTransport): SourceBindingService {
  const glm = new GlmChatAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_GLM_KEY', model: 'glm-test', transport: glmTransport });
  const config = buildConfig({ source_binding: { enabled: true, api_key_env: 'EST_TEST_GLM_KEY', base_url: 'http://synthetic', model: 'glm-test', max_batch: 10, max_candidates: 60 } });
  return new SourceBindingService({ db, config, mariposa: stubMariposa(), glm, log: () => {} });
}

test('BIND-02/03: 日界分批——截止点前的提交入批、点后不入；任务行幂等不重复入队', async () => {
  const boundary = SourceBindingService.lastBoundary();
  seedHoldAndConversation('mem_a', new Date(new Date(boundary).getTime() - 3600_000).toISOString()); // 边界前 1h
  seedHoldAndConversation('mem_b', new Date(new Date(boundary).getTime() + 3600_000).toISOString()); // 边界后（不入本批）
  const glm: GlmChatTransport = async () => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify({ match: false, reason: '候选与记忆无对应' }) } }] } });
  const svc = makeService(glm);
  const report = await svc.runBatch();
  assert.equal(report.scope, 'est_tool_holds', '范围如实=E 工具路径');
  assert.equal(report.collected, 1, '只收集边界前提交（mem_b 归下一批）');
  assert.equal(report.counts['no_match'], 1, '无可靠匹配=合法终态');
  // 重跑：无新事实、pending 空——幂等（GLM 不再被调用）
  const report2 = await svc.runBatch();
  assert.equal(report2.collected, 0);
  assert.equal(report2.processed, 0);
});

test('BIND-04/05: 命中范围→真实消息→同步收据→M source.binding.bind 写入；GLM 引用不存在 id 拒绝', async () => {
  const seed = seedHoldAndConversation('mem_c', new Date(new Date(SourceBindingService.lastBoundary()).getTime() - 7200_000).toISOString());
  const okGlm: GlmChatTransport = async (body) => {
    const text = JSON.stringify((body as { messages: Array<{ content: string }> }).messages[0]!.content);
    assert.ok(text.includes('海边的对话'), 'GLM 输入含记忆正文');
    assert.ok(text.includes('第1句'), 'GLM 输入含候选原文节选');
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify({ match: true, ranges: [{ start: seed.msgIds[0], end: seed.msgIds[3], basis: '海边落日对话的起止' }], confidence: 'high' }) } }] } };
  };
  const svc = makeService(okGlm);
  await svc.runBatch();
  assert.equal(bindCalls.length, 1, '恰一次绑定写入');
  assert.equal(bindCalls[0]!.memoryId, 'mem_c');
  assert.equal(bindCalls[0]!.members.length, 4, '范围含首尾之间全部双方消息（整段路径）');
  const job = db.prepare("SELECT * FROM source_bind_jobs WHERE memory_id='mem_c'").get() as { status: string; memory_version: number | null; binding_ids_json: string | null; detail: string | null };
  assert.equal(job.status, 'bound');
  assert.equal(job.memory_version, 3, '判断时版本落行');
  assert.ok(job.binding_ids_json, '绑定 id 回执留存');
  assert.ok((job.detail ?? '').includes('后台任务'), '自动来源可识别为后台任务建立');

  // 引用不存在 id → 拒绝写入（不把模型幻觉当范围）
  bindCalls = [];
  seedHoldAndConversation('mem_d', new Date(new Date(SourceBindingService.lastBoundary()).getTime() - 7200_000).toISOString());
  const hallucinateGlm = JSON.stringify({ match: true, ranges: [{ start: 'msg_fake', end: 'msg_fake2', basis: 'x' }] });
  const hallucinate: GlmChatTransport = async () => ({ status: 200, json: { choices: [{ message: { content: hallucinateGlm } }] } });
  await makeService(hallucinate).runBatch();
  assert.equal(bindCalls.length, 0, '幻觉 id 不产生绑定写入');
  const jobD = db.prepare("SELECT status FROM source_bind_jobs WHERE memory_id='mem_d'").get() as { status: string };
  assert.equal(jobD.status, 'failed', '如失败可重试态');
});

test('BIND-03/05: 人工已绑（OVERLAP）跳过不覆盖；绑定传输失败如实 failed 不盲重发', async () => {
  seedHoldAndConversation('mem_e', new Date(new Date(SourceBindingService.lastBoundary()).getTime() - 7200_000).toISOString());
  const glm: GlmChatTransport = async () => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify({ match: true, ranges: [{ start: 'msg_mem_e_1', end: 'msg_mem_e_2', basis: 'x' }], confidence: 'low' }) } }] } });
  bindResult = 'overlap';
  await makeService(glm).runBatch();
  let job = db.prepare("SELECT status, detail FROM source_bind_jobs WHERE memory_id='mem_e'").get() as { status: string; detail: string | null };
  assert.equal(job.status, 'skipped_existing', '已有人工绑定跳过');
  assert.ok((job.detail ?? '').includes('跳过'));
  bindResult = 'transport_error';
  seedHoldAndConversation('mem_f', new Date(new Date(SourceBindingService.lastBoundary()).getTime() - 7200_000).toISOString());
  await makeService(glm).runBatch();
  job = db.prepare("SELECT status FROM source_bind_jobs WHERE memory_id='mem_f'").get() as { status: string };
  assert.equal(job.status, 'failed', '结果未知不盲重发，留下批核对');
});

test('BIND-07: 未启用/GLM 凭据缺失=如实未启用，零调用', async () => {
  seedHoldAndConversation('mem_g', new Date(new Date(SourceBindingService.lastBoundary()).getTime() - 7200_000).toISOString());
  const config = buildConfig({ source_binding: { enabled: true, api_key_env: 'EST_TEST_GLM_MISSING', base_url: 'http://synthetic', model: 'glm-test', max_batch: 10, max_candidates: 60 } });
  const glm = new GlmChatAdapter({ baseUrl: 'http://synthetic', apiKeyEnv: 'EST_TEST_GLM_MISSING', model: 'glm-test', transport: async () => { throw new Error('不应调用'); } });
  const svc = new SourceBindingService({ db, config, mariposa: stubMariposa(), glm, log: () => {} });
  assert.equal(svc.enabled, false);
  const report = await svc.runBatch();
  assert.deepEqual(report.skipped, ['glm_not_configured']);
  assert.equal(report.processed, 0);
  assert.equal(svc.dueNow(), false, '未启用不 due');
});

test('BIND-06: 全程零聊天消息写入（不唤醒、不发气泡）', async () => {
  const before = (db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;
  const glm: GlmChatTransport = async () => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify({ match: false, reason: 'x' }) } }] } });
  seedHoldAndConversation('mem_h', new Date(new Date(SourceBindingService.lastBoundary()).getTime() - 7200_000).toISOString());
  await makeService(glm).runBatch();
  const after = (db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;
  assert.equal(after - before, 4, '只有夹具消息，任务零写入');
});


test('BIND-03/B03: failed 可重试态在后续批次自动重取收口；达上限停止并如实标注', async () => {
  bindResult = 'ok'; notFoundNext = false; // 隔离前序测试遗留状态
  db.prepare('DELETE FROM source_bind_jobs').run(); db.prepare("DELETE FROM tool_side_effects WHERE kind='hold'").run(); // 隔离：任务行+hold 事实同清（只清 jobs 会让 runBatch 重新收集前序 hold）
  const seed = seedHoldAndConversation('mem_retry', new Date(new Date(SourceBindingService.lastBoundary()).getTime() - 7200_000).toISOString());
  const glm: GlmChatTransport = async () => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify({ match: true, ranges: [{ start: seed.msgIds[0], end: seed.msgIds[3], basis: 'x' }], confidence: 'high' }) } }] } });
  notFoundNext = true;
  await makeService(glm).runBatch();
  let job = db.prepare("SELECT status, attempts FROM source_bind_jobs WHERE memory_id='mem_retry'").get() as { status: string; attempts: number };
  assert.equal(job.status, 'failed', '首次写入被拒=failed 留痕');
  bindResult = 'ok';
  notFoundNext = false;
  await makeService(glm).runBatch();
  job = db.prepare("SELECT status, attempts, binding_ids_json FROM source_bind_jobs WHERE memory_id='mem_retry'").get() as { status: string; attempts: number; binding_ids_json: string | null };
  assert.equal(job.status, 'bound', 'failed 在后续批次被自动重取并收口');
  assert.ok(job.binding_ids_json, '绑定回执留存');
  // 达上限的 failed 不再重取（attempts 冻结、零判断调用、历史 detail 不改写）
  seedHoldAndConversation('mem_cap', new Date(new Date(SourceBindingService.lastBoundary()).getTime() - 7200_000).toISOString());
  notFoundNext = true;
  await makeService(glm).runBatch(); // 收集入行：首次写入被拒 → failed attempts=1
  db.prepare("UPDATE source_bind_jobs SET status='failed', attempts=4, detail='旧失败' WHERE memory_id='mem_cap'").run();
  const glmCalls: number[] = [];
  const glmCount: GlmChatTransport = async () => { glmCalls.push(1); return { status: 200, json: { choices: [{ message: { content: JSON.stringify({ match: false, reason: 'x' }) } }] } }; };
  await makeService(glmCount).runBatch();
  const capped = db.prepare("SELECT status, attempts, detail FROM source_bind_jobs WHERE memory_id='mem_cap'").get() as { status: string; attempts: number; detail: string };
  assert.equal(capped.status, 'failed');
  assert.equal(capped.attempts, 4, '达上限不再重取（attempts 冻结）');
  assert.equal(glmCalls.length, 0, '不再产生判断调用（不无限付费）');
  assert.equal(capped.detail, '旧失败', '历史 detail 不被改写');
  // 上限内的 failed 重试到上限后如实标注停止
  seedHoldAndConversation('mem_cap2', new Date(new Date(SourceBindingService.lastBoundary()).getTime() - 7200_000).toISOString());
  notFoundNext = true;
  await makeService(glm).runBatch(); // 收集入行 → failed attempts=1
  db.prepare("UPDATE source_bind_jobs SET status='failed', attempts=3, detail='绑定写入失败（X）——下批重试' WHERE memory_id='mem_cap2'").run();
  bindResult = 'ok';
  notFoundNext = true; // 本次重试的写入被拒 → attempts=4 达上限
  await makeService(glm).runBatch();
  const cap2 = db.prepare("SELECT status, attempts, detail FROM source_bind_jobs WHERE memory_id='mem_cap2'").get() as { status: string; attempts: number; detail: string };
  assert.equal(cap2.attempts, 4, '第 4 次尝试后冻结');
  assert.match(cap2.detail, /停止自动重试/, '达上限如实标注');
});
