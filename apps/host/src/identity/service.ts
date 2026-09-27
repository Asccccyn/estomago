// 身份层（01 §6 / 05 §3）：Manifest 描述获准材料；Receipt 描述一次装载；Gate 只认证据。
// 没有真实、已批准身份材料 → IDENTITY_BLOCKED；绝不提供默认人格顶替（02 §6.1）。
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { genId, sha256Hex } from '../util/id.ts';
import type { Config } from '../config/schema.ts';
import type { EstomagoPaths } from '../config/paths.ts';

export type IdentityManifestFile = {
  display_name: string;
  spec_version: string;
  status: string; // TEMPLATE_NOT_LOADED（模板）/ APPROVED（批准后）
  identity_version: string | null;
  approved_source_ref: string | null;
  approved_source_hash: string | null;
  i_version: string | null;
  runtime_rules_version: string | null;
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
};

export type BootstrapReceipt = {
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

export class IdentityService {
  private config: Config;
  private paths: EstomagoPaths;
  constructor(config: Config, paths: EstomagoPaths) {
    this.config = config;
    this.paths = paths;
  }

  manifestPath(): string {
    // 优先 config/identity-manifest.json（本机有效配置区）；模板不会自动充当正本
    const live = path.join(this.paths.configDir, 'identity-manifest.json');
    return live;
  }

  loadManifest(): { manifest: IdentityManifestFile | null; error: string | null } {
    const p = this.manifestPath();
    if (!fs.existsSync(p)) {
      return { manifest: null, error: `身份 manifest 不存在：${p}（复制 config/identity-manifest.example.json 后按批准材料填写；没有批准材料即保持阻断）` };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as IdentityManifestFile;
      return { manifest: raw, error: null };
    } catch (err) {
      return { manifest: null, error: `身份 manifest 解析失败：${(err as Error).message}` };
    }
  }

  // 激活 gate（05 §3）：关键项未知或不满足 → BLOCKED；非关键不可观测 → not_observable，不阻断也不算通过
  evaluateGate(): GateResult {
    const reasons: string[] = [];
    const { manifest, error } = this.loadManifest();
    if (!manifest) return { state: 'IDENTITY_BLOCKED', reasons: [error ?? 'manifest 缺失'], manifest: null };

    if (manifest.status !== 'APPROVED') reasons.push(`manifest.status=${manifest.status}（须为 APPROVED；模板/未批准不算身份正本）`);
    if (!manifest.identity_version) reasons.push('identity_version 缺失');
    if (!manifest.approved_source_ref) reasons.push('approved_source_ref 缺失');
    if (!manifest.approved_source_hash) reasons.push('approved_source_hash 缺失');
    if (manifest.system_prompt_mode !== 'explicit_custom') reasons.push('system_prompt_mode 须为 explicit_custom');

    // 身份正本存在且 hash 匹配
    if (manifest.approved_source_ref && manifest.approved_source_hash) {
      const ref = path.resolve(this.paths.identityDir, manifest.approved_source_ref);
      if (!fs.existsSync(ref)) {
        reasons.push(`批准材料文件不存在：${manifest.approved_source_ref}（在 identity/ 下）`);
      } else {
        const actual = sha256Hex(fs.readFileSync(ref));
        if (actual !== manifest.approved_source_hash) reasons.push('批准材料 hash 不符：拒绝装载（不自动改用缓存或默认人格）');
      }
    }

    // 运行前提（现场未核实的一律阻断，不冒充支持）
    if (!this.config.runtime.model) reasons.push('runtime.model 为 null：现场模型未核实');
    if (!this.config.runtime.sdk_version) reasons.push('runtime.sdk_version 为 null：SDK 版本未锁定');
    if (!this.config.runtime.auth_and_billing_verified) reasons.push('auth_and_billing_verified=false：认证与计费未确认（不得为跑通偷偷换 key/账号）');
    if (this.config.runtime.thinking.require_capability_probe && this.config.runtime.capability_state !== 'verified') {
      reasons.push(`runtime.capability_state=${this.config.runtime.capability_state}：能力矩阵未取得实机证据`);
    }

    return { state: reasons.length === 0 ? 'READY' : 'IDENTITY_BLOCKED', reasons, manifest };
  }

  // 读取批准身份正文（仅在 gate 通过后调用）
  readApprovedIdentityText(manifest: IdentityManifestFile): string | null {
    try {
      const ref = path.resolve(this.paths.identityDir, manifest.approved_source_ref!);
      return fs.readFileSync(ref, 'utf8');
    } catch {
      return null;
    }
  }

  // Bootstrap Receipt（05 §3：desired/assembled/observed/probe 四层；unknown 不填 false/[]）
  buildAndStoreReceipt(db: Db, opts: {
    windowId: string | null;
    manifest: IdentityManifestFile | null;
    gate: GateResult;
    assembledOptions: Record<string, unknown>;
  }): BootstrapReceipt {
    const desired = {
      instruction_mode: 'explicit_custom',
      original_preset_included: false,
      builtin_tools: this.config.runtime.builtin_tools,
      setting_sources: this.config.runtime.setting_sources,
      auto_memory_enabled: !this.config.runtime.disable_auto_memory,
      automatic_connectors_enabled: !this.config.runtime.disable_claude_ai_connectors,
      thinking_display: this.config.runtime.thinking.display,
    };
    const assembled = {
      sdk_version: this.config.runtime.sdk_version,
      runtime_version: this.config.runtime.runtime_version,
      cwd_realpath: this.paths.workspacesDir,
      system_prompt_hash: opts.manifest?.system_prompt_hash ?? null,
      identity_version: opts.manifest?.identity_version ?? null,
      i_version: opts.manifest?.i_version ?? null,
      runtime_rules_version: opts.manifest?.runtime_rules_version ?? null,
      options_hash: sha256Hex(JSON.stringify(opts.assembledOptions)),
      environment_profile_ref: null, // 环境白名单装配未实装：保持 null（unknown）
      tool_schema_hash: null,
    };
    const observed = {
      state: 'unknown',
      final_request_observable: false,
      original_preset_included: null, // 无该层观测：null ≠ false（05 §3）
      effective_model: null,
      effective_tools: null,
      loaded_instruction_sources: null,
      managed_policy_summary: null,
      thinking_delta_seen: null,
      sdk_init_evidence_ref: null,
    };
    const probe = {
      status: 'NOT_EXECUTED',
      version_match: null,
      evidence_refs: [] as string[],
      blocking_unknowns: opts.gate.reasons.slice(),
      non_observable_fields: ['original_preset_included', 'final_request_observable'] as string[],
    };
    const receipt: BootstrapReceipt = {
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
    if (opts.windowId) {
      tx(db, () => {
        db.prepare(
          `INSERT INTO bootstrap_receipts(id, window_id, manifest_ref, desired, assembled, observed, probe, gate_state, gate_reasons, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          genId('rcpt'),
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
    }
    return receipt;
  }
}
