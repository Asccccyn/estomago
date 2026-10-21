// Readiness is local admission readiness, not a paid upstream liveness probe.
// Disabled optional services are reported as disabled and do not fail readiness.
import type { Config } from '../config/schema.ts';
import type { CapabilityMatrix } from '../runtime/capabilities.ts';
import type { RunnerSelection } from '../runtime/runner.ts';
import type { GateResult } from '../identity/service.ts';
import type { ReadyReport, HealthComponent } from '../../../../packages/contracts/src/api.ts';
import { schemaVersion } from '../db/migrations.ts';
import type { Db } from '../db/connection.ts';

export function buildReadyReport(opts: {
  config: Config;
  gate: GateResult;
  runnerSelection: RunnerSelection;
  capabilities: CapabilityMatrix;
  db: Db;
  archiveSync?: { health(): HealthComponent };
}): ReadyReport {
  const { config, gate, runnerSelection, capabilities, db } = opts;
  const identity: HealthComponent = gate.state === 'READY'
    ? { status: 'ok', detail: 'manifest APPROVED 且 hash 匹配' }
    : { status: 'blocked', detail: gate.reasons.join('; ') };

  let runtime: HealthComponent;
  if (runnerSelection.status === 'blocked') {
    runtime = { status: 'blocked', detail: runnerSelection.reasons.join('; ') };
  } else if (runnerSelection.runner.kind === 'openrouter' || runnerSelection.runner.kind === 'deepseek') {
    // These runners have their own config/key validation at selection time;
    // SDK settings_sources/thinking probes are not prerequisites for them.
    const kind = runnerSelection.runner.kind;
    const keyRef = kind === 'openrouter' ? config.openrouter.api_key_env : config.deepseek.api_key_env;
    runtime = process.env[keyRef]
      ? { status: 'ok', detail: `runner=${kind}; 本地请求入口已配置；本查询未探测供应商可用性` }
      : { status: 'blocked', detail: 'MODEL_CREDENTIAL_UNAVAILABLE' };
  } else {
    const capabilityState = capabilities.overall();
    runtime = { status: capabilityState === 'verified' ? 'ok' : capabilityState,
      detail: `runner=${runnerSelection.runner.kind}; SDK capabilities=${capabilityState}` };
  }

  let archive: HealthComponent = { status: 'disabled', detail: '归档未启用；原文仍保存在本地' };
  if (config.archive.enabled) {
    try {
      archive = opts.archiveSync?.health() ?? { status: 'blocked', detail: 'ARCHIVE_WORKER_UNAVAILABLE' };
    } catch {
      archive = { status: 'degraded', detail: 'ARCHIVE_STATE_UNAVAILABLE' };
    }
  }
  const push: HealthComponent = config.notifications.remote_enabled
    ? { status: 'unknown', detail: '远程推送已启用，但未取得可用性证据' }
    : { status: 'disabled', detail: '可选远程推送已关闭；在线投递走 SSE' };

  let dbComp: HealthComponent;
  try {
    db.prepare('SELECT 1').get();
    dbComp = { status: 'ok', detail: `schema v${schemaVersion(db)}` };
  } catch {
    dbComp = { status: 'degraded', detail: 'DATABASE_UNAVAILABLE' };
  }
  const components = { identity, runtime, archive, push, db: dbComp };
  const status = Object.values(components).every(c => c.status === 'ok' || c.status === 'disabled') ? 'ready' : 'degraded';
  return { status, components };
}
