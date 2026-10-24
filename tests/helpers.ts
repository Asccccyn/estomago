// 测试公共工具 v0.2.2：隔离临时根；writeReadyIdentity 现在同时播种 capability_probes
//（证据绑定实装 SDK 版本——gate 逻辑测试用；生产探针只能由 scripts/probe-capabilities.mjs 写入）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../apps/host/src/db/connection.ts';
import { migrate } from '../apps/host/src/db/migrations.ts';
import { sha256Hex, genId } from '../apps/host/src/util/id.ts';
import { buildPaths } from '../apps/host/src/config/paths.ts';
import { CapabilityRegistry } from '../apps/host/src/capabilities/registry.ts';
import { registerOidoCapabilities } from '../apps/host/src/modules/oido/module.ts';
import { OidoSourceRepository } from '../apps/host/src/modules/oido/source-repository.ts';
import { registerVoiceCapabilities } from '../apps/host/src/modules/voice/module.ts';
import { registerConversationCapabilities } from '../apps/host/src/modules/conversation/module.ts';
import { defaultObservedSdkVersion, REQUIRED_PROBES } from '../apps/host/src/identity/service.ts';

process.env.ESTOMAGO_TEST_MODE = '1';

export const OBSERVED_SDK = defaultObservedSdkVersion(); // 测试环境实装版本（与 gate 观测一致）

export function tempRoot(prefix = 'estomago-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeDb(root = tempRoot(), opts: { seed?: boolean } = {}): { db: Db; root: string } {
  const db = openDatabase(path.join(root, 'data'));
  migrate(db, sha256Hex);
  if (opts.seed !== false) seedProbes(db);
  return { db, root };
}

export function makePaths(root = tempRoot()) {
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  return buildPaths(root);
}

// 播种能力探针证据（供 gate 逻辑单元测试；生产侧仅 probe 脚本可写）
export function seedProbes(db: Db, sdkVersion: string = OBSERVED_SDK, state = 'supported'): void {
  for (const key of REQUIRED_PROBES) {
    db.prepare(
      `INSERT INTO capability_probes(id, probe_key, state, sdk_version, evidence_ref, observed_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(probe_key, sdk_version) DO UPDATE SET state = excluded.state`,
    ).run(genId('prb'), key, state, sdkVersion, 'test-seeded', new Date().toISOString());
  }
}

export async function pollUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000, intervalMs = 25): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('pollUntil 超时');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function writeApprovedIdentity(root: string, opts: { sdkVersion?: string; probeState?: string; seedProbes?: boolean } = {}): { manifest: Record<string, unknown>; identityText: string } {
  const paths = buildPaths(root);
  fs.mkdirSync(paths.identityDir, { recursive: true });
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(paths.workspacesDir, { recursive: true });
  const identityText = '（测试）经批准身份正文——合成内容，非真实身份';
  fs.writeFileSync(path.join(paths.identityDir, 'approved-identity.md'), identityText);
  const sdk = opts.sdkVersion ?? OBSERVED_SDK;
  const iContent = '（测试）I 快照合成内容';
  const rulesContent = '（测试）运行规则合成内容';
  fs.writeFileSync(path.join(paths.identityDir, 'i-snapshot.md'), iContent);
  fs.writeFileSync(path.join(paths.identityDir, 'runtime-rules.md'), rulesContent);
  const manifest = {
    display_name: 'estómago', spec_version: '0.2.1', status: 'APPROVED', identity_version: 'test-v1',
    approved_source_ref: 'approved-identity.md', approved_source_hash: sha256Hex(identityText),
    i_version: 'test-i-1', i_hash: sha256Hex(iContent), i_snapshot_ref: 'i-snapshot.md',
    runtime_rules_version: 'test-rules-1', rules_hash: sha256Hex(rulesContent), runtime_rules_ref: 'runtime-rules.md',
    system_prompt_mode: 'explicit_custom',
    system_prompt_hash: sha256Hex(identityText), sdk_version: sdk, runtime_version: 'node-test',
    cwd_realpath: fs.realpathSync(paths.workspacesDir), settings_sources: [],
    effective_model: null, effective_tools: [], effective_mcp_servers: null, managed_policy_summary: null,
    verification_evidence: ['test-evidence-ref'], requested_builtin_tools: [], requested_settings_sources: [], bootstrap_receipt_ref: null,
  };
  fs.writeFileSync(path.join(paths.configDir, 'identity-manifest.json'), JSON.stringify(manifest, null, 2));
  // 探针证据：与实装版本绑定（gate 单测用途；可用 seedProbes:false 关闭以测“无证据”路径）
  if (opts.seedProbes !== false) {
    const db = openDatabase(path.join(root, 'data'));
    migrate(db, sha256Hex);
    seedProbes(db, sdk, opts.probeState ?? 'supported');
    db.close();
  }
  return { manifest, identityText };
}

export function readyRuntimePatch(sdkVersion?: string): Record<string, unknown> {
  return {
    identity: { expected_identity_version: 'test-v1', expected_i_version: 'test-i-1', expected_rules_version: 'test-rules-1' },
    runtime: {
      tool_schema_mode: 'legacy', // Existing scenario fixtures exercise the legacy wire protocol.
      model: 'fixture-model',
      sdk_version: sdkVersion ?? OBSERVED_SDK,
      runtime_version: 'node-test',
      auth_and_billing_verified: true,
      capability_state: 'verified', // 仅历史字段；v0.2.2 gate 不再信任它（AUD-02 回归验证点）
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// P03：测试装配镜像生产——已迁能力注册表（oído+voice 域）。旧测试夹具构造执行器后调用本助手
// 接线，断言不变；生产由 app-context 完成同一登记。sirenCall/programFacts 可选（通话用例夹具传）。
export function wireOidoCapabilitiesForTest(
  executor: object,
  deps: { db: Db; oido: unknown; media?: unknown; sirenCall?: unknown; programFacts?: unknown; messages?: unknown; events?: unknown; archiveSync?: unknown },
): void {
  const registry = new CapabilityRegistry();
  registerOidoCapabilities(registry, {
    db: deps.db, oido: deps.oido as never, sources: new OidoSourceRepository(deps.db),
    audio: (deps.media ?? null) as never,
    artifacts: (deps.media ?? null) as never,
  });
  if (deps.sirenCall !== undefined || deps.programFacts !== undefined) {
    registerVoiceCapabilities(registry, {
      db: deps.db, sirenCall: (deps.sirenCall ?? null) as never, programFacts: (deps.programFacts ?? null) as never,
    });
  }
  registerConversationCapabilities(registry, {
    db: deps.db, messages: (deps.messages ?? null) as never, media: (deps.media ?? null) as never,
    events: (deps.events ?? null) as never, archiveSync: (deps.archiveSync ?? null) as never,
  });
  (executor as { setCapabilityRegistry(r: CapabilityRegistry): void }).setCapabilityRegistry(registry);
}
