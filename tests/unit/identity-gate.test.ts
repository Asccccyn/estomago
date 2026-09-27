import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRoot, makePaths, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { IdentityService } from '../../apps/host/src/identity/service.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';

function service(root: string, extraPatch: Record<string, unknown> = {}) {
  const config = buildConfig(extraPatch);
  return new IdentityService(config, makePaths(root));
}

test('无 manifest → IDENTITY_BLOCKED，且不提供默认人格', () => {
  const s = service(tempRoot(), readyRuntimePatch());
  const gate = s.evaluateGate();
  assert.equal(gate.state, 'IDENTITY_BLOCKED');
  assert.ok(gate.reasons.some((r) => r.includes('manifest')));
  assert.equal(gate.manifest, null);
});

test('模板 manifest（TEMPLATE_NOT_LOADED）→ 阻断', () => {
  const root = tempRoot();
  const paths = makePaths(root);
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.copyFileSync(path.resolve(import.meta.dirname, '../../config/identity-manifest.example.json'), path.join(paths.configDir, 'identity-manifest.json'));
  const gate = service(root, readyRuntimePatch()).evaluateGate();
  assert.equal(gate.state, 'IDENTITY_BLOCKED');
  assert.ok(gate.reasons.some((r) => r.includes('TEMPLATE_NOT_LOADED')));
});

test('APPROVED + hash 匹配 + 运行前提齐备 → READY', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  const gate = service(root, readyRuntimePatch()).evaluateGate();
  assert.deepEqual(gate.reasons, []);
  assert.equal(gate.state, 'READY');
  assert.equal(gate.manifest!.identity_version, 'test-v1');
});

test('hash 不符 → 阻断（拒绝装载，不降级用缓存）', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  const paths = makePaths(root);
  fs.appendFileSync(path.join(paths.identityDir, 'approved-identity.md'), '被篡改的内容');
  const gate = service(root, readyRuntimePatch()).evaluateGate();
  assert.equal(gate.state, 'IDENTITY_BLOCKED');
  assert.ok(gate.reasons.some((r) => r.includes('hash 不符')));
});

test('现场未核实项（模型/SDK版本/计费）逐一阻断', () => {
  const root = tempRoot();
  writeApprovedIdentity(root);
  const gate = service(root, { runtime: { auth_and_billing_verified: false } }).evaluateGate();
  assert.equal(gate.state, 'IDENTITY_BLOCKED');
  assert.ok(gate.reasons.some((r) => r.includes('runtime.model')));
  assert.ok(gate.reasons.some((r) => r.includes('sdk_version')));
  assert.ok(gate.reasons.some((r) => r.includes('auth_and_billing_verified')));
});
