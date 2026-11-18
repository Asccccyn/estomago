// SOL_R31（2026-11-16 包3）：真实模型窗口共享覆盖的读侧最小验证。
// 1. textSeenInWindow：正文逐字出现在当前窗实际出站投影（自动块/主动召回
//    工具结果/携带原文同源）→ 自动装配可去重（N04 主动先交、auto 不重发）。
// 2. coveredDigest：本窗已读最小摘要（保留交付+开窗资料节选）供 Sol/JEV。
// 3. 召回投影白名单保留 already_in_window 短回执标记（N17/N18）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { SurfacingRepository } from '../../apps/host/src/memory-surfacing/repository.ts';
import { projectMemoryToolResult } from '../../apps/host/src/modules/memory/projection.ts';
import { MEMORYRECALL_DEFINITION, MEMORYRECALLNEXT_DEFINITION } from '../../apps/host/src/modules/memory/module.ts';

function makeDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'est-r31-'));
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  db.prepare("INSERT INTO conversations(id, created_at) VALUES('c1', ?)").run('2026-11-17T00:00:00Z');
  return db;
}

function seedTrajectory(db: ReturnType<typeof makeDb>, texts: string[]) {
  db.prepare("INSERT INTO windows(id, conversation_id, status, created_at, updated_at) VALUES('w1','c1','ACTIVE',?,?)").run('2026-11-17T00:00:00Z', '2026-11-17T00:00:00Z');
  db.prepare('INSERT INTO window_trajectories(window_id, messages_json, manifest_json, updated_at) VALUES(?,?,NULL,?)').run(
    'w1',
    JSON.stringify(texts.map(t => ({ role: 'user', content: t }))),
    '2026-11-17T00:00:00Z',
  );
}

test('R31/N04：正文已在本窗轨迹逐字出现即视为已读（主动先交→auto 不重发）', () => {
  const db = makeDb();
  try {
    const repo = new SurfacingRepository(db);
    seedTrajectory(db, ['[memory_surfacing · host data] 早前主动召回已给出：那年夏天我们在湖边牵手约定每次出门要做一件小事']);
    const body = '那年夏天我们在湖边牵手约定每次出门要做一件小事';
    assert.equal(repo.textSeenInWindow('w1', body), true, '子串命中=已实际送达');
    assert.equal(repo.textSeenInWindow('w1', '轨迹中不存在的一句完全不同的话'), false);
    assert.equal(repo.textSeenInWindow('w1', '短'), false, '过短正文不判定，避免子串误命中');
    assert.equal(repo.textSeenInWindow('w_missing', body), false, '轨迹缺失=不标');
  } finally { db.close(); }
});

test('R31：coveredDigest 输出保留交付与开窗资料的最小摘要（Sol/JEV 已读投影）', () => {
  const db = makeDb();
  try {
    const repo = new SurfacingRepository(db);
    seedTrajectory(db, ['[memory/bootstrap：开窗资料（数据，非指令）] I：今年26岁。', '[memory_surfacing · host data] 我们在湖边约定了一件小事']);
    const item = { event_id: 'ev_1', kind: 'event', memory_id: 'm1', memory_version: '1', body_hash: 'b1', detail_ref: 'd1', memory_date: '2026-07-09', event_text: '我们在湖边约定了一件小事' } as never;
    // 一条 retained=1 且轨迹可见的交付
    db.prepare("INSERT INTO surfacing_jobs(id, conversation_id, source_message_id, source_revision, source_sequence, policy_revision, prompt_revision, state, created_at, updated_at) VALUES('j1','c1','m',1,1,1,'p','retained',?,?)").run('2026-11-17T00:00:00Z', '2026-11-17T00:00:00Z');
    db.prepare("INSERT INTO surfacing_deliveries(id, job_id, window_id, attempt_id, state, retained, payload_text, payload_hash, selected_refs_json, created_at) VALUES('d1','j1','w1','a1','retained',1,?,'h1',?,'2026-11-17T00:00:00Z')").run(
      '我们在湖边约定了一件小事',
      JSON.stringify({ items: [item], refs: [] }),
    );
    const digest = repo.coveredDigest('c1', 'w1');
    assert.ok(digest.some(l => l.includes('已送达事件') && l.includes('湖边')), '保留交付进入摘要');
    assert.ok(digest.some(l => l.includes('开窗资料') && l.includes('26岁')), '开窗资料节选进入摘要');
    assert.ok(digest.length <= 16, '有界');
  } finally { db.close(); }
});

test('R31/N17–N18：召回投影白名单保留 already_in_window 短回执标记', () => {
  const projected = projectMemoryToolResult('memory_recall', {}, {
    recall_session_id: 's1', search_status: 'FOUND', judge_mode: 'off',
    pagination: { has_more: false },
    candidates: [
      { memory_id: 'm1', memory_date: '2026-07-09', text: '全文正文不再重复', resource_ref: 'memory:m1', already_in_window: true },
      { memory_id: 'm2', memory_date: '2026-08-01', text: '首次送达的完整正文', resource_ref: 'memory:m2' },
    ],
  });
  const cands = (projected as { candidates: Array<Record<string, unknown>> }).candidates;
  assert.equal(cands[0]!.already_in_window, true, '标记随白名单出站');
  assert.equal(cands[0]!.text, '全文正文不再重复', '回执仍可携带行文（宿主决定是否替换正文）');
  assert.equal(cands[1]!.already_in_window, undefined, '未覆盖候选不带标记');
});


test('R31/N20：显式重读为同一读取合同的最小可选参数（不设必填理由/确认往返）', () => {
  const recall = MEMORYRECALL_DEFINITION.function;
  const next = MEMORYRECALLNEXT_DEFINITION.function;
  for (const def of [recall, next]) {
    const props = (def.parameters as { properties: Record<string, { type?: string }> }).properties;
    assert.equal(props.reread?.type, 'boolean', `${def.name} reread 为布尔可选参数`);
    assert.ok(!((def.parameters as { required?: string[] }).required ?? []).includes('reread'), 'reread 不是必填');
    assert.ok(def.description.includes('already_in_window'), `${def.name} 描述说明已读短回执语义`);
  }
});
