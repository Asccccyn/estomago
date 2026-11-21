import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { albumReferenceSnapshot, type Actor } from './service.ts';

type MigrationEvidence = {
  creation_id: string;
  revision: number;
  creator_actor: Actor;
  created_at: string;
  asset_id: string;
  master_hash: string;
  work_kind: 'image' | 'svg';
};

export type RasterMigrationEntry = MigrationEvidence & (
  | { action: 'propose_album_entry' }
  | { action: 'already_linked'; album_entry_id: string; album_entry_revision: number }
  | { action: 'link_reviewed_existing_entry'; album_entry_id: string; album_entry_revision: number; album_entry_added_by: Actor; album_entry_created_at: string }
);

const PHOTO_ALBUM = 'important_photos';

function stableId(prefix: string, creationId: string, assetId: string): string {
  const hash = createHash('sha256').update(JSON.stringify([prefix, creationId, assetId])).digest('hex');
  return `${prefix}_${hash.slice(0, 32)}`;
}

/** Apply one reviewed, host-verified raster row in the isolated content copy. */
export function migrateRasterCreationInTx(db: DatabaseSync, entry: RasterMigrationEntry, migratedAt: string) {
  if (!/^[a-f0-9]{64}$/.test(entry.master_hash)) throw new Error('RASTER_MIGRATION_MASTER_UNCONFIRMED');
  const creation = db.prepare(`
    SELECT 1 FROM creations WHERE id=? AND revision=? AND creator_actor=? AND created_at=?
    AND deleted_at IS NULL AND work_kind=? AND work_asset_id=?
    AND bucket_id IS NULL AND icon_asset_id=work_asset_id
  `).get(entry.creation_id, entry.revision, entry.creator_actor, entry.created_at, entry.work_kind, entry.asset_id);
  if (!creation) throw new Error('RASTER_MIGRATION_CREATION_CHANGED');

  const recorded = db.prepare(`
    SELECT album_entry_id,source_revision FROM raster_creation_album_migrations WHERE creation_id=?
  `).get(entry.creation_id) as { album_entry_id: string; source_revision: number } | undefined;
  if (recorded) {
    if (recorded.source_revision !== entry.revision) throw new Error('RASTER_MIGRATION_REVISION_CONFLICT');
    return albumReferenceSnapshot(db, recorded.album_entry_id);
  }

  let albumEntryId: string;
  if (entry.action === 'already_linked') {
    const linked = db.prepare(`
      SELECT 1 FROM album_entries a JOIN album_entry_refs r ON r.entry_id=a.id
      WHERE a.id=? AND a.revision=? AND a.kind=? AND a.asset_id=? AND a.deleted_at IS NULL
      AND (a.content_sha256 IS NULL OR a.content_sha256=?)
      AND r.service='est' AND r.kind='creation' AND r.source_id=?
    `).get(entry.album_entry_id, entry.album_entry_revision, PHOTO_ALBUM, entry.asset_id, entry.master_hash, entry.creation_id);
    if (!linked) throw new Error('RASTER_MIGRATION_ALBUM_CHANGED');
    albumEntryId = entry.album_entry_id;
  } else if (entry.action === 'link_reviewed_existing_entry') {
    const active = db.prepare(`
      SELECT 1 FROM album_entries WHERE id=? AND revision=? AND kind=? AND asset_id=? AND deleted_at IS NULL
        AND added_by_actor=? AND created_at=? AND (content_sha256 IS NULL OR content_sha256=?)
    `).get(entry.album_entry_id, entry.album_entry_revision, PHOTO_ALBUM, entry.asset_id,
      entry.album_entry_added_by, entry.album_entry_created_at, entry.master_hash);
    const conflicting = db.prepare("SELECT 1 FROM album_entry_refs WHERE service='est' AND kind='creation' AND source_id=?").get(entry.creation_id);
    if (!active || conflicting) throw new Error('RASTER_MIGRATION_ALBUM_CHANGED');
    albumEntryId = entry.album_entry_id;
    db.prepare(`
      INSERT INTO album_entry_refs(id,entry_id,service,kind,source_id,created_at) VALUES(?,?,'est','creation',?,?)
    `).run(stableId('aer', entry.creation_id, entry.asset_id), albumEntryId, entry.creation_id, migratedAt);
    // Association-only repair: keep original membership time, user note, carry mode and last-edit time.
    db.prepare('UPDATE album_entries SET revision=revision+1, content_sha256=COALESCE(content_sha256,?) WHERE id=?')
      .run(entry.master_hash, albumEntryId);
  } else {
    const other = db.prepare('SELECT 1 FROM album_entries WHERE kind=? AND (asset_id=? OR content_sha256=?)')
      .get(PHOTO_ALBUM, entry.asset_id, entry.master_hash);
    if (other) throw new Error('RASTER_MIGRATION_ALBUM_CHANGED');
    albumEntryId = stableId('ae', entry.creation_id, entry.asset_id);
    db.prepare(`
      INSERT INTO album_entries(id,kind,asset_id,added_by_actor,created_at,updated_at,revision,carry_mode,content_sha256)
      VALUES(?,?,?,?,?,?,1,'none',?)
    `).run(albumEntryId, PHOTO_ALBUM, entry.asset_id, entry.creator_actor, entry.created_at, migratedAt, entry.master_hash);
    db.prepare(`
      INSERT INTO album_entry_refs(id,entry_id,service,kind,source_id,created_at) VALUES(?,?,'est','creation',?,?)
    `).run(stableId('aer', entry.creation_id, entry.asset_id), albumEntryId, entry.creation_id, migratedAt);
  }
  db.prepare(`
    INSERT INTO raster_creation_album_migrations(creation_id,album_entry_id,source_revision,migrated_at) VALUES(?,?,?,?)
  `).run(entry.creation_id, albumEntryId, entry.revision, migratedAt);
  return albumReferenceSnapshot(db, albumEntryId);
}
