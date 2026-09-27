import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, makeDb, makePaths, writeApprovedIdentity, readyRuntimePatch, OBSERVED_SDK, seedProbes } from '../helpers.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';

function service(root: string, extraPatch: Record<string, unknown> = {}) {
  const config = buildConfig(extraPatch);
  return { config, svc: new IdentityService(config, makePaths(root)) };
}

test('无 manifest → IDENTITY_BLOCKED，且不提供默认人格', () => {
  const root = tempRoot();
  const { svc } = service(root, readyRuntimePatch());
  const { db } = makeDb(undefined, { seed: false }); // manifest 是本例焦点；探针另行控制
  const gate = svc.evaluateGate(db);
  assert.equal(gate.state, 'IDENTITY_BLOCKED');
  assert.ok(gate.reasons.some((r) => r.includes('manifest')));
  assert.equal(gate.manifest, null);
  db.close();
});

test('模板 manifest（TEMPLATE_NOT_LOADED）→ 阻断', () => {
  const root = tempRoot();
  const paths = makePaths(root);
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.copyFileSync(path.resolve(import.meta.dirname, '../../config/identity-manifest.example.json'), path.join(paths.configDir, 'identity-manifest.json'));
  const { db } = makeDb();
  const { svc } = service(root, readyRuntimePatch());
  assert.equal(svc.evaluateGate(db).state, 'IDENTITY_BLOCKED');
  db.close();
});

test('APPROVED + hash 匹配 + 实装版本一致 + 探针证据 → READY', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  const { db } = makeDb(root === '' ? undefined : undefined); // gate 用已播种 db
  seedProbes(db);
  const { svc } = service(root, readyRuntimePatch());
  const gate = svc.evaluateGate(db);
  assert.deepEqual(gate.reasons, []);
  assert.equal(gate.state, 'READY');
  db.close();
});

test('hash 篡改 → 阻断（拒绝装载，不降级）', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  fs.appendFileSync(path.join(root, 'identity/approved-identity.md'), '被篡改');
  const { db } = makeDb();
  seedProbes(db);
  const { svc } = service(root, readyRuntimePatch());
  assert.equal(svc.evaluateGate(db).state, 'IDENTITY_BLOCKED');
  db.close();
});

test('观测证据缺失/陈旧即阻断（AUD-02：配置 verified 不再是证据）', () => {
  const root = tempRoot();
  writeApprovedIdentity(root, { seedProbes: false });
  const { db } = makeDb(root, { seed: false });
  // 注意：此 db 未播种探针 → READY 不可能
  const { svc } = service(root, readyRuntimePatch());
  const gate = svc.evaluateGate(db);
  assert.equal(gate.state, 'IDENTITY_BLOCKED');
  assert.ok(gate.reasons.some((r) => r.startsWith('probe_missing:')));
  // 补种旧版本探针（版本不匹配）→ 仍阻断
  seedProbes(db, '0.0.0-old');
  const gate2 = svc.evaluateGate(db);
  assert.equal(gate2.state, 'IDENTITY_BLOCKED');
  assert.ok(gate2.reasons.some((r) => r.startsWith('probe_missing:')));
  db.close();
});

test('i_version / rules_version / manifest SDK 版本 / cwd 任一不符 → 阻断', () => {
  const root = tempRoot();
  const { manifest } = writeApprovedIdentity(root);
  const { db } = makeDb(root);
  const { svc } = service(root, readyRuntimePatch());
  assert.equal(svc.evaluateGate(db).state, 'READY'); // 基线 READY
  const file = path.join(root, 'config/identity-manifest.json');
  const patch = (fn: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fn(m);
    fs.writeFileSync(file, JSON.stringify(m, null, 2));
  };
  patch((m) => { m.i_version = 'WRONG'; });
  assert.equal(svc.evaluateGate(db).state, 'IDENTITY_BLOCKED', 'i_version 错误必须阻断');
  patch((m) => { m.i_version = manifest.i_version; m.runtime_rules_version = null; });
  assert.equal(svc.evaluateGate(db).state, 'IDENTITY_BLOCKED', 'rules 版本缺失必须阻断');
  patch((m) => { m.runtime_rules_version = manifest.runtime_rules_version; m.sdk_version = '0.0.0-mismatch'; });
  assert.equal(svc.evaluateGate(db).state, 'IDENTITY_BLOCKED', 'manifest SDK 版本与实装不符必须阻断');
  patch((m) => { m.sdk_version = OBSERVED_SDK; m.cwd_realpath = '/not/the/workspace'; });
  assert.equal(svc.evaluateGate(db).state, 'IDENTITY_BLOCKED', 'cwd 不符必须阻断');
  db.close();
});
