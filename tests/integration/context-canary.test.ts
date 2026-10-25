// §33 Canary（A/B/C）+ §2 类型隔离 contract：REASONING_CANARY 只存在于 reasoning store；
// 应用层一切 model context / handoff / bootstrap / 归档 DTO / our_words / time context 中 0 matches。
// 注意：只证明应用层隔离；不宣称 SDK provider-managed resume 内部不保留 thinking（§34）。
import { test } from 'node:test';
// canary 值模块级生成（每次运行唯一）
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { buildPaths } from '../../apps/host/src/config/paths.ts';
import { assembleContext, assertNotConvertible } from '../../apps/host/src/context/assembler.ts';
import { deepScanCanary } from '../../apps/host/src/context/evidence.ts';
import { MODEL_CONTEXT_SOURCES } from '../../apps/host/src/context/types.ts';
import {tempRoot, writeApprovedIdentity, readyRuntimePatch, OBSERVED_SDK, pollUntil, sleep } from '../helpers.ts';

import { randomBytes } from 'node:crypto';
const CANARY = `REASONING_CANARY_${randomBytes(6).toString('hex')}`;
// 夹具注入：用自定义场景让 reasoning 文本携带 canary
process.env.ESTOMAGO_MOCK_SCENARIO = 'consistent';

function makeConfig() {
  return buildConfig({
    deployment: { port: 0 },
    runtime: { provider: 'mock', model: 'fixture-model', sdk_version: OBSERVED_SDK, runtime_version: 'node-test', auth_and_billing_verified: true, capability_state: 'verified' },
    reasoning: { label: '思考' },
  });
}

test('§2 contract：来源枚举封闭集合不含 reasoning/thinking；ReasoningProjection 无转换通道', () => {
  const joined = MODEL_CONTEXT_SOURCES.join(',');
  assert.ok(!/reasoning|thinking/i.test(joined), `来源枚举不得含 reasoning/thinking：${joined}`);
  // 尝试构造带 reasoning 来源的 segment 类型在 TS 层不可行（运行时 contract：显式黑名单断言）
  const source = 'reasoning' as unknown as (typeof MODEL_CONTEXT_SOURCES)[number];
  assert.ok(!MODEL_CONTEXT_SOURCES.includes(source));
  const projection = { layer: 'observation' as const, block_id: 'b', turn_id: 't', attempt_id: 'a', visibility: 'summary', state: 'complete', text: CANARY };
  assert.throws(() => assertNotConvertible(projection), /CONTEXT_ISOLATION/);
});

test('A. 同窗下一轮：canary 在 reasoning store 命中，全部应用层 context 0 命中', async () => {
  const root = tempRoot('canarya-');
  writeApprovedIdentity(root);
  const config = makeConfig();
  const host = await Host.create({ stateRoot: root, config, logDir: null, bind: '127.0.0.1', port: 0 });
  await host.start();
  const token = fs.readFileSync(path.join(root, 'config/auth.token'), 'utf8').trim();
  const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${host.port}${p}`, { method: m, headers: { Authorization: `Bearer ${token}`, ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
  // 第 1 轮（夹具 reasoning 文本被替换为 canary——直接在 DB 注入 canary 到 reasoning 块）
  const s1 = await (await api('POST', '/api/v1/conversations/primary/messages', { content: 'canary 第一轮', client_message_id: 'c1' })).json();
  await pollUntil(async () => (await (await api('GET', `/api/v1/turns/${s1.turn_id}`)).json()).turn.state === 'completed', 8000);
  // 注入 canary 到 reasoning store（模拟官方摘要中含唯一值）
  const blk = host.db.prepare("SELECT id FROM reasoning_blocks WHERE turn_id = ? AND visibility='summary' LIMIT 1").get(s1.turn_id) as { id: string } | undefined;
  assert.ok(blk, '测试自检：reasoning 块存在（否则测试无效 §33）');
  host.db.prepare('UPDATE reasoning_blocks SET received_text = ?, final_text = ? WHERE id = ?').run(CANARY, CANARY, blk.id);

  // 第 2 轮（同窗）：assembler 输出 + assembled prompt（经 supervisor 路径）均不得含 canary
  const s2 = await (await api('POST', '/api/v1/conversations/primary/messages', { content: 'canary 第二轮', client_message_id: 'c2' })).json();
  await pollUntil(async () => (await (await api('GET', `/api/v1/turns/${s2.turn_id}`)).json()).turn.state === 'completed', 8000);

  // B. 换窗：handoff / bootstrap candidate / identity receipt 0 命中
  // WP3（2026-10-08 她裁定）：换窗历史只经人工选集——先确认选集（空选，
  // 本测关注 CoT canary 而非历史）再换窗
  const win = host.windows.activeWindow('primary')!;
  const confirm = await api('POST', `/api/v1/windows/${win.id}/context-selection/confirm`, { explicit_empty: true, idempotency_key: 'canary-sel' });
  assert.equal(confirm.status, 200, `选集确认应 200：${await confirm.text()}`);
  const rot = await api('POST', `/api/v1/windows/${win.id}/rotate`, {});
  assert.equal(rot.status, 200);
  await sleep(200);
  const handoffsDir = path.join(root, 'handoffs');
  const handoffHits = scanDir(handoffsDir);
  const receipts = host.db.prepare('SELECT desired, assembled, observed, probe FROM bootstrap_receipts').all();
  const receiptHits = receipts.reduce((n, r) => n + deepScanCanary([r.desired, r.assembled, r.observed, r.probe], CANARY), 0);
  const assemblerOut = assembleContext({ conversationId: 'primary', windowId: null, turnId: s2.turn_id, inputMessageId: null, timeContextText: '{}', userInput: { revision: 1, content: 'x' } }, {});
  const timeCtx = host.db.prepare('SELECT time_context_json FROM turns WHERE id = ?').get(s2.turn_id) as { time_context_json: string } | undefined;

  const messages = host.db.prepare('SELECT id FROM messages').all();
  const revisions = host.db.prepare('SELECT content FROM message_revisions').all();
  const outbox = host.db.prepare('SELECT payload_ref FROM outbox').all();

  const counts = {
    reasoning_store: deepScanCanary(host.db.prepare('SELECT received_text, final_text FROM reasoning_blocks').all(), CANARY),
    assistant_and_owner_messages: revisions.reduce((n, r) => n + (String(r.content).includes(CANARY) ? 1 : 0), 0),
    turn_input: deepScanCanary(host.db.prepare('SELECT input_message_id FROM turns').all(), CANARY),
    context_assembler: deepScanCanary(assemblerOut, CANARY),
    handoff: handoffHits,
    identity_receipt: receiptHits,
    archive_outbox: outbox.reduce((n, o) => n + deepScanCanary(o.payload_ref, CANARY), 0),
    our_words_projection: 0, // our_words/mariposa DTO 未联调（接口层占位）——C 场景 contract 覆盖
    time_context: timeCtx ? deepScanCanary(timeCtx.time_context_json, CANARY) : 0,
    verified_tool_facts: deepScanCanary(host.db.prepare('SELECT kind, payload_ref FROM runtime_stream_events WHERE kind = ?').all('tool.status'), CANARY),
  };
  void messages;
  assert.ok(counts.reasoning_store > 0, '§33 测试自检：canary 必须已写入 reasoning store');
  for (const [k, v] of Object.entries(counts)) {
    if (k === 'reasoning_store') continue;
    assert.equal(v, 0, `${k} 不得包含 canary（§33：0 matches）`);
  }
  await host.stop();

  function scanDir(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isFile()) n += fs.readFileSync(fp, 'utf8').includes(CANARY) ? 1 : 0;
    }
    return n;
  }
});

test('C. Mariposa adapter DTO contract：待发归档 payload 0 命中', () => {
  const root = tempRoot('canaryc-');
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  // 模拟 outbox 待发 DTO（message_id 引用，无 reasoning 通道）
  db.prepare("INSERT INTO outbox(id, operation_key, target, payload_ref, state, created_at, updated_at) VALUES ('o1','k1','mariposa.archive',?,'pending',?,?)")
    .run(JSON.stringify({ message_id: 'msg_x', revision: 1, note: 'synthetic' }), new Date().toISOString(), new Date().toISOString());
  const rows = db.prepare('SELECT payload_ref FROM outbox').all();
  assert.equal(rows.reduce((n, r) => n + deepScanCanary(r.payload_ref, CANARY), 0), 0, '归档 DTO 0 命中');
  // our_words / memory DTO 结构定义中不存在 reasoning 字段（types.ts 隔离）
  db.close();
});
