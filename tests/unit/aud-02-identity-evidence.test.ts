// AUD-02 回归：配置 capability_state=verified 不再是证据；关键观测缺失/不符必须阻断。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, makeDb, makePaths, writeApprovedIdentity, readyRuntimePatch, OBSERVED_SDK, seedProbes } from '../helpers.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';

function svcWith(root: string) {
  const config = buildConfig(readyRuntimePatch()); // 注意：capability_state 仍是 'verified'（历史字段）
  return new IdentityService(config, makePaths(root));
}
function patchManifest(root: string, fn: (m: Record<string, unknown>) => void): void {
  const file = path.join(root, 'config/identity-manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fn(m);
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
}

test('探针缺失：即使配置写 capability_state=verified 也必须 BLOCKED', () => {
  const root = tempRoot();
  writeApprovedIdentity(root, { seedProbes: false });
  const { db } = makeDb(root, { seed: false });
  const gate = svcWith(root).evaluateGate(db);
  assert.equal(gate.state, 'IDENTITY_BLOCKED');
  assert.ok(gate.reasons.some((r) => r.startsWith('probe_missing:system_prompt_explicit')));
  db.close();
});

test('探针版本陈旧（对另一 SDK 版本取证）→ BLOCKED', () => {
  const root = tempRoot();
  writeApprovedIdentity(root, { seedProbes: false });
  const { db } = makeDb(root, { seed: false });
  seedProbes(db, '0.0.0-ancient');
  const gate = svcWith(root).evaluateGate(db);
  assert.equal(gate.state, 'IDENTITY_BLOCKED');
  db.close();
});

test('探针 unsupported → BLOCKED（不是只有缺失才挡）', () => {
  const root = tempRoot();
  writeApprovedIdentity(root, { seedProbes: false });
  const { db } = makeDb(root, { seed: false });
  seedProbes(db, OBSERVED_SDK, 'unsupported');
  assert.equal(svcWith(root).evaluateGate(db).state, 'IDENTITY_BLOCKED');
  db.close();
});

test('settingSources 观测与配置不一致 → BLOCKED', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  patchManifest(root, (m) => { m.settings_sources = ['user']; });
  const { db } = makeDb(root);
  assert.equal(svcWith(root).evaluateGate(db).state, 'IDENTITY_BLOCKED');
  db.close();
});

test('SDK 版本三角（配置/manifest/实装）任一不符 → BLOCKED', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  patchManifest(root, (m) => { m.sdk_version = '9.9.9-other'; });
  const { db } = makeDb(root);
  const gate = svcWith(root).evaluateGate(db);
  assert.equal(gate.state, 'IDENTITY_BLOCKED');
  assert.ok(gate.reasons.some((r) => r.includes('与实装') || r.includes('另一版本')));
  db.close();
});

test('cwd 观测不符 → BLOCKED', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  patchManifest(root, (m) => { m.cwd_realpath = '/definitely/not/workspace'; });
  const { db } = makeDb(root);
  assert.equal(svcWith(root).evaluateGate(db).state, 'IDENTITY_BLOCKED');
  db.close();
});
