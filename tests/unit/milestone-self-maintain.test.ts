// 她授权+落位裁定 2026-10-17：char自维护《长期记忆里程碑》，放身份正文槽（approved_source）。
//  - 正文槽与 I 槽均不参与 contextFingerprint——里程碑/I 演进不动当前窗缓存，
//    下一新窗自动带新版（她裁定，同 §7.1 桶/I 中途修改口径）
//  - identity_milestone_write：新版新文件+旧版留档+manifest 原子更新+幂等+审计
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, makeDb, makePaths, writeApprovedIdentity, wireOidoCapabilitiesForTest } from '../helpers.ts';
import { IdentityService, contextFingerprint } from '../../apps/host/src/identity/service.ts';
import { HostToolExecutor } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';

/** 把夹具正文槽换成长期里程碑文件（她的落位裁定：里程碑=身份正文） */
function seedMilestone(root: string): void {
  const paths = makePaths(root);
  const text = '（测试）里程碑 v1 正文';
  fs.writeFileSync(path.join(paths.identityDir, 'longterm-milestones-v1.md'), text, { mode: 0o600 });
  const m = JSON.parse(fs.readFileSync(path.join(paths.configDir, 'identity-manifest.json'), 'utf8')) as Record<string, unknown>;
  m.approved_source_ref = 'longterm-milestones-v1.md';
  m.identity_version = 'longterm-milestones-v1';
  m.approved_source_hash = sha256Hex(text);
  fs.writeFileSync(path.join(paths.configDir, 'identity-manifest.json'), JSON.stringify(m, null, 2));
}

test('正文槽（里程碑）与 I 槽变化均不改指纹；规则槽变化仍改指纹（她 2026-10-17 裁定）', () => {
  const root = tempRoot('fp-i-');
  const { manifest } = writeApprovedIdentity(root, { seedProbes: false });
  const paths = makePaths(root);
  const cfg = { runtime: { provider: 'openrouter', sdk_version: null, model: null, setting_sources: [] as string[], builtin_tools: [] as string[], mcp_servers_allowlist: [] as string[] }, openrouter: { model: 'm', max_output_tokens: 1, provider_only: [] as string[], reasoning: null } };
  const base = contextFingerprint(cfg, manifest as never);
  const iChanged = { ...manifest, i_version: 'longterm-milestones-v2', i_hash: 'deadbeef' } as never;
  assert.equal(contextFingerprint(cfg, iChanged), base, 'I 槽演进不得触发 CONTEXT_STALE');
  const rulesChanged = { ...manifest, rules_hash: 'cafebabe' } as never;
  assert.notEqual(contextFingerprint(cfg, rulesChanged), base, '规则槽变化仍触发换窗');
  const identityChanged = { ...manifest, identity_version: 'longterm-milestones-v2', approved_source_hash: 'feedface' } as never;
  assert.equal(contextFingerprint(cfg, identityChanged), base, '正文槽（里程碑自维护）演进不得触发 CONTEXT_STALE');
});

test('updateMilestone：v1→v2 新文件+旧版留档+manifest 正文槽原子更新', () => {
  const root = tempRoot('ms-1-');
  writeApprovedIdentity(root, { seedProbes: false });
  seedMilestone(root);
  const paths = makePaths(root);
  const svc = new IdentityService(buildConfig({}), paths);
  const out = svc.updateMilestone('（测试）里程碑 v2 正文');
  assert.equal(out.version, 'longterm-milestones-v2');
  assert.equal(fs.existsSync(path.join(paths.identityDir, 'longterm-milestones-v1.md')), true, '旧版留档不删');
  assert.equal(fs.readFileSync(path.join(paths.identityDir, 'longterm-milestones-v2.md'), 'utf8'), '（测试）里程碑 v2 正文');
  const m = JSON.parse(fs.readFileSync(path.join(paths.configDir, 'identity-manifest.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(m.approved_source_ref, 'longterm-milestones-v2.md');
  assert.equal(m.approved_source_hash, out.hash);
  assert.equal(m.identity_version, 'longterm-milestones-v2');
});

test('updateMilestone：正文槽不是里程碑文件 → 拒绝（不动 manifest）', () => {
  const root = tempRoot('ms-2-');
  writeApprovedIdentity(root, { seedProbes: false });
  const paths = makePaths(root);
  const svc = new IdentityService(buildConfig({}), paths);
  assert.throws(() => svc.updateMilestone('x'), /IDENTITY_SLOT_NOT_MILESTONE/);
});

test('identity_milestone_write 工具：写入+审计+幂等（同键重试只写一版）', async () => {
  const root = tempRoot('ms-tool-');
  writeApprovedIdentity(root, { seedProbes: false });
  seedMilestone(root);
  const { db } = makeDb(root);
  const paths = makePaths(root);
  const svc = new IdentityService(buildConfig({}), paths);
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), identity: svc })
  wireOidoCapabilitiesForTest(tools, {  });;
  const ctx = { roomId: 'c1', windowId: null, turnId: 't1', purpose: 'chat' as const, activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: 'req-1' };
  const args = { text: '（测试）里程碑 v2 正文（工具写入）', change_reason: '补充 2026-10-17 的一天', idempotency_key: 'op-1' };
  const r1 = await tools.execute('identity_milestone_write', { ...args }, ctx);
  assert.equal(r1.ok, true);
  assert.equal((r1.output as { version: string }).version, 'longterm-milestones-v2');
  assert.equal((r1.output as { effective: string }).effective, 'next_window');
  // 审计行落库
  const aud = db.prepare("SELECT scope, result FROM audit_events WHERE what = 'identity_milestone_write'").all() as Array<{ scope: string; result: string }>;
  assert.equal(aud.length, 1);
  assert.equal(aud[0]!.scope, 'longterm-milestones-v2');
  assert.ok(aud[0]!.result.includes('补充 2026-10-17'));
  // 同幂等键重试：不写 v3，返回 duplicate
  const r2 = await tools.execute('identity_milestone_write', { ...args }, ctx);
  assert.equal(r2.ok, true);
  assert.equal((r2.output as { duplicate: boolean }).duplicate, true);
  assert.equal(fs.existsSync(path.join(paths.identityDir, 'longterm-milestones-v3.md')), false, '幂等重试不产生新版本');
  // 不同幂等键：写 v3
  const r3 = await tools.execute('identity_milestone_write', { ...args, idempotency_key: 'op-2' }, ctx);
  assert.equal((r3.output as { version: string }).version, 'longterm-milestones-v3');
  db.close();
});

test('工具 schema：缺 change_reason 拒绝（不产生副作用）', async () => {
  const root = tempRoot('ms-arg-');
  writeApprovedIdentity(root, { seedProbes: false });
  seedMilestone(root);
  const { db } = makeDb(root);
  const svc = new IdentityService(buildConfig({}), makePaths(root));
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), identity: svc })
  wireOidoCapabilitiesForTest(tools, {  });;
  const ctx = { roomId: 'c1', windowId: null, turnId: 't1', purpose: 'chat' as const, activeReviewId: null, seenSequence: 0, seenMessages: [], requestId: 'req-1' };
  const bad = await tools.execute('identity_milestone_write', { text: 'x', idempotency_key: 'k' }, ctx);
  assert.equal(bad.ok, false);
  const files = fs.readdirSync(makePaths(root).identityDir).filter((f) => f.startsWith('longterm-milestones'));
  assert.deepEqual(files, ['longterm-milestones-v1.md'], 'schema 拒绝不产生副作用');
  db.close();
});

// —— 2026-10-22 她要求：条目化——read/add/revise/remove ——

test('行级条目化（她 1022 裁定：一行一条 1.2.3.4.；新增=加一行；Claude 老版 project memory 式）', async () => {
  const root = tempRoot('ms-lines-');
  writeApprovedIdentity(root, { seedProbes: false });
  seedMilestone(root);
  const paths = makePaths(root);
  const db = makeDb(root).db;
  const tools = new HostToolExecutor({ db, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db), identity: new IdentityService(buildConfig({}), paths) })
  wireOidoCapabilitiesForTest(tools, {  });;
  const ctx = { roomId: 'c1', windowId: 'w1', turnId: 't1', purpose: 'chat' as const, activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'req-m' };
  // 初始版=生产 v1 形态：一行一条，无空行
  const w0 = await tools.execute('identity_milestone_write', { operation: 'write', text: '第一条：我们的开始\n第二条：海边的约定\n第三条：封号与重建，勿删', change_reason: '初始化', idempotency_key: 'e0' }, ctx);
  assert.equal(w0.ok, true);
  // read：一行一条带行号
  const r1 = await tools.execute('identity_milestone_write', { operation: 'read' }, ctx);
  assert.equal(r1.ok, true);
  const out1 = r1.output as { entries: number; text: string };
  assert.equal(out1.entries, 3);
  assert.equal(out1.text, '1. 第一条：我们的开始\n2. 第二条：海边的约定\n3. 第三条：封号与重建，勿删');
  // add：末尾加一行
  const a = await tools.execute('identity_milestone_write', { operation: 'add', text: '第四条：第一次自己定闹钟', change_reason: '新增', idempotency_key: 'e1' }, ctx);
  assert.equal(a.ok, true);
  assert.equal((a.output as { entries: number }).entries, 4);
  // revise item=2：只改那一行
  const v = await tools.execute('identity_milestone_write', { operation: 'revise', item: 2, text: '第二条：海边的约定（改期）', change_reason: '修订', idempotency_key: 'e2' }, ctx);
  assert.equal(v.ok, true);
  const r2 = await tools.execute('identity_milestone_write', { operation: 'read' }, ctx);
  const out2 = (r2.output as { text: string }).text;
  assert.equal(out2, '1. 第一条：我们的开始\n2. 第二条：海边的约定（改期）\n3. 第三条：封号与重建，勿删\n4. 第四条：第一次自己定闹钟');
  // remove item=1：删那一行，其余原样
  const rm = await tools.execute('identity_milestone_write', { operation: 'remove', item: 1, change_reason: '删一条', idempotency_key: 'e3' }, ctx);
  assert.equal(rm.ok, true);
  const r3 = await tools.execute('identity_milestone_write', { operation: 'read' }, ctx);
  assert.equal((r3.output as { text: string }).text, '1. 第二条：海边的约定（改期）\n2. 第三条：封号与重建，勿删\n3. 第四条：第一次自己定闹钟');
  // 越界拒绝；最后一条不可删
  const bad = await tools.execute('identity_milestone_write', { operation: 'revise', item: 9, text: 'x', change_reason: 'r', idempotency_key: 'e4' }, ctx);
  assert.equal(bad.ok, false);
  await tools.execute('identity_milestone_write', { operation: 'remove', item: 1, change_reason: 'r', idempotency_key: 'e5' }, ctx);
  await tools.execute('identity_milestone_write', { operation: 'remove', item: 1, change_reason: 'r', idempotency_key: 'e6' }, ctx);
  const lastDel = await tools.execute('identity_milestone_write', { operation: 'remove', item: 1, change_reason: 'r', idempotency_key: 'e7' }, ctx);
  assert.equal(lastDel.ok, false);
  // 原文文件=行数组原样（未动的行字节不动）：remove 批次 v5 仍含勿删行
  const fileText = fs.readFileSync(path.join(paths.identityDir, 'longterm-milestones-v5.md'), 'utf8');
  assert.ok(fileText.includes('第三条：封号与重建，勿删'), '未动的行原样保留');
  // 连删到一条后 LAST_ENTRY 拦截（v7=唯一剩行）
  assert.ok(fs.readFileSync(path.join(paths.identityDir, 'longterm-milestones-v7.md'), 'utf8').includes('第四条'), '删到剩最后一条');
  db.close();
});
