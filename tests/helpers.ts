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
import { registerMemoryCapabilities } from '../apps/host/src/modules/memory/module.ts';
import { registerConversationCapabilities } from '../apps/host/src/modules/conversation/module.ts';
import { registerVoiceCapabilities } from '../apps/host/src/modules/voice/module.ts';
import { registerWishstarCapabilities as registerWishstarCapabilitiesInstance } from '../apps/host/src/modules/wishstar/module.ts';
import { registerContentCapabilities as registerContentCapabilitiesInstance } from '../apps/host/src/modules/content/module.ts';
import { registerWakeCapabilities as registerWakeCapabilitiesInstance } from '../apps/host/src/modules/wake/module.ts';
import { registerMediaCapabilities as registerMediaCapabilitiesInstance } from '../apps/host/src/modules/media/module.ts';
import { registerIdentityCapabilities as registerIdentityCapabilitiesInstance } from '../apps/host/src/modules/identity/module.ts';
import { registerContextReviewCapabilities as registerContextReviewCapabilitiesInstance } from '../apps/host/src/modules/context-review/module.ts';
import { validateArgsAgainstSchema } from '../apps/host/src/capabilities/validation.ts';
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

// P03/P04：测试装配镜像生产——已迁能力注册表（oído/memory/conversation/voice 域）。
// 依赖从执行器实例反射读取（生产装配的同一份依赖）；调用点传入的 opts 仅覆盖
// oído/sirenCall/programFacts，其余字段忽略（不要求调用方重复收集依赖表达式）。
export function wireOidoCapabilitiesForTest(
  executor: object,
  opts: { oido?: unknown; sirenCall?: unknown; programFacts?: unknown } = {},
): CapabilityRegistry {
  const e = executor as Record<string, unknown>;
  const db = e.db as Db;
  const registry = new CapabilityRegistry();
  const oido = (opts.oido !== undefined ? opts.oido : e.oido) ?? null;
  registerOidoCapabilities(registry, {
    db, oido: oido as never, sources: new OidoSourceRepository(db),
    audio: (e.media ?? null) as never,
    artifacts: (e.media ?? null) as never,
  });
  const memoryService = registerMemoryCapabilities(registry, {
    db, tz: (e.tz ?? null) as string | null, mariposa: (e.mariposa ?? null) as never,
    surfaceDetailClient: (e.surfaceDetailClient ?? null) as never,
    reviews: e.reviews as never, checkpoint: e.checkpoint as never,
    archiveSync: (e.archiveSync ?? null) as never,
  });
  registerConversationCapabilities(registry, {
    db, tz: (e.tz ?? null) as string | null, messages: (e.messages ?? null) as never,
    media: (e.media ?? null) as never, events: (e.events ?? null) as never,
    archiveSync: (e.archiveSync ?? null) as never,
  });
  registerWishstarCapabilitiesInstance(registry, { wishstar: (e.wishstar ?? null) as never });
  registerContentCapabilitiesInstance(registry, { contentClient: (e.contentClient ?? null) as never, media: (e.media ?? null) as never });
  registerWakeCapabilitiesInstance(registry, { db, taskService: (e.taskService ?? null) as never });
  registerMediaCapabilitiesInstance(registry, { media: (e.media ?? null) as never, mediaIndex: (e.mediaIndex ?? null) as never });
  registerIdentityCapabilitiesInstance(registry, { db, identity: (e.identity ?? null) as never });
  registerContextReviewCapabilitiesInstance(registry, { db, reviews: e.reviews as never, checkpoint: e.checkpoint as never });
  const sirenCall = opts.sirenCall !== undefined ? opts.sirenCall : e.sirenCall;
  if (sirenCall !== undefined || opts.programFacts !== undefined) {
    registerVoiceCapabilities(registry, {
      db, sirenCall: (sirenCall ?? null) as never, programFacts: (opts.programFacts ?? null) as never,
    });
  }
  (executor as { setCapabilityRegistry(r: CapabilityRegistry): void }).setCapabilityRegistry(registry);
  (executor as { setMemoryRecovery(s: unknown): void }).setMemoryRecovery(memoryService);
  return registry; // S17b 批次3：返回同一注册表供测试把 toolCatalog 传给 Supervisor
}


// S15（原 validateToolArgs 迁入测试辅助层）：生产 API 已删——测试改用与注册表执行外壳
// 同源的真实校验入口（条目 definition + capabilities/validation 通用校验）。
// 语义=原 allowlist 解析 + validateArgsAgainstSchema（错误码逐一保持）。
export function validateToolArgs(name: string, args: Record<string, unknown>, frozenSpec?: { function: { parameters: Record<string, unknown> } }): { ok: true; value: Record<string, unknown> } | { ok: false; code: string; detail: string } {
  const spec = frozenSpec ?? fullToolCatalog().find((t) => t.function.name === name);
  if (!spec) return { ok: false, code: 'TOOL_NOT_IN_ALLOWLIST', detail: name };
  return validateArgsAgainstSchema(args, spec.function.parameters as { properties?: Record<string, never>; required?: string[] });
}

// S17b 批次3：测试装配的唯一目录来源——显式注册全部生产模块（镜像 app-context 装配顺序），
// 经 Registry.currentCatalog() 提供 buildHostTools 删除后的目录（探针等测试模块不进默认集合）。
export function buildFullTestRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerMemoryCapabilities(registry, { db: {} as Db, mariposa: null, reviews: {} as never, checkpoint: {} as never });
  registerOidoCapabilities(registry, { db: {} as Db, oido: null, sources: new OidoSourceRepository({} as Db) });
  registerVoiceCapabilities(registry, { db: {} as Db, sirenCall: null, programFacts: null });
  registerConversationCapabilities(registry, { db: {} as Db });
  registerWishstarCapabilitiesInstance(registry, { wishstar: null });
  registerContentCapabilitiesInstance(registry, { contentClient: null });
  registerWakeCapabilitiesInstance(registry, { db: {} as Db, taskService: null });
  registerMediaCapabilitiesInstance(registry, { media: null, mediaIndex: null });
  registerIdentityCapabilitiesInstance(registry, { db: {} as Db, identity: null });
  registerContextReviewCapabilitiesInstance(registry, { db: {} as Db, reviews: {} as never, checkpoint: {} as never });
  return registry;
}

/** buildHostTools 删除后的目录来源：按 baselineOrder 的 48 项正本。 */
export function fullToolCatalog(): import('../apps/host/src/capabilities/contracts.ts').HostToolSpec[] {
  return buildFullTestRegistry().currentCatalog();
}
