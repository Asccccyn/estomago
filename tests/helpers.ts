// 测试公共工具：所有测试只用独立临时 ESTOMAGO_HOME（02 §7），不碰生产根、不连真实服务。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../apps/host/src/db/connection.ts';
import { migrate } from '../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../apps/host/src/util/id.ts';
import { buildPaths } from '../apps/host/src/config/paths.ts';

process.env.ESTOMAGO_TEST_MODE = '1'; // mock runner 只在测试模式可用

export function tempRoot(prefix = 'estomago-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeDb(root = tempRoot()): { db: Db; root: string } {
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  return { db, root };
}

export function makePaths(root = tempRoot()) {
  return buildPaths(root);
}

export async function pollUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000, intervalMs = 25): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('pollUntil 超时');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function writeApprovedIdentity(root: string): { manifest: Record<string, unknown>; identityText: string } {
  const paths = buildPaths(root);
  fs.mkdirSync(paths.identityDir, { recursive: true });
  const identityText = '（测试）经批准身份正文——合成内容，非真实身份';
  fs.writeFileSync(path.join(paths.identityDir, 'approved-identity.md'), identityText);
  const manifest = {
    display_name: 'estómago',
    spec_version: '0.2.1',
    status: 'APPROVED',
    identity_version: 'test-v1',
    approved_source_ref: 'approved-identity.md',
    approved_source_hash: sha256Hex(identityText),
    i_version: 'test-i-1',
    runtime_rules_version: 'test-rules-1',
    system_prompt_mode: 'explicit_custom',
    system_prompt_hash: sha256Hex(identityText),
    sdk_version: '0.0.0-test',
    runtime_version: 'node-test',
    cwd_realpath: paths.workspacesDir,
    settings_sources: [],
    effective_model: 'fixture-model',
    effective_tools: [],
    effective_mcp_servers: [],
    managed_policy_summary: null,
    verification_evidence: [],
    requested_builtin_tools: [],
    requested_settings_sources: [],
    bootstrap_receipt_ref: null,
  };
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(path.join(paths.configDir, 'identity-manifest.json'), JSON.stringify(manifest, null, 2));
  return { manifest, identityText };
}

export function readyRuntimePatch(): Record<string, unknown> {
  return {
    runtime: {
      model: 'fixture-model',
      sdk_version: '0.0.0-test',
      runtime_version: 'node-test',
      auth_and_billing_verified: true,
      capability_state: 'verified',
    },
  };
}
