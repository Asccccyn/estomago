#!/usr/bin/env node
// 根据已授权的成对 SQLite 备份，列出可审阅的旧图片作品迁移计划。
// 用法：node scripts/plan-image-creation-migration.mjs <host-backup.sqlite3> <content-backup.sqlite3>
import { existsSync, realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const RASTER_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PHOTO_ALBUM = 'important_photos';

export function openSnapshot(filename) {
  const path = realpathSync(filename);
  if (!statSync(path).isFile()) throw new Error('输入必须是 SQLite 备份文件');
  const wal = `${path}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    throw new Error('备份仍依赖 WAL，请以 SQLite 备份流程取得完整独立快照');
  }
  const uri = pathToFileURL(path);
  uri.searchParams.set('mode', 'ro');
  uri.searchParams.set('immutable', '1');
  return new DatabaseSync(uri.href, { readOnly: true });
}

function confirmedHash(asset) {
  return asset?.state === 'available' && asset.m_sync_state === 'synced'
    && /^[0-9a-f]{64}$/.test(asset.m_content_hash ?? '') && asset.m_content_hash === asset.content_sha256
    ? asset.m_content_hash : null;
}

function append(map, key, row) {
  const group = map.get(key);
  if (group) group.push(row);
  else map.set(key, [row]);
}

function planMigration(host, content) {
  const assets = new Map(host.prepare(`
    SELECT id, state, mime_type, content_sha256, m_sync_state, m_content_hash, origin_service, origin_ref, ingest_purpose, creation_operation_id FROM media_assets
  `).all().map(asset => [asset.id, asset]));
  const staticViews = new Map([...assets.values()].filter(asset =>
    asset.origin_service === 'estomago_static_svg' && asset.ingest_purpose === 'derived_view' &&
    asset.creation_operation_id === `static-svg-view-v1:${asset.origin_ref}` &&
    asset.mime_type === 'image/png' && confirmedHash(asset)).map(asset => [asset.origin_ref, asset]));
  const creations = content.prepare(`
    SELECT id, creator_actor, bucket_id, icon_asset_id, work_asset_id, work_kind, created_at, revision
    FROM creations WHERE deleted_at IS NULL ORDER BY created_at, id
  `).all();
  const albumsByAsset = new Map();
  const albumsByHash = new Map();
  const hasAlbumHash = content.prepare('PRAGMA table_info(album_entries)').all().some(column => column.name === 'content_sha256');
  for (const entry of content.prepare(`
    SELECT id, asset_id, revision, deleted_at, added_by_actor, created_at, ${hasAlbumHash ? 'content_sha256' : 'NULL AS content_sha256'} FROM album_entries WHERE kind=?
  `).iterate(PHOTO_ALBUM)) {
    append(albumsByAsset, entry.asset_id, entry);
    const hash = confirmedHash(assets.get(entry.asset_id));
    if (hash) append(albumsByHash, hash, entry);
  }
  const sourceLinks = new Set(content.prepare(`
    SELECT entry_id, source_id FROM album_entry_refs WHERE service='est' AND kind='creation'
  `).all().map(ref => JSON.stringify([ref.entry_id, ref.source_id])));
  const migrated = new Map();
  if (content.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='raster_creation_album_migrations'").get()) {
    for (const row of content.prepare(`
      SELECT m.creation_id,m.album_entry_id,a.revision,a.deleted_at
      FROM raster_creation_album_migrations m JOIN album_entries a ON a.id=m.album_entry_id
    `).iterate()) migrated.set(row.creation_id, row);
  }
  const sharedImageAssets = new Map();
  for (const creation of creations) {
    if ((creation.work_kind === 'image' || (creation.work_kind === 'svg' && staticViews.has(creation.work_asset_id))) && creation.work_asset_id) {
      const hash = confirmedHash(assets.get(creation.work_asset_id));
      append(sharedImageAssets, hash ?? creation.work_asset_id, creation.id);
    }
  }
  const attachmentCount = host.prepare('SELECT count(*) AS n FROM message_attachments WHERE asset_id=?');

  return creations.map(creation => {
    const source = {
      creation_id: creation.id, revision: creation.revision, creator_actor: creation.creator_actor,
      created_at: creation.created_at, work_kind: creation.work_kind, asset_id: creation.work_asset_id,
    };
    const asset = assets.get(creation.work_asset_id);
    const view = asset?.mime_type === 'image/svg+xml' ? staticViews.get(asset.id) : undefined;
    if (creation.work_kind === 'video' || (creation.work_kind === 'svg' && !view)) return { ...source, action: 'review_original_format' };
    if (creation.work_kind !== 'image' && creation.work_kind !== 'svg') return { ...source, action: 'keep_creation' };
    if (!asset || asset.state !== 'available') return { ...source, action: 'asset_unavailable' };
    if (!RASTER_MIME_TYPES.has(asset.mime_type) && !view) return { ...source, mime_type: asset.mime_type, action: 'review_original_format' };
    const hash = confirmedHash(asset);
    if (!hash) return { ...source, action: 'master_unconfirmed' };

    const evidence = { ...source, mime_type: asset.mime_type, master_hash: hash, message_attachments: attachmentCount.get(asset.id).n,
      ...(view ? { visual_asset_id: view.id, visual_master_hash: confirmedHash(view) } : {}) };
    const previous = migrated.get(creation.id);
    if (previous) return { ...evidence, action: 'already_migrated', album_entry_id: previous.album_entry_id,
      album_entry_revision: previous.revision, album_entry_removed: previous.deleted_at !== null };
    if (creation.bucket_id !== null || creation.icon_asset_id !== asset.id
      || (sharedImageAssets.get(hash)?.length ?? 0) > 1) {
      return { ...evidence, action: 'review_additional_creation_metadata' };
    }
    const entries = albumsByAsset.get(asset.id) ?? [];
    const active = entries.find(entry => entry.deleted_at === null);
    if (active) {
      const linked = (active.content_sha256 === null || active.content_sha256 === hash)
        && sourceLinks.has(JSON.stringify([active.id, creation.id]));
      return { ...evidence, action: linked ? 'already_linked' : 'review_existing_album_entry', album_entry_id: active.id, album_entry_revision: active.revision,
        album_entry_added_by: active.added_by_actor, album_entry_created_at: active.created_at };
    }
    if (entries.length > 0) return { ...evidence, action: 'preserve_album_removal' };
    const aliases = (albumsByHash.get(hash) ?? []).filter(entry => entry.asset_id !== asset.id);
    if (aliases.length > 0) return { ...evidence, action: 'review_album_alias', album_entry_ids: aliases.map(entry => entry.id) };
    return { ...evidence, action: 'propose_album_entry', album_kind: PHOTO_ALBUM, source_ref: { service: 'est', kind: 'creation', source_id: creation.id } };
  });
}

export function buildImageCreationPlan(host, content) {
  const items = planMigration(host, content);
  const counts = {};
  for (const item of items) counts[item.action] = (counts[item.action] ?? 0) + 1;
  return { mode: 'dry-run', counts, items };
}

function run(inputs) {
  if (inputs.length !== 2 || inputs.some(input => input.startsWith('--'))) {
    console.error('用法：node scripts/plan-image-creation-migration.mjs <host-backup.sqlite3> <content-backup.sqlite3>');
    process.exitCode = 2;
    return;
  }
  let host;
  let content;
  try {
    host = openSnapshot(inputs[0]);
    content = openSnapshot(inputs[1]);
    console.log(JSON.stringify(buildImageCreationPlan(host, content), null, 2));
  } catch (error) {
    console.error(`无法生成迁移计划：${error.message}`);
    process.exitCode = 1;
  } finally {
    content?.close();
    host?.close();
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) run(process.argv.slice(2));
