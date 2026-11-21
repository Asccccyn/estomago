#!/usr/bin/env node
// Offline only. Review the JSON from plan-image-creation-migration.mjs first.
// node --experimental-strip-types scripts/apply-image-creation-migration.mjs <host> <content> --plan <reviewed.json> --into <new-directory>
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { backup } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { creationReferenceSnapshot, openContentDatabase } from '../apps/content/src/service.ts';
import { migrateRasterCreationInTx } from '../apps/content/src/raster-creation-migration.ts';
import { buildConfig } from '../apps/host/src/config/schema.ts';
import { openDatabase, tx } from '../apps/host/src/db/connection.ts';
import { ContentOperationCoordinator } from '../apps/host/src/integrations/content/coordinator.ts';
import { MediaService } from '../apps/host/src/media/assets.ts';
import { Logger } from '../apps/host/src/observability/logging.ts';
import { buildImageCreationPlan, openSnapshot } from './plan-image-creation-migration.mjs';

async function apply(hostSource, contentSource, reviewedPlan, destination) {
  const absolute = resolve(destination);
  const parent = realpathSync(dirname(absolute));
  const output = join(parent, basename(absolute));
  const production = join(realpathSync(homedir()), 'Library', 'Application Support', 'estomago');
  const productionRoot = existsSync(production) ? realpathSync(production) : production;
  if (output === productionRoot || output.startsWith(productionRoot + sep)) throw new Error('RASTER_MIGRATION_PRODUCTION_DESTINATION');
  if (existsSync(output)) throw new Error('RASTER_MIGRATION_DESTINATION_EXISTS');

  let sourceHost, sourceContent, host, content, staging;
  try {
    sourceHost = openSnapshot(hostSource);
    sourceContent = openSnapshot(contentSource);
    const current = buildImageCreationPlan(sourceHost, sourceContent);
    if (!isDeepStrictEqual(current, JSON.parse(readFileSync(reviewedPlan, 'utf8')))) {
      throw new Error('RASTER_MIGRATION_REVIEWED_PLAN_CHANGED');
    }

    staging = mkdtempSync(join(parent, '.raster-migration-'));
    const dataDir = join(staging, 'data');
    const contentDir = join(staging, 'content');
    mkdirSync(dataDir);
    mkdirSync(contentDir);
    await backup(sourceHost, join(dataDir, 'chat.sqlite3'));
    await backup(sourceContent, join(contentDir, 'content.sqlite3'));
    host = openDatabase(dataDir);
    content = openContentDatabase(contentDir);
    if (!isDeepStrictEqual(current, buildImageCreationPlan(host, content))) {
      throw new Error('RASTER_MIGRATION_COPY_CHANGED');
    }

    const candidates = current.items.filter(item => item.action === 'propose_album_entry' || item.action === 'already_linked');
    const now = new Date().toISOString();
    const snapshots = tx(content, () => candidates.map(item => migrateRasterCreationInTx(content, item, now)));
    const coordinator = new ContentOperationCoordinator({
      db: host, client: { baseUrl: 'offline:', token: '' },
      media: new MediaService(host, dataDir, buildConfig({})), logger: new Logger(null),
    });
    for (const snapshot of [...snapshots, ...candidates.map(item => creationReferenceSnapshot(content, item.creation_id))]) {
      coordinator.reconcileKnownOwnerSnapshot(snapshot.owner_type, snapshot.owner_id, snapshot);
      const ref = host.prepare(`
        SELECT 1 FROM asset_external_refs
        WHERE asset_id=? AND owner_service='content' AND owner_type=? AND owner_id=?
          AND owner_revision=? AND operation_id=? AND state='committed'
      `).get(snapshot.asset_ids[0], snapshot.owner_type, snapshot.owner_id, snapshot.owner_revision,
        `owner:${snapshot.owner_type}:${snapshot.owner_id}`);
      if (!ref) throw new Error('RASTER_MIGRATION_REFERENCE_UNCONFIRMED');
    }
    for (const db of [host, content]) {
      if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
        || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('RASTER_MIGRATION_DATABASE_CHECK_FAILED');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    host.close();
    host = undefined;
    content.close();
    content = undefined;
    if (existsSync(output)) throw new Error('RASTER_MIGRATION_DESTINATION_EXISTS');
    renameSync(staging, output);
    staging = undefined;
    return { mode: 'offline-copy', applied: snapshots.length, created_album_entries: candidates.filter(item => item.action === 'propose_album_entry').length,
      counts_before: current.counts, items: snapshots.map((snapshot, index) => ({
        creation_id: candidates[index].creation_id, album_entry_id: snapshot.owner_id, asset_id: snapshot.asset_ids[0],
      })) };
  } finally {
    content?.close();
    host?.close();
    sourceContent?.close();
    sourceHost?.close();
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.length !== 6 || args[2] !== '--plan' || args[4] !== '--into' || [0, 1, 3, 5].some(index => args[index].startsWith('--'))) {
  console.error('用法：node --experimental-strip-types scripts/apply-image-creation-migration.mjs <host-backup.sqlite3> <content-backup.sqlite3> --plan <reviewed.json> --into <new-directory>');
  process.exitCode = 2;
} else {
  try {
    const result = await apply(args[0], args[1], args[3], args[5]);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('离线迁移失败：' + error.message);
    process.exitCode = 1;
  }
}
