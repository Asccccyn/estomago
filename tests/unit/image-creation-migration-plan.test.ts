import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ContentServer } from '../../apps/content/src/service.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';

test('图片作品离线迁移保留老引用、不复活墓碑，并可重复运行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'est-image migration-'));
  const hostDir = path.join(dir, 'host');
  const contentDir = path.join(dir, 'content');
  const hostPath = path.join(hostDir, 'chat.sqlite3');
  const contentPath = path.join(contentDir, 'content.sqlite3');
  const now = '2026-11-20T00:00:00.000Z';

  try {
    const host = openDatabase(hostDir);
    const content = new ContentServer({ stateRoot: contentDir, port: 0, token: 'fixture-only' });
    try {
      migrate(host, sha256Hex);
      const store = { uploadBytes: async (bytes: Uint8Array) => ({ content_hash: sha256Hex(bytes) }) };
      const mediaDir = path.join(dir, 'media');
      const config = buildConfig({});
      const media = new MediaService(host, mediaDir, config, store as never);
      const pending = new MediaService(host, mediaDir, config);
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
      const save = (opKey: string, variant: number, service = media) => service.saveBuffer({
        bytes: Buffer.concat([png, Buffer.from([variant])]), operationId: opKey,
        createdBy: 'jiaming', origin: 'generated', purpose: 'creation_work',
      });
      const planned = await save('planned', 1);
      const linked = await save('linked', 2);
      const removed = await save('removed', 3);
      const alias = await save('alias', 4);
      const existingOtherAlias = await save('existing-alias', 4);
      const unconfirmed = await save('pending', 5, pending);
      const reviewed = await save('reviewed', 6);
      const svg = await media.saveBuffer({
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        operationId: 'svg', createdBy: 'jiaming', origin: 'generated', purpose: 'creation_icon',
      });
      const svgReady = await media.saveBuffer({
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="250" height="150"><text x="10" y="80" font-size="32">Static fixture</text></svg>'),
        operationId: 'svg-static', createdBy: 'jiaming', origin: 'generated', purpose: 'creation_icon',
      });
      assert.equal((await media.ensureStaticSvgView(svgReady.id)).id, svgReady.id);
      await media.ensureStaticSvgView(svgReady.id);
      assert.equal(media.canProvideImage(svgReady), true);
      const insertCreation = content.db.prepare(`
        INSERT INTO creations(id, creator_actor, title, icon_asset_id, work_asset_id, work_kind, created_at, updated_at, revision)
        VALUES (?, 'jiaming', 'sensitive fixture title', ?, ?, ?, ?, ?, 1)
      `);
      for (const [id, asset] of [['planned', planned], ['linked', linked], ['removed', removed], ['alias', alias], ['pending', unconfirmed], ['reviewed', reviewed]] as const) {
        insertCreation.run(id, asset.id, asset.id, 'image', now, now);
      }
      insertCreation.run('svg', svg.id, svg.id, 'svg', now, now);
      insertCreation.run('svg-ready', svgReady.id, svgReady.id, 'svg', now, now);
      const addAlbum = content.db.prepare(`
        INSERT INTO album_entries(id, kind, asset_id, added_by_actor, created_at, updated_at, revision, deleted_at)
        VALUES (?, 'important_photos', ?, 'jiaming', ?, ?, 1, ?)
      `);
      addAlbum.run('existing', linked.id, now, now, null);
      addAlbum.run('tombstone', removed.id, now, now, now);
      addAlbum.run('other-alias', existingOtherAlias.id, now, now, null);
      addAlbum.run('reviewed-entry', reviewed.id, now, now, null);
      content.db.prepare("UPDATE album_entries SET caption='fixture note',carry_mode='always' WHERE id='reviewed-entry'").run();
      content.db.prepare(`INSERT INTO album_entry_refs(id, entry_id, service, kind, source_id, created_at)
        VALUES ('source-link', 'existing', 'est', 'creation', 'linked', ?)`).run(now);
    } finally {
      await content.stop();
      host.close();
    }

    const databaseHash = () => [hostPath, contentPath].map(filename => sha256Hex(fs.readFileSync(filename)));
    const before = databaseHash();
    const script = path.resolve('scripts/plan-image-creation-migration.mjs');
    const result = spawnSync(process.execPath, [script, hostPath, contentPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('sensitive fixture title'), false);
    const plan = JSON.parse(result.stdout) as { mode: string; items: Array<{ creation_id: string; action: string; master_hash?: string; source_ref?: unknown }> };
    assert.equal(plan.mode, 'dry-run');
    const byId = Object.fromEntries(plan.items.map(item => [item.creation_id, item]));
    assert.deepEqual(Object.fromEntries(plan.items.map(item => [item.creation_id, item.action])), {
      alias: 'review_album_alias', linked: 'already_linked', pending: 'master_unconfirmed',
      planned: 'propose_album_entry', removed: 'preserve_album_removal', svg: 'review_original_format',
      reviewed: 'review_existing_album_entry', 'svg-ready': 'propose_album_entry',
    });
    assert.match(byId.planned!.master_hash!, /^[0-9a-f]{64}$/);
    assert.deepEqual(byId.planned!.source_ref, { service: 'est', kind: 'creation', source_id: 'planned' });

    const forbidden = spawnSync(process.execPath, [script, hostPath, contentPath, '--apply'], { encoding: 'utf8' });
    assert.equal(forbidden.status, 2, forbidden.stderr);
    assert.deepEqual(databaseHash(), before);

    const applyScript = path.resolve('scripts/apply-image-creation-migration.mjs');
    const planPath = path.join(dir, 'reviewed.json');
    const destination = path.join(dir, 'derived');
    const apply = (hostFile: string, contentFile: string, output: string) => spawnSync(process.execPath, [
      '--experimental-strip-types', '--experimental-transform-types', applyScript, hostFile, contentFile,
      '--plan', planPath, '--into', output,
    ], { encoding: 'utf8' });
    fs.writeFileSync(planPath, JSON.stringify({ ...plan, items: [] }));
    const stale = apply(hostPath, contentPath, destination);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /RASTER_MIGRATION_REVIEWED_PLAN_CHANGED/);
    assert.equal(fs.existsSync(destination), false);
    fs.writeFileSync(planPath, JSON.stringify({ ...plan, approved_existing_links: ['alias'] }));
    const invalidApproval = apply(hostPath, contentPath, destination);
    assert.equal(invalidApproval.status, 1);
    assert.match(invalidApproval.stderr, /RASTER_MIGRATION_LINK_APPROVAL_INVALID/);
    assert.equal(fs.existsSync(destination), false);
    fs.writeFileSync(planPath, JSON.stringify({ ...plan, approved_existing_links: ['reviewed'] }));
    const applied = apply(hostPath, contentPath, destination);
    assert.equal(applied.status, 0, applied.stderr);
    const report = JSON.parse(applied.stdout) as { applied: number; created_album_entries: number; attached_existing_entries: number;
      items: Array<{ creation_id: string; album_entry_id: string; asset_id: string }> };
    assert.equal(report.applied, 4);
    assert.equal(report.created_album_entries, 2);
    assert.equal(report.attached_existing_entries, 1);
    const converted = report.items.find(item => item.creation_id === 'planned')!;
    assert.equal(report.items.find(item => item.creation_id === 'linked')?.album_entry_id, 'existing');
    assert.equal(report.items.find(item => item.creation_id === 'reviewed')?.album_entry_id, 'reviewed-entry');
    assert.deepEqual(databaseHash(), before, '两份输入备份均未变更');

    const derivedHost = path.join(destination, 'data', 'chat.sqlite3');
    const derivedContent = path.join(destination, 'content', 'content.sqlite3');
    const hostCopy = new DatabaseSync(derivedHost, { readOnly: true });
    const copiedContent = new ContentServer({ stateRoot: path.dirname(derivedContent), port: 0, token: 'fixture-only' });
    const handle = copiedContent as unknown as {
      handle(req: unknown, res: { writeHead(status: number): void; end(body: string): void }): Promise<void>;
    };
    async function request(method: string, route: string, headers: Record<string, string> = {}) {
      const req = Object.assign(Readable.from([]), { method, url: route,
        headers: { authorization: 'Bearer fixture-only', 'x-actor': 'jiaming', ...headers } });
      let status = 0;
      let body: Record<string, unknown> = {};
      await handle.handle(req, { writeHead: code => { status = code; }, end: text => { body = JSON.parse(text); } });
      return { status, body };
    }
    try {
      assert.equal((hostCopy.prepare("SELECT COUNT(*) n FROM media_assets").get() as { n: number }).n, 10);
      assert.ok(hostCopy.prepare(`
        SELECT 1 FROM asset_external_refs WHERE owner_type='album_entry' AND owner_id=? AND asset_id=? AND state='committed'
      `).get(converted.album_entry_id, converted.asset_id));
      assert.ok(hostCopy.prepare(`
        SELECT 1 FROM asset_external_refs WHERE owner_type='creation' AND owner_id='planned' AND asset_id=? AND state='committed'
      `).get(converted.asset_id));
      const moved = await request('GET', '/api/v1/content/albums/important_photos/entries?source_service=est&source_kind=creation&source_id=planned');
      const entry = (moved.body.items as Array<Record<string, unknown>>)[0]!;
      assert.equal(entry.id, converted.album_entry_id);
      assert.equal(entry.asset_id, converted.asset_id);
      assert.equal(entry.added_by, 'jiaming');
      assert.equal(entry.created_at, now);
      const linkedEntry = copiedContent.db.prepare("SELECT * FROM album_entries WHERE id='reviewed-entry'").get()!;
      assert.equal(linkedEntry.caption, 'fixture note');
      assert.equal(linkedEntry.carry_mode, 'always');
      assert.equal(linkedEntry.created_at, now);
      assert.equal(linkedEntry.updated_at, now);
      assert.equal(linkedEntry.revision, 2);
      assert.ok(copiedContent.db.prepare("SELECT 1 FROM album_entry_refs WHERE entry_id='reviewed-entry' AND service='est' AND kind='creation' AND source_id='reviewed'").get());
      const visibleWorks = async () => (await request('GET', '/api/v1/content/creations')).body.items as Array<{ id: string }>;
      assert.ok((await visibleWorks()).some(item => item.id === 'svg'));
      assert.ok(!(await visibleWorks()).some(item => item.id === 'svg-ready'));
      const originalSvg = await request('GET', '/api/v1/content/creations/svg-ready');
      assert.equal(originalSvg.body.work_kind, 'svg');
      assert.equal(originalSvg.body.work_asset_id, report.items.find(item => item.creation_id === 'svg-ready')?.asset_id);
      assert.ok(!(await visibleWorks()).some(item => item.id === 'planned' || item.id === 'linked'));
      assert.equal((await request('GET', '/api/v1/content/creations/planned')).body.work_asset_id, converted.asset_id);

      const deleted = await request('DELETE', '/api/v1/content/album-entries/' + converted.album_entry_id,
        { 'idempotency-key': 'remove-converted-album-copy', 'if-match': '"1"' });
      assert.equal(deleted.status, 200);
      assert.ok(!(await visibleWorks()).some(item => item.id === 'planned'), '删除相册不让旧分类复活');
      assert.equal((await request('GET', '/api/v1/content/creations/planned')).body.work_asset_id, converted.asset_id);
    } finally {
      hostCopy.close();
      await copiedContent.stop();
    }

    const rerunPlan = spawnSync(process.execPath, [script, derivedHost, derivedContent], { encoding: 'utf8' });
    assert.equal(rerunPlan.status, 0, rerunPlan.stderr);
    assert.equal(JSON.parse(rerunPlan.stdout).counts.already_migrated, 4);
    fs.writeFileSync(planPath, rerunPlan.stdout);
    const rerun = apply(derivedHost, derivedContent, path.join(dir, 'rerun'));
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(JSON.parse(rerun.stdout).created_album_entries, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
