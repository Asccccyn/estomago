#!/usr/bin/env node
// Explicit maintenance for rejected archive dependency batches; never calls a model.
// Use the host's existing archive credential environment. Stop the host before --apply.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { resolveStateRoot, buildPaths } from '../apps/host/src/config/paths.ts';
import { loadConfig } from '../apps/host/src/config/load.ts';
import { acquireInstanceLock } from '../apps/host/src/runtime/instance-lock.ts';
import { MariposaClient } from '../apps/host/src/integrations/mariposa/client.ts';
import { planArchiveDependencyRepair, applyArchiveDependencyRepair, ArchiveDependencyRepairError } from '../apps/host/src/integrations/mariposa/archive-repair.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/archive-repair-dependencies.mjs --conversation <id> [--apply]');
  console.log('Default: read-only plan and source.ingest.status queries. --apply requires the host stopped, backs up SQLite, verifies original rejections, and stages repaired batches. Restart the host to send them.');
  process.exit(0);
}
const index = args.indexOf('--conversation');
const conversationId = index >= 0 ? args[index + 1] : null;
if (!conversationId || conversationId.startsWith('--') || args.some((arg, i) => i !== index + 1 && !['--conversation', '--apply'].includes(arg))) {
  console.error('REPAIR_ARGUMENTS_INVALID');
  process.exit(2);
}
const apply = args.includes('--apply');
const paths = buildPaths(resolveStateRoot(process.env.ESTOMAGO_HOME));
let lock;
let db;
try {
  const { config } = loadConfig({ paths });
  const credentialEnv = config.integrations.mariposa.archive_credential_ref;
  if (!config.archive.enabled || !config.integrations.mariposa.base_url || !credentialEnv || !process.env[credentialEnv]) {
    throw new ArchiveDependencyRepairError('REPAIR_ARCHIVE_CONFIGURATION_REQUIRED');
  }
  if (apply) lock = acquireInstanceLock(paths.stateRoot);
  db = new DatabaseSync(path.join(paths.dataDir, 'chat.sqlite3'), { readOnly: !apply });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (apply) {
    const active = db.prepare("SELECT COUNT(*) n FROM turns WHERE state IN ('pending','running','route_owner_pending')").get();
    if (active.n > 0) throw new ArchiveDependencyRepairError('REPAIR_ACTIVE_TURNS');
    fs.mkdirSync(paths.backupsDir, { recursive: true });
    const destination = path.join(paths.backupsDir, `archive-dependency-${new Date().toISOString().replaceAll(':', '-')}.sqlite3`);
    await backup(db, destination);
    fs.chmodSync(destination, 0o600);
    console.log(JSON.stringify({ event: 'archive_repair_backup', path: destination }));
  }
  const client = new MariposaClient({ baseUrl: config.integrations.mariposa.base_url, credentialEnv });
  const plan = await planArchiveDependencyRepair({ db, client, conversationId });
  console.log(JSON.stringify({ event: 'archive_repair_plan', mode: apply ? 'apply' : 'dry_run', original_batches: plan.originalOperations.length,
    repaired_batches: plan.batches.length, message_revisions: plan.messageRevisions, snapshot_hash: plan.snapshotHash }));
  if (apply && plan.messageRevisions > 0) {
    const result = await applyArchiveDependencyRepair({ db, client, plan, sendersPaused: true });
    console.log(JSON.stringify({ event: 'archive_repair_staged', ...result }));
  }
} catch (error) {
  const code = error instanceof ArchiveDependencyRepairError ? error.code
    : String(error?.message ?? '').startsWith('INSTANCE_LOCK_HELD') ? 'INSTANCE_LOCK_HELD' : 'REPAIR_RUNTIME_ERROR';
  console.error(JSON.stringify({ event: 'archive_repair_failed', code }));
  process.exitCode = 1;
} finally {
  db?.close();
  lock?.release();
}
