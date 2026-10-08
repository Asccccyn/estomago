// 身份层 v0.2.2（AUD-02/22 修复版）：Evidence Gate —— 期望(expected)与观测(observed)分离。
// 配置只能声明 expected；READY 必须依赖观测证据：
//  - 实装 SDK 包版本（node_modules 实测）=== manifest 声明 === 配置锁定值
//  - manifest.cwd_realpath === workspaces 目录 realpath
//  - manifest.settings_sources / requested_builtin_tools 与配置一致
//  - capability_probes 表内关键探针 state=supported 且 sdk_version 与实装版本匹配
// 任何关键观测为 null/unknown/mismatch/stale → IDENTITY_BLOCKED；
// 没有批准身份材料 → 阻断，绝不提供默认人格。
import fs from 'node:fs';
import path from 'node:path';
// 上下文指纹（§7 AUD：人格/运行边界变化检测）——任何影响人格或运行边界的字段都参与。
// ESTOMAGO_OR_SELF_HOLD §4.1：驱动/模型/缓存配置变更同样改变上下文有效性 → 纳入指纹触发换窗。
// 身份映射隔离：deepseek 段独立参与指纹——OR↔DS 切换（或 DS 型号/输出上限变化）→ CONTEXT_STALE 强制换窗。
export function contextFingerprint(config: {
  runtime: { provider?: string; sdk_version: string | null; model?: string | null; setting_sources: string[]; builtin_tools: string[]; mcp_servers_allowlist: string[] };
  openrouter?: { model: string | null; max_output_tokens: number; provider_only: string[]; reasoning: Record<string, unknown> | null };
  deepseek?: { model: string | null; max_output_tokens: number };
}, manifest: IdentityManifestFile | null): string {
  const parts = [
    manifest?.identity_version ?? null,
    manifest?.approved_source_hash ?? null,
    manifest?.i_version ?? null,
    manifest?.i_hash ?? null,
    manifest?.runtime_rules_version ?? null,
    manifest?.rules_hash ?? null,
    config.runtime.sdk_version,
    config.runtime.model, // D09（审计 3655d60）：SDK 实际型号参与指纹——只换 runtime.model 也算运行边界变化（旧窗不 resume）
    JSON.stringify(config.runtime.setting_sources),
    JSON.stringify(config.runtime.builtin_tools),
    JSON.stringify([...config.runtime.mcp_servers_allowlist].sort()),
    config.runtime.provider ?? 'claude-agent-sdk',
    // 2026-10-08 她裁定：reasoning 不参与指纹——推理等级是逐请求生成参数，
    // 切换不构成运行边界变化（上下文/窗口全复用；型号仍参与）
    config.openrouter ? JSON.stringify([config.openrouter.model, config.openrouter.max_output_tokens, [...config.openrouter.provider_only].sort()]) : null,
    config.deepseek ? JSON.stringify([config.deepseek.model, config.deepseek.max_output_tokens]) : null,
  ];
  return sha256Hex(parts.join('\u0001'));
}

/** 指纹输入的配置形状（windows/manager 与 supervisor 共用；完整 Config 结构满足此类型） */
export type BoundaryConfigInput = Parameters<typeof contextFingerprint>[0];

import { createRequire } from 'node:module';
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId, sha256Hex } from '../util/id.ts';
import type { Config } from '../config/schema.ts';
import type { EstomagoPaths } from '../config/paths.ts';

const require_ = createRequire(import.meta.url);
export function defaultObservedSdkVersion(): string | null {
  try {
    // 包 exports 未暴露 ./package.json：从入口文件路径旁读取
    const entry = require_.resolve('@anthropic-ai/claude-agent-sdk') as string;
    const fs2 = require_('node:fs') as typeof import('node:fs');
    const path2 = require_('node:path') as typeof import('node:path');
    const pkg = JSON.parse(fs2.readFileSync(path2.join(path2.dirname(entry), 'package.json'), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return null;
  }
}

export type IdentityManifestFile = {
  display_name: string;
  spec_version: string;
  status: string;
  identity_version: string | null;
  approved_source_ref: string | null;
  approved_source_hash: string | null;
  i_version: string | null;
  i_hash: string | null;
  i_snapshot_ref: string | null; // F04：I 快照文件引用（与 i_hash 成对，缺一即阻断）
  runtime_rules_version: string | null;
  rules_hash: string | null;
  runtime_rules_ref: string | null; // F04：运行规则文件引用（与 rules_hash 成对，缺一即阻断）
  system_prompt_mode: string;
  system_prompt_hash: string | null;
  sdk_version: string | null;
  runtime_version: string | null;
  cwd_realpath: string | null;
  settings_sources: string[];
  effective_model: string | null;
  effective_tools: string[] | null;
  effective_mcp_servers: string[] | null;
  managed_policy_summary: string | null;
  verification_evidence: string[];
  requested_builtin_tools: string[];
  requested_settings_sources: string[];
  bootstrap_receipt_ref: string | null;
};

export type GateResult = {
  state: 'READY' | 'IDENTITY_BLOCKED';
  reasons: string[];
  manifest: IdentityManifestFile | null;
  observed: {
    installed_sdk_version: string | null;
    cwd_realpath: string | null;
    probes: Record<string, { state: string; sdk_version: string } | null>;
  };
};

export type BootstrapReceipt = {
  id: string;
  spec_version: string;
  status: string;
  window_id: string | null;
  manifest_ref: string | null;
  desired: Record<string, unknown>;
  assembled: Record<string, unknown>;
  observed: Record<string, unknown>;
  probe: Record<string, unknown>;
  activation_gate: { state: string; scope: string; reasons: string[] };
};

// READY 必须有匹配版本证据的关键探针（02 §5 + 05）
export const REQUIRED_PROBES = [
  'system_prompt_explicit',
  'settings_sources_isolated',
  'interrupt_supported',
  'thinking_delta_observed',
  'complete_block_mapping_verified',
] as const;

export class IdentityService {
  private config: Config;
  private paths: EstomagoPaths;
  private observedSdkVersion: () => string | null;
  constructor(config: Config, paths: EstomagoPaths, observedSdkVersion: () => string | null = defaultObservedSdkVersion) {
    this.config = config;
    this.paths = paths;
    this.observedSdkVersion = observedSdkVersion;
  }

  manifestPath(): string {
    return path.join(this.paths.configDir, 'identity-manifest.json');
  }

  loadManifest(): { manifest: IdentityManifestFile | null; error: string | null } {
    const p = this.manifestPath();
    if (!fs.existsSync(p)) {
      return { manifest: null, error: `身份 manifest 不存在：${p}（没有批准材料即保持阻断；不提供默认人格）` };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as IdentityManifestFile;
      return { manifest: raw, error: null };
    } catch {
      return { manifest: null, error: 'CONFIG_ERROR: manifest_invalid_json' };
    }
  }

  // 审计 F01：驱动判别——SDK 专属前提（sdk_version 锁定/实装匹配、订阅认证确认、SDK 版本绑定探针、
  // runtime.model）只约束 SDK 驱动；OR/DS 用各自的型号与 key 状态门（selectRunner），共有身份校验
  // （manifest/版本三键/hash 到文件/证据非空）对全部驱动同样强制（§2.1：共有的身份/主体权限校验必需）。
  evaluateGate(db?: Db, opts?: { driver?: 'openrouter' | 'claude-agent-sdk' | 'deepseek' }): GateResult {
    const driver = opts?.driver ?? 'claude-agent-sdk';
    const reasons: string[] = [];
    const installed = this.observedSdkVersion();
    const cwdReal = fs.existsSync(this.paths.workspacesDir) ? fs.realpathSync(this.paths.workspacesDir) : null;
    const probes: GateResult['observed']['probes'] = {};
    const { manifest, error } = this.loadManifest();
    if (!manifest) {
      return { state: 'IDENTITY_BLOCKED', reasons: [error ?? 'manifest 缺失'], manifest: null, observed: { installed_sdk_version: installed, cwd_realpath: cwdReal, probes } };
    }

    // —— 声明完整性（I/规则版本现在是必填证据）——
    if (manifest.status !== 'APPROVED') reasons.push(`manifest.status=${manifest.status}（须为 APPROVED）`);
    for (const k of ['identity_version', 'i_version', 'runtime_rules_version'] as const) {
      if (!manifest[k]) reasons.push(`manifest.${k} 缺失（ID evidence gate）`);
    }
    // v0.3 + F04：I/rules 的内容 hash 必须非空且能验证到实际文件
    if (!manifest.i_hash) reasons.push('manifest.i_hash 缺失');
    if (!manifest.rules_hash) reasons.push('manifest.rules_hash 缺失');
    // F04：引用与 hash 必须成对且验证到实际文件——没有"ref 可选"的逃逸口
    const verifyFile = (ref: string | null | undefined, expectedHash: string | null | undefined, label: string): void => {
      if (!ref || !expectedHash) {
        reasons.push(`${label} 引用或 hash 缺失（ref 与 hash 必须成对提供，缺一即阻断）`);
        return;
      }
      const refPath = path.resolve(this.paths.identityDir, ref);
      if (!fs.existsSync(refPath)) {
        reasons.push(`${label} 文件不存在：${ref}`);
        return;
      }
      const actual = sha256Hex(fs.readFileSync(refPath));
      if (actual !== expectedHash) {
        reasons.push(`${label} 内容 hash 不符：期望 ${expectedHash.slice(0, 8)}… / 实际 ${actual.slice(0, 8)}…`);
      }
    };
    // F04：I 快照和运行规则必须提供引用并验证实际内容 hash
    verifyFile(manifest.i_snapshot_ref, manifest.i_hash, 'I 快照');
    verifyFile(manifest.runtime_rules_ref, manifest.rules_hash, '运行规则');
    // F04：verification_evidence 至少一条，且每条必须是非空白字符串（空串不算证据）
    if (
      !Array.isArray(manifest.verification_evidence) ||
      manifest.verification_evidence.length === 0 ||
      manifest.verification_evidence.some((e) => typeof e !== 'string' || e.trim() === '')
    ) {
      reasons.push('verification_evidence 缺少非空条目（F04：批准材料至少要有一条真实证据引用）');
    }
    if (manifest.system_prompt_mode !== 'explicit_custom') reasons.push('system_prompt_mode 须为 explicit_custom');
    if (manifest.approved_source_ref && manifest.approved_source_hash) {
      const ref = path.resolve(this.paths.identityDir, manifest.approved_source_ref);
      if (!fs.existsSync(ref)) reasons.push(`批准材料文件不存在：${manifest.approved_source_ref}`);
      else if (sha256Hex(fs.readFileSync(ref)) !== manifest.approved_source_hash) reasons.push('批准材料 hash 不符（拒绝装载，不降级用缓存）');
    } else {
      reasons.push('approved_source_ref/hash 缺失');
    }

    // —— 期望 vs 批准观测：版本三键声明期望，manifest 为批准值，不一致即阻断（AUD-02）
    const expect = this.config.identity as { expected_identity_version: string | null; expected_i_version: string | null; expected_rules_version: string | null };
    if (expect.expected_identity_version && manifest.identity_version !== expect.expected_identity_version) {
      reasons.push(`identity_version 不符：期望 ${expect.expected_identity_version} / 批准 ${manifest.identity_version}`);
    }
    if (expect.expected_i_version && manifest.i_version !== expect.expected_i_version) {
      reasons.push(`i_version 不符：期望 ${expect.expected_i_version} / 批准 ${manifest.i_version}`);
    }
    if (expect.expected_rules_version && manifest.runtime_rules_version !== expect.expected_rules_version) {
      reasons.push(`rules_version 不符：期望 ${expect.expected_rules_version} / 批准 ${manifest.runtime_rules_version}`);
    }

    // —— 期望 vs 观测（AUD-02 核心：配置自填 verified 不再是证据）——
    if (driver === 'claude-agent-sdk' && !this.config.runtime.model) reasons.push('runtime.model=null（expected 未配置）');
    if (driver === 'claude-agent-sdk' && !this.config.runtime.sdk_version) reasons.push('runtime.sdk_version=null（expected 未锁定）');
    if (driver === 'claude-agent-sdk' && !this.config.runtime.auth_and_billing_verified) reasons.push('auth_and_billing_verified=false（认证/计费未确认）');
    if (driver === 'claude-agent-sdk') {
      if (installed === null) {
        reasons.push('observed: SDK 包未安装（无法观测版本）');
      } else {
        if (this.config.runtime.sdk_version && this.config.runtime.sdk_version !== installed) {
          reasons.push(`sdk_version 不匹配：配置 ${this.config.runtime.sdk_version} / 实装 ${installed}`);
        }
        if (manifest.sdk_version && manifest.sdk_version !== installed) {
          reasons.push(`manifest.sdk_version=${manifest.sdk_version} 与实装 ${installed} 不符（批准材料针对另一版本）`);
        }
      }
    }
    if (!manifest.cwd_realpath || manifest.cwd_realpath !== cwdReal) {
      reasons.push(`cwd 不符：manifest=${manifest.cwd_realpath} / 实测=${cwdReal}`);
    }
    if (JSON.stringify(manifest.settings_sources ?? []) !== JSON.stringify(this.config.runtime.setting_sources)) {
      reasons.push('settings_sources 与配置不一致（观测≠期望）');
    }
    if (JSON.stringify(manifest.requested_builtin_tools ?? []) !== JSON.stringify(this.config.runtime.builtin_tools)) {
      reasons.push('requested_builtin_tools 与配置不一致');
    }
    // v0.3：effective MCP 观测（当前边界=空 allowlist；接入获准 MCP 后须逐项对照）
    const expectedMcp = this.config.runtime.mcp_servers_allowlist;
    const observedMcp = manifest.effective_mcp_servers ?? [];
    if (JSON.stringify([...observedMcp].sort()) !== JSON.stringify([...expectedMcp].sort())) {
      reasons.push(`effective_mcp_servers 不符：manifest=${JSON.stringify(observedMcp)} / 配置=${JSON.stringify(expectedMcp)}`);
    }

    // —— 能力探针证据（DB 观测，绑定实装版本；SDK 驱动专属——OR 的能力校验走自身型号/端点门）——
    if (driver === 'claude-agent-sdk') {
      if (db) {
        const maxAgeDays = (this.config.identity as { probe_evidence_max_age_days: number | null }).probe_evidence_max_age_days;
        for (const key of REQUIRED_PROBES) {
          const row = db
            .prepare('SELECT state, sdk_version, evidence_ref, observed_at FROM capability_probes WHERE probe_key = ? AND sdk_version = ?')
            .get(key, installed ?? '') as { state: string; sdk_version: string; evidence_ref: string; observed_at: string } | undefined;
          probes[key] = row ?? null;
          if (!row) reasons.push(`probe_missing:${key}（无匹配 ${installed ?? 'null'} 版本的实机证据）`);
          else if (row.state !== 'supported') reasons.push(`probe_${row.state}:${key}`);
          else if (!row.evidence_ref || row.evidence_ref.trim() === '') reasons.push(`probe_evidence_missing:${key}（supported 但证据引用为空）`);
          else if (maxAgeDays != null) {
            // F04：观测陈旧按明确配置策略判定（probe_evidence_max_age_days；null=不按时间过期）
            const ageDays = (Date.now() - new Date(row.observed_at).getTime()) / 86_400_000;
            if (Number.isFinite(ageDays) && ageDays > maxAgeDays) reasons.push(`probe_stale:${key}（观测于 ${row.observed_at}，超出 ${maxAgeDays} 天有效期）`);
          }
        }
      } else {
        for (const key of REQUIRED_PROBES) probes[key] = null;
        reasons.push('probe_store_unavailable（无法读取能力探针证据）');
      }
    }

    return {
      state: reasons.length === 0 ? 'READY' : 'IDENTITY_BLOCKED',
      reasons,
      manifest,
      observed: { installed_sdk_version: installed, cwd_realpath: cwdReal, probes },
    };
  }

  readApprovedIdentityText(manifest: IdentityManifestFile): string | null {
    try {
      return fs.readFileSync(path.resolve(this.paths.identityDir, manifest.approved_source_ref!), 'utf8');
    } catch {
      return null;
    }
  }

  // F04：已验证材料的单一装载入口——校验（hash）与装配读同一份字节，绝不"校验后再读另一份内容"。
  // 返回 null 表示装载失败（gate 未 READY 或文件读失败），调用方必须阻断，不得回退硬编码正文
  loadVerifiedMaterials(manifest: IdentityManifestFile): { identityText: string; rulesText: string; iText: string | null; iStatus: string } | null {
    const read = (ref: string | null | undefined): string | null => {
      if (!ref) return null;
      try {
        return fs.readFileSync(path.resolve(this.paths.identityDir, ref), 'utf8');
      } catch {
        return null;
      }
    };
    const identityText = read(manifest.approved_source_ref);
    const rulesText = read(manifest.runtime_rules_ref);
    if (identityText === null || rulesText === null) return null;
    // I 属于开窗包（current_i）通道；ContextPolicy 未批准 → 不装载，如实标记（不填默认、不升级为 system 命令）
    const iText = read(manifest.i_snapshot_ref);
    return { identityText, rulesText, iText, iStatus: iText === null ? 'not_loaded_policy_unapproved' : 'verified_not_projected_policy_unapproved' };
  }

  // Bootstrap Receipt（05 §3 四层证据）；返回真实主键（AUD-22：window.receipt_id 引用它）
  buildAndStoreReceipt(db: Db, opts: {
    windowId: string | null;
    manifest: IdentityManifestFile | null;
    gate: GateResult;
    assembledOptions: Record<string, unknown> | null;
  }): BootstrapReceipt {
    const desired = {
      instruction_mode: 'explicit_custom',
      original_preset_included: false,
      builtin_tools: this.config.runtime.builtin_tools,
      setting_sources: this.config.runtime.setting_sources,
      auto_memory_enabled: !this.config.runtime.disable_auto_memory,
      automatic_connectors_enabled: !this.config.runtime.disable_claude_ai_connectors,
      thinking_display: this.config.runtime.thinking.display,
      sdk_version: this.config.runtime.sdk_version,
    };
    const assembled = {
      sdk_version: this.observedSdkVersion(),
      cwd_realpath: opts.gate.observed.cwd_realpath,
      // F04：prompt hash 从实际组装值计算，不复制 manifest 声明（声明与组装可以不一致）
      system_prompt_hash: (() => {
        const prompt = (opts.assembledOptions as { options?: { systemPrompt?: unknown } } | null)?.options?.systemPrompt;
        return typeof prompt === 'string' && prompt.length > 0 ? sha256Hex(prompt) : null;
      })(),
      identity_version: opts.manifest?.identity_version ?? null,
      i_version: opts.manifest?.i_version ?? null,
      runtime_rules_version: opts.manifest?.runtime_rules_version ?? null,
      options_hash: opts.assembledOptions ? sha256Hex(JSON.stringify(opts.assembledOptions)) : null,
      // F04：各材料装载状态如实记录——rules 材料必须进入 systemPrompt；I 留在开窗包通道（策略未批准不装载）
      rules_material_loaded: Boolean((opts.assembledOptions as { options?: { systemPrompt?: unknown } } | null)?.options?.systemPrompt),
      i_material_status: opts.manifest?.i_snapshot_ref ? 'verified_not_projected_policy_unapproved' : 'not_referenced',
    };
    const observed = {
      state: opts.gate.state === 'READY' ? 'verified_local' : 'blocked_local',
      final_request_observable: false,
      original_preset_included: null,
      effective_model: null,
      effective_tools: null,
      loaded_instruction_sources: null,
      managed_policy_summary: null,
      thinking_delta_seen: null,
      sdk_init_evidence_ref: null,
      probes: opts.gate.observed.probes,
    };
    const probe = {
      status: 'RECORDED',
      version_match: this.observedSdkVersion() === this.config.runtime.sdk_version,
      evidence_refs: Object.entries(opts.gate.observed.probes).map(([k, v]) => `${k}:${v?.state ?? 'null'}`),
      blocking_unknowns: opts.gate.reasons.slice(),
      non_observable_fields: ['original_preset_included', 'final_request_observable'],
    };
    const id = genId('rcpt');
    const receipt: BootstrapReceipt = {
      id,
      spec_version: this.config.project.spec_version,
      status: 'RECORDED_NOT_VERIFIED',
      window_id: opts.windowId,
      manifest_ref: opts.manifest ? this.manifestPath() : null,
      desired,
      assembled,
      observed,
      probe,
      activation_gate: {
        state: opts.gate.state,
        scope: 'local identity and required runtime capability readiness; not complete provider internals',
        reasons: opts.gate.reasons,
      },
    };
    tx(db, () => {
      db.prepare(
        `INSERT INTO bootstrap_receipts(id, window_id, manifest_ref, desired, assembled, observed, probe, gate_state, gate_reasons, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        opts.windowId,
        receipt.manifest_ref,
        JSON.stringify(desired),
        JSON.stringify(assembled),
        JSON.stringify(observed),
        JSON.stringify(probe),
        opts.gate.state,
        JSON.stringify(opts.gate.reasons),
        new Date().toISOString(),
      );
    });
    return receipt;
  }
}
