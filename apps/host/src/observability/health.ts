// /health/live 与 /health/ready（01 §17/§18.1）：ready 分项报告 identity、runtime、
// archive、push、db；Host 活着不代表 SDK 可用。公网不返回敏感配置。
import type { Config } from '../config/schema.ts';
import type { CapabilityMatrix } from '../runtime/capabilities.ts';
import type { RunnerSelection } from '../runtime/runner.ts';
import type { GateResult } from '../identity/service.ts';
import type { ReadyReport } from '../../../../packages/contracts/src/api.ts';
import { schemaVersion } from '../db/migrations.ts';
import type { Db } from '../db/connection.ts';

export function buildReadyReport(opts: {
  config: Config;
  gate: GateResult;
  runnerSelection: RunnerSelection;
  capabilities: CapabilityMatrix;
  db: Db;
}): ReadyReport {
  const { config, gate, runnerSelection, capabilities, db } = opts;

  const identity = gate.state === 'READY' ? { status: 'ok', detail: 'manifest APPROVED 且 hash 匹配' } : { status: 'blocked', detail: gate.reasons.join('; ') };

  const runtimeDetail =
    runnerSelection.status === 'blocked'
      ? runnerSelection.reasons.join('; ')
      : `runner=${runnerSelection.runner.kind}; capabilities=${capabilities.overall()}`;
  const runtime =
    runnerSelection.status === 'blocked' || capabilities.overall() !== 'verified'
      ? { status: runnerSelection.status === 'blocked' ? 'blocked' : 'unknown', detail: runtimeDetail }
      : { status: 'ok', detail: runtimeDetail };

  const archive = config.archive.enabled
    ? { status: 'unknown', detail: 'archive.enabled=true 但 Mariposa 契约未接入（base_url=null）' }
    : { status: 'disabled', detail: '归档未启用：消息保存在本地聊天库，不假报已归档到记忆库' };

  const push = config.notifications.remote_enabled
    ? { status: 'unknown', detail: 'remote_enabled=true 但 provider 未配置/未实测' }
    : { status: 'disabled', detail: '离线推送未启用；在线投递走 SSE' };

  let dbComp = { status: 'ok', detail: `schema v${schemaVersion(db)}` };
  try {
    db.prepare('SELECT 1').get();
  } catch (err) {
    dbComp = { status: 'degraded', detail: (err as Error).message };
  }

  const components = { identity, runtime, archive, push, db: dbComp };
  // runtime 未知也算 degraded：Host 活着 ≠ SDK 可用（18.1），不冒充 ready
  const status =
    Object.values(components).some((c) => c.status === 'blocked' || c.status === 'degraded') || runtime.status === 'unknown'
      ? 'degraded'
      : 'ready';
  return { status, components };
}
