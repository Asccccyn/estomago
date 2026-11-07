// G5 真实存量回填（2026-11-07，用户授权本轮执行）：
// 对每个 content owner 走 ContentOperationCoordinator.reconcileOwner —— 与正常写同一
// 确认路径（live 权威快照 → 单调准入 → content_owner_state 版本锚 + committed 引用 +
// pin 收口）。不直接 SQL 改行、不重放业务写、不动 13 条旧回执。
// 用法：node scripts/content-stock-backfill.mjs --home <stateRoot> --prod [--dry]
//   owner 清单来自 content 库只读枚举（正本）；确认经生产 content 服务 HTTP。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const homeArg = args[args.indexOf('--home') + 1];
const home = homeArg || path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const isProd = home === path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
if (isProd && !args.includes('--prod')) { console.error('生产根必须 --prod'); process.exit(1); }
const dry = args.includes('--dry');

const tokenFile = path.join(home, 'content', 'service.token');
const token = fs.readFileSync(tokenFile, 'utf8').trim();
// content 服务端口：与宿主配置同源（config.yaml content.port）
const { loadConfig } = await import('../apps/host/src/config/load.ts');
const { buildPaths, resolveStateRoot } = await import('../apps/host/src/config/paths.ts');
const paths = buildPaths(resolveStateRoot(home));
const { config } = loadConfig({ argv: [], paths });
const contentPort = config.content.port;

const contentDb = new DatabaseSync(path.join(home, 'content', 'content.sqlite3'), { readOnly: true });
const owners = [];
for (const t of ['feed_posts', 'feed_comments', 'creations', 'future_notes']) {
  const rows = contentDb.prepare(`SELECT id FROM ${t}`).all();
  for (const r of rows) owners.push({ type: t === 'feed_posts' ? 'post' : t === 'feed_comments' ? 'comment' : t === 'creations' ? 'creation' : 'future_note', id: r.id });
}
// 相册表在 schema v1→v2 迁移后仍名 album_entries
for (const r of contentDb.prepare('SELECT id FROM album_entries').all()) owners.push({ type: 'album_entry', id: r.id });
contentDb.close();

const { ContentOperationCoordinator } = await import('../apps/host/src/integrations/content/coordinator.ts');
const { MediaService } = await import('../apps/host/src/media/assets.ts');
const { openDatabase } = await import('../apps/host/src/db/connection.ts');
const logger = { info: (...a) => console.log('[backfill]', ...a), warn: (...a) => console.warn('[backfill]', ...a), error: (...a) => console.error('[backfill]', ...a) };

const db = openDatabase(path.join(home, 'data'));
const media = new MediaService(db, paths.mediaDir, config);
const coordinator = new ContentOperationCoordinator({
  db, media, logger,
  client: { baseUrl: `http://127.0.0.1:${contentPort}`, token },
});

const pre = {
  attachments: db.prepare('SELECT COUNT(*) n FROM message_attachments').get().n,
  receipts: new DatabaseSync(path.join(home, 'content', 'content.sqlite3'), { readOnly: true }).prepare('SELECT COUNT(*) n FROM content_receipts').get().n,
};
console.log(JSON.stringify({ owners: owners.length, pre, dry }));

let failures = 0;
for (const o of owners) {
  if (dry) { console.log(`[dry] would reconcile ${o.type}:${o.id}`); continue; }
  try {
    const ok = await coordinator.reconcileOwner(o.type, o.id);
    console.log(`reconcile ${o.type}:${o.id} -> ${ok ? 'confirmed' : 'snapshot-unreachable'}`);
    if (!ok) failures++;
  } catch (err) {
    failures++;
    console.error(`reconcile ${o.type}:${o.id} FAILED: ${String(err?.message ?? err).slice(0, 160)}`);
  }
}
if (!dry) {
  const post = {
    ownerState: db.prepare('SELECT owner_type, owner_id, applied_revision, deleted, asset_ids_json FROM content_owner_state ORDER BY owner_id').all(),
    committedRefs: db.prepare("SELECT owner_id, asset_id, owner_revision FROM asset_external_refs WHERE owner_service='content' AND owner_type != 'content_operation' AND state='committed' ORDER BY owner_id").all(),
    attachments: db.prepare('SELECT COUNT(*) n FROM message_attachments').get().n,
  };
  const receiptsAfter = new DatabaseSync(path.join(home, 'content', 'content.sqlite3'), { readOnly: true }).prepare('SELECT COUNT(*) n FROM content_receipts').get().n;
  console.log(JSON.stringify({ post, receipts: { before: pre.receipts, after: receiptsAfter } }, null, 2));
}
db.close();
if (failures > 0) { console.error(`[backfill] ${failures} owner(s) failed`); process.exit(1); }
