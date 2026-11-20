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
import { ModelToolBridge } from '../apps/host/src/capabilities/model-bridge.ts';
import { registerOidoCapabilities } from '../apps/host/src/modules/oido/module.ts';
import { OidoSourceRepository } from '../apps/host/src/modules/oido/source-repository.ts';
import { registerMemoryCapabilities } from '../apps/host/src/modules/memory/module.ts';
import { registerConversationCapabilities } from '../apps/host/src/modules/conversation/module.ts';
import { registerVoiceCapabilities } from '../apps/host/src/modules/voice/module.ts';
import { registerWishstarCapabilities as registerWishstarCapabilitiesInstance } from '../apps/host/src/modules/wishstar/module.ts';
import { registerContentCapabilities as registerContentCapabilitiesInstance } from '../apps/host/src/modules/content/module.ts';
import { registerWakeCapabilities as registerWakeCapabilitiesInstance } from '../apps/host/src/modules/wake/module.ts';
import { registerMediaCapabilities as registerMediaCapabilitiesInstance } from '../apps/host/src/modules/media/module.ts';
import { registerArchivesCapabilities as registerArchivesCapabilitiesInstance } from '../apps/host/src/modules/archives/module.ts';
import { ArchiveService } from '../apps/host/src/modules/archives/service.ts';
import { registerImageGenCapabilities as registerImageGenCapabilitiesInstance } from '../apps/host/src/modules/imagegen/module.ts';
import { registerIdentityCapabilities as registerIdentityCapabilitiesInstance } from '../apps/host/src/modules/identity/module.ts';
import { registerContextReviewCapabilities as registerContextReviewCapabilitiesInstance } from '../apps/host/src/modules/context-review/module.ts';
import { validateArgsAgainstSchema } from '../apps/host/src/capabilities/validation.ts';
import { freezeWindowTools } from '../apps/host/src/runtime/tool-discovery.ts';
import type { HostToolSpec } from '../apps/host/src/capabilities/contracts.ts';
import { defaultObservedSdkVersion, REQUIRED_PROBES } from '../apps/host/src/identity/service.ts';
import { SolDecisionJudge, SOL_DECISION_SCHEMA_VERSION, type SolJudgeConfig, type SolTransport } from '../apps/host/src/memory-surfacing/sol-provider.ts';

process.env.ESTOMAGO_TEST_MODE = '1';
process.env.EST_TEST_SOL_KEY ??= 'test-sol-key'; // Sol 判断器测试凭据（仅测试进程）

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

/** SOL_RECALL_REFACTOR 测试桩：可脚本化 Sol 判断器（队列耗尽后复用最后一条）。 */
export function solJudgeConfigForTest(overrides: Partial<SolJudgeConfig> = {}): SolJudgeConfig {
  return {
    apiKeyEnv: 'EST_TEST_SOL_KEY',
    baseUrl: 'https://sol.test/v1',
    model: 'gpt-6.1-sol-test',
    reasoningEffort: 'low',
    verbosity: 'low',
    maxOutputTokens: 2048,
    cacheTtl: '12h',
    cacheKeySeed: 'test-seed',
    userDisplayName: '用户',
    assistantDisplayName: '助手',
    templateOverride: null,
    templateRevision: SOL_DECISION_SCHEMA_VERSION,
    ...overrides,
  };
}

export function fakeSolJudge(
  decisions: Array<{ decision: 'none' | 'observe' | 'recall'; topic?: 'same' | 'new'; basis?: string; plan?: Record<string, unknown> }>,
  opts: { config?: Partial<SolJudgeConfig>; response?: (payload: Record<string, unknown>) => { status: number; json: unknown } } = {},
): { judge: SolDecisionJudge; requests: Array<Record<string, unknown>>; calls: () => number } {
  const requests: Array<Record<string, unknown>> = [];
  const queue = [...decisions];
  const config = solJudgeConfigForTest(opts.config);
  const userPrefix = `${config.userDisplayName}：`;
  const transport: SolTransport = async (_url, _headers, payload) => {
    requests.push(payload as Record<string, unknown>);
    if (opts.response) return opts.response(payload as Record<string, unknown>);
    const scripted = queue.length > 1 ? queue.shift()! : queue[0];
    const decision = scripted ?? { decision: 'none' as const };
    const userLines = String(((payload as { input: Array<{ content: unknown }> }).input[1]).content)
      .split('\n').filter(line => line.startsWith(userPrefix)).map(line => line.slice(userPrefix.length));
    const plan = decision.plan ?? {
      purpose: '测试检索目的', route: 'event', breadth: 'single',
      queries: [{ need_kind: 'event', need: '找到相关历史事件证据', semantic: '测试语义查询', keywords: ['测试'], time_hint: null, speaker: null }],
    };
    const outputText = JSON.stringify({
      decision: decision.decision,
      topic: decision.topic ?? 'new',
      basis: decision.basis ?? `测试依据：${decision.decision}`,
      plan: decision.decision === 'recall' ? { ...plan,
        queries: (plan.queries as Array<Record<string, unknown>>).map(query => ({ source_mode: null, person_focus: null, ...query })),
        evidence: plan.evidence ?? [{ user_turn: userLines.length, quote: userLines.at(-1)!.slice(0, 200) }],
      } : null,
    });
    return {
      status: 200,
      json: {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: outputText }] }],
        usage: { input_tokens: 1200, output_tokens: 80, input_tokens_details: { cached_tokens: 1024 } },
      },
    };
  };
  const judge = new SolDecisionJudge(config, transport);
  return { judge, requests, calls: () => requests.length };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// S17b 批次4：测试装配改为显式依赖——调用真实模块注册函数构造 registry、
// 构造 ModelToolBridge（模型工具桥），返回 tools/registry/memoryService。
// 禁止反射执行器私有字段（裁定 §4）。
export type TestToolDeps = {
  db: Db;
  mariposa?: unknown; surfaceDetailClient?: unknown;
  reviews?: unknown; checkpoint?: unknown; archiveSync?: unknown;
  media?: unknown; messages?: unknown; events?: unknown;
  contentClient?: unknown; contentOps?: unknown; identity?: unknown; wishstar?: unknown;
  taskService?: unknown; oido?: unknown; mediaIndex?: unknown;
  sirenCall?: unknown; tz?: unknown;
  archives?: unknown; imagegen?: unknown;
  /** 包4 §6.2：镜像 app-context 的说话人标签注入（缺席=投影原值直通）。 */
  speakerLabels?: import('../apps/host/src/identity/speaker-labels.ts').SpeakerLabels;
};

export function assembleTestTools(deps: TestToolDeps): {
  tools: ModelToolBridge; registry: CapabilityRegistry;
  memoryService: { recoverUnknownEffects(conversationId: string, windowId: string): Promise<{ resolved: number; stillUnknown: number }> };
} {
  const db = deps.db;
  const registry = new CapabilityRegistry();
  const oido = deps.oido ?? null;
  registerOidoCapabilities(registry, {
    db, oido: oido as never, sources: new OidoSourceRepository(db),
    audio: (deps.media ?? null) as never,
    artifacts: (deps.media ?? null) as never,
  });
  // 包4无seq整改：episode 锚点范围解析——与生产同源（archives 的 DBG-04 实现）。
  const anchorsArchive = new ArchiveService({ db, contentClient: (deps.contentClient ?? null) as never, contentOps: (deps.contentOps ?? null) as never, logger: null });
  const memoryService = registerMemoryCapabilities(registry, {
    db, tz: (deps.tz ?? null) as string | null, mariposa: (deps.mariposa ?? null) as never,
    surfaceDetailClient: (deps.surfaceDetailClient ?? null) as never,
    reviews: (deps.reviews ?? null) as never, checkpoint: (deps.checkpoint ?? null) as never,
    archiveSync: (deps.archiveSync ?? null) as never,
    speakerLabels: deps.speakerLabels,
    anchorRange: (roomId, seenMessages, start, end) => anchorsArchive.resolveAnchorRange(roomId, seenMessages, start, end),
  });
  registerConversationCapabilities(registry, {
    db, tz: (deps.tz ?? null) as string | null, messages: (deps.messages ?? null) as never,
    media: (deps.media ?? null) as never, events: (deps.events ?? null) as never,
    archiveSync: (deps.archiveSync ?? null) as never,
    speakerLabels: deps.speakerLabels,
  });
  registerWishstarCapabilitiesInstance(registry, { wishstar: (deps.wishstar ?? null) as never });
  registerContentCapabilitiesInstance(registry, { contentClient: (deps.contentClient ?? null) as never, media: (deps.media ?? null) as never, contentOps: (deps.contentOps ?? null) as never });
  registerWakeCapabilitiesInstance(registry, { db, taskService: (deps.taskService ?? null) as never });
  registerMediaCapabilitiesInstance(registry, { db, contentClient: (deps.contentClient ?? null) as never, media: (deps.media ?? null) as never, mediaIndex: (deps.mediaIndex ?? null) as never });
  // 相册重构 P4：存档工具（镜像 app-context 无条件注册；archives 服务未注入时定义在、
  // 运行期按服务缺席如实报错——与生产装配一致）
  registerArchivesCapabilitiesInstance(registry, { archives: (deps.archives ?? null) as never, mariposa: (deps.mariposa ?? null) as never });
  // 相册重构 P3：图片生成工具（镜像注册；imagegen 未注入=运行期如实 UNCONFIGURED）
  registerImageGenCapabilitiesInstance(registry, { imagegen: (deps.imagegen ?? null) as never });
  registerIdentityCapabilitiesInstance(registry, { db, identity: (deps.identity ?? null) as never });
  registerContextReviewCapabilitiesInstance(registry, { db, reviews: (deps.reviews ?? null) as never, checkpoint: (deps.checkpoint ?? null) as never });
  // voice 域无条件注册（call_control/transcript_read 属 48 基线；sirenCall
  // 未注入=运行时如实 INTEGRATION_UNCONFIGURED，与生产装配一致）
  registerVoiceCapabilities(registry, {
    db, sirenCall: (deps.sirenCall ?? null) as never,
    media: (deps.media ?? null) as never, messages: (deps.messages ?? null) as never,
  });
  const tools = new ModelToolBridge({ db, events: (deps.events ?? null) as never });
  (tools as { setCapabilityRegistry(r: CapabilityRegistry): void }).setCapabilityRegistry(registry);
  (tools as { setMemoryRecovery(s: unknown): void }).setMemoryRecovery(memoryService);
  return { tools, registry, memoryService };
}

/** S17b 批次3：测试装配的唯一目录来源（全部生产模块注册后的 currentCatalog）。
 * 2026-11-03：补 media/messages 占位——chat_send_voice 的注册条件
 * （voice/module.ts A05）在生产恒成立，此前测试装配缺依赖把它跳过，
 * golden 48 比生产目录（49）少一项。占位只在注册期使用，运行期
 * 各测试仍自带真实 deps。 */
export function buildFullTestRegistry(): CapabilityRegistry {
  return assembleTestTools({ db: {} as Db, media: {} as never, messages: {} as never }).registry;
}

/** buildHostTools 删除后的目录来源：按 baselineOrder 的 48 项正本。 */
export function fullToolCatalog(): import('../apps/host/src/capabilities/contracts.ts').HostToolSpec[] {
  return buildFullTestRegistry().currentCatalog();
}


/** 包4无seq整改（2026-11-18）：旧冻结窗兼容夹具——把指定工具钉在包4 之前的旧
 *  schema（模拟生产旧窗的 window_toolsets 冻结目录：旧窗模型仍按旧形状调用，
 *  服务按参数形状分流到旧引擎；新窗 schema 已锁新形状）。engine 语义回归
 *  （RRA-014 分页等）与旧窗兼容（C3）共用本夹具钉住旧合同。 */
export const LEGACY_CONVERSATIONREAD_SPEC: HostToolSpec =
{
    type: 'function',
    function: {
      // WP4（MANUAL_HANDOFF_JUDGE_SWITCH_V1 §7.2，2026-10-08）：主模型只读
      // 原文回读——已知消息/范围的直接展开，不经判断器；房间由宿主派生
      //（模型不能自填别的房间）；不含 UI 思考/草稿/system/tool；只读无副作用
      //（不推进 hold 书签、不制造气泡、不触发明开续期）
      name: 'conversation_read',
      description: '读取本房间已保存的聊天原文（只读）。围绕某条已知消息读前后文，或按序号范围读，长文自动分页。只返回真实用户消息与已正式发布的助手消息；不含思考、草稿或系统内容。读取不产生任何记录动作。已实际送达的片段返回短回执；用户明确要求重看时用 reread=true。',
      parameters: {
        type: 'object',
        properties: {
          around_seq: { type: 'integer', minimum: 1, description: '定位锚点序号（对话里每条消息开头的 [N]）：读它前后各若干条' },
          revision: { type: 'integer', minimum: 1, description: '可选：锚点消息的指定修订号（读不到如实报错，不以当前修订冒充）' },
          before: { type: 'integer', minimum: 1, maximum: 50, description: '锚点之前读几条（默认 5）' },
          after: { type: 'integer', minimum: 1, maximum: 50, description: '锚点之后读几条（默认 5）' },
          from_sequence: { type: 'integer', minimum: 1, description: '范围模式：起始序号（含）' },
          to_sequence: { type: 'integer', minimum: 1, description: '范围模式：结束序号（含）' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '单页最多条数（默认 20）' },
          cursor: { type: 'object', description: '续页游标（上一页返回的 next_cursor 原样传入）' },
          reread: { type: 'boolean', description: '仅用户明确要求重看、逐字核对时，本次仍交付正文。' },
        },
        additionalProperties: false,
      },
    }
  };

export const LEGACY_MEMORYWORDS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['add', 'revise'] },
    memory_id: { type: 'string', minLength: 1 },
    word_id: { type: 'string', minLength: 1 },
    refs: {
      type: 'array', minItems: 1, maxItems: 10,
      items: { type: 'object', additionalProperties: false, required: ['seq'], properties: {
        seq: { type: 'integer', minimum: 1 }, from: { type: 'integer', minimum: 1 }, to: { type: 'integer', minimum: 1 },
      }, dependencies: { from: ['to'], to: ['from'] } },
    },
  },
  required: ['action', 'memory_id', 'refs'], additionalProperties: false,
  allOf: [{ if: { properties: { action: { const: 'revise' } }, required: ['action'] }, then: { required: ['word_id'] } }],
};

/** 冻结一个"旧窗"：目录=当前注册表正本 + 指定工具替换为旧 spec（protocol=legacy）。 */
export function freezeLegacyToolWindow(db: Db, windowId: string, overrides: Partial<Record<string, { function: { name: string; parameters: Record<string, unknown>; description?: string } }>> = {}): void {
  db.prepare("INSERT OR IGNORE INTO conversations(id, owner_service, scope, created_at) VALUES ('c1', 'estomago', 'private', '2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT OR IGNORE INTO windows(id, conversation_id, status, created_at, updated_at) VALUES (?, 'c1', 'ACTIVE', 'now', 'now')").run(windowId);
  const catalog = fullToolCatalog();
  for (let i = 0; i < catalog.length; i++) {
    const ov = overrides[catalog[i]!.function.name];
    if (ov) catalog[i] = { type: 'function', function: { ...catalog[i]!.function, ...ov.function } } as HostToolSpec;
  }
  freezeWindowTools(db, windowId, catalog, 'legacy');
}

/** 旧 hostToolNames 消费者兼容（名称序列与 fullToolCatalog 一致）。 */
export function hostToolNames(): string[] {
  return fullToolCatalog().map((t) => t.function.name);
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

/** buildHostTools 删除后的目录来源：按 baselineOrder 的 48 项正本。 */
