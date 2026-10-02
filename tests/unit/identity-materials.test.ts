// F04/F05 二轮回归：能力证据空引用/陈旧观测阻断；批准规则材料实际进入 systemPrompt；
// 同一份已验证材料（校验=装配）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempRoot, makeDb, makePaths, writeApprovedIdentity, readyRuntimePatch, seedProbes } from '../helpers.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { buildSdkOptions } from '../../apps/host/src/runtime/build-options.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import path from 'node:path';

test('探针 supported 但 evidence_ref 为空 → 阻断', () => {
  const root = tempRoot('f05a-');
  writeApprovedIdentity(root);
  const { db } = makeDb(root);
  seedProbes(db);
  db.prepare("UPDATE capability_probes SET evidence_ref = '' WHERE probe_key = 'interrupt_supported'").run();
  const { svc } = (() => { const config = buildConfig(readyRuntimePatch()); return { config, svc: new IdentityService(config, makePaths(root)) }; })();
  const gate = svc.evaluateGate(db);
  assert.equal(gate.state, 'IDENTITY_BLOCKED');
  assert.ok(gate.reasons.some((r) => r.startsWith('probe_evidence_missing:interrupt_supported')), `实际：${gate.reasons.join(' | ')}`);
  db.close();
});

test('探针观测陈旧（超出 probe_evidence_max_age_days）→ 阻断', () => {
  const root = tempRoot('f05b-');
  writeApprovedIdentity(root);
  const { db } = makeDb(root);
  seedProbes(db);
  db.prepare("UPDATE capability_probes SET observed_at = '2020-01-01T00:00:00Z' WHERE probe_key = 'thinking_delta_observed'").run();
  const config = buildConfig(readyRuntimePatch());
  const svc = new IdentityService(config, makePaths(root));
  const gate = svc.evaluateGate(db);
  assert.equal(gate.state, 'IDENTITY_BLOCKED');
  assert.ok(gate.reasons.some((r) => r.startsWith('probe_stale:thinking_delta_observed')), `实际：${gate.reasons.join(' | ')}`);
  // 策略显式关闭时间过期（null）→ 不再按陈旧阻断
  const config2 = buildConfig({ ...readyRuntimePatch(), identity: { ...readyRuntimePatch().identity, probe_evidence_max_age_days: null } });
  const svc2 = new IdentityService(config2, makePaths(root));
  assert.equal(svc2.evaluateGate(db).state, 'READY');
  db.close();
});

test('批准规则材料进入 systemPrompt；宿主边界保留；I 不注入（开窗包通道未批准）', () => {
  const root = tempRoot('f04c-');
  const { manifest } = writeApprovedIdentity(root);
  const { db } = makeDb(root);
  const config = buildConfig(readyRuntimePatch());
  const paths = makePaths(root);
  const svc = new IdentityService(config, paths);
  const gate = svc.evaluateGate(db);
  assert.equal(gate.state, 'READY');
  const materials = svc.loadVerifiedMaterials(gate.manifest!);
  assert.ok(materials, '材料装载成功');
  assert.equal(materials.rulesText, '（测试）运行规则合成内容');
  assert.equal(materials.identityText, '（测试）经批准身份正文——合成内容，非真实身份');
  assert.equal(materials.iStatus.includes('policy_unapproved'), true, 'I 留在开窗包通道');
  const built = buildSdkOptions({ config, gate, identityText: materials.identityText, approvedRulesText: materials.rulesText, cwd: paths.workspacesDir });
  assert.equal(built.status, 'ok');
  const prompt = (built.assembled as { options: { systemPrompt: string } }).options.systemPrompt;
  assert.ok(prompt.includes('（测试）运行规则合成内容'), '批准规则正文必须实际进入 systemPrompt');
  assert.ok(prompt.includes('运行边界（宿主注入）'), '宿主边界声明保留');
  assert.ok(!prompt.includes('（测试）I 快照合成内容'), 'I 材料不得注入 systemPrompt');
  // 装配缺规则正文 → 阻断（不允许硬编码替身）
  const blocked = buildSdkOptions({ config, gate, identityText: materials.identityText, approvedRulesText: null, cwd: paths.workspacesDir });
  assert.equal(blocked.status, 'blocked');
  db.close();
});

test('规则材料文件被篡改后 loadVerifiedMaterials 与装配一起失效（同一份字节）', async () => {
  const root = tempRoot('f04d-');
  writeApprovedIdentity(root);
  const { db } = makeDb(root);
  const config = buildConfig(readyRuntimePatch());
  const paths = makePaths(root);
  const svc = new IdentityService(config, paths);
  const fs = await import('node:fs');
  fs.default.appendFileSync(path.join(root, 'identity/runtime-rules.md'), '（篡改）');
  const gate = svc.evaluateGate(db);
  assert.equal(gate.state, 'IDENTITY_BLOCKED', 'hash 校验失败 → gate 阻断');
  const built = buildSdkOptions({ config, gate, identityText: 'x', approvedRulesText: 'y', cwd: paths.workspacesDir });
  assert.equal(built.status, 'blocked', 'gate 未 READY 时装配同样阻断');
  db.close();
});
