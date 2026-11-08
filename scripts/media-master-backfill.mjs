// 相册重构 P2（GLM_ALBUM_REFACTOR_EXECUTION 20261108）：存量媒体落正 M 的迁移脚本。
// 对象=media_assets 中 M 正本用途（chat_image/chat_sticker/creation_icon/creation_work/
// derived_view）且 m_sync_state='pending' 的 available 资产；经 M 既有
// prepare/stage/finalize 上传（同 hash 幂等去重），成功后只更新本行 m_* 列——
// 不改消息、附件、引用、索引；不删除任何本地文件（物理清理属 P6 发布窗口，须待
// 正式 release 接管全部消费者后另行执行）。
// 用法：node scripts/media-master-backfill.mjs [--home <stateRoot>] --prod [--apply]
//   默认 dry-run：只清点与校验本地字节可读；--apply 才真实上传。可断点重跑（已 synced
//   行自动跳过；失败行保留 pending 与错误原因）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const homeIdx = args.indexOf('--home');
const homeArg = homeIdx >= 0 ? args[homeIdx + 1] : null;
const home = homeArg || path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
const isProd = home === path.join(os.homedir(), 'Library', 'Application Support', 'estomago');
if (isProd && !args.includes('--prod')) { console.error('生产根必须 --prod'); process.exit(1); }
const apply = args.includes('--apply');

const { loadConfig } = await import('../apps/host/src/config/load.ts');
const { buildPaths, resolveStateRoot } = await import('../apps/host/src/config/paths.ts');
const paths = buildPaths(resolveStateRoot(home));
const { config } = loadConfig({ argv: [], paths });

const baseUrl = config.integrations.mariposa.base_url;
const credentialRef = config.integrations.mariposa.credential_ref;
if (!baseUrl || !credentialRef) { console.error('mariposa base_url/credential_ref 未配置——无法落正 M（如实退出，不猜测端点）'); process.exit(1); }
if (!process.env[credentialRef]) { console.error(`凭据环境变量 ${credentialRef} 未设置`); process.exit(1); }

const { MariposaMediaStore } = await import('../apps/host/src/integrations/mariposa/media-store.ts');
const { openDatabase } = await import('../apps/host/src/db/connection.ts');
const { sha256Hex } = await import('../apps/host/src/util/id.ts');
const store = new MariposaMediaStore({ baseUrl, credentialEnv: credentialRef });

// 注意：本脚本不做 schema 迁移——生产 host 尚在旧 release 时先把库推到 v64 会破坏
// 旧代码的 schema 校验。m_* 列由含 v64 的新 host release 首次启动时建立；列不存在
// 即如实退出，提示先部署。
const db = openDatabase(paths.dataDir);
const cols = db.prepare('PRAGMA table_info(media_assets)').all().map((c) => c.name);
if (!cols.includes('m_sync_state') || !cols.includes('m_content_hash')) {
  console.error('media_assets 尚无 m_* 列（v64 未应用）——先部署含 v64 的 host release 再运行本脚本。');
  process.exit(1);
}
const MASTER_PURPOSES = ['chat_image', 'chat_sticker', 'creation_icon', 'creation_work', 'derived_view'];
const rows = db.prepare(
  `SELECT id, content_sha256, mime_type, storage_key, byte_size, ingest_purpose FROM media_assets
   WHERE m_sync_state = 'pending' AND state = 'available' AND ingest_purpose IN (${MASTER_PURPOSES.map(() => '?').join(',')})
   ORDER BY created_at ASC`,
).all(...MASTER_PURPOSES);

const total = db.prepare(
  `SELECT COUNT(*) n FROM media_assets WHERE state='available' AND ingest_purpose IN (${MASTER_PURPOSES.map(() => '?').join(',')})`,
).get(...MASTER_PURPOSES);
const already = db.prepare("SELECT COUNT(*) n FROM media_assets WHERE m_sync_state='synced'").get();
console.log(`[media-master] 待落正 ${rows.length} 个（正本用途资产共 ${total.n}，已 synced ${already.n}）；模式=${apply ? 'APPLY' : 'DRY-RUN'}`);

let synced = 0, failed = 0, missing = 0;
for (const r of rows) {
  const abs = path.join(paths.mediaDir, r.storage_key);
  if (!fs.existsSync(abs)) {
    missing += 1;
    console.error(`[miss] ${r.id} ${r.ingest_purpose} local cache missing and not synced`);
    continue;
  }
  if (!apply) { console.log(`[dry] ${r.id} ${r.ingest_purpose} ${r.byte_size}B ${r.content_sha256.slice(0, 12)} 本地字节可读`); continue; }
  try {
    const bytes = fs.readFileSync(abs);
    const local = sha256Hex(bytes);
    if (local !== r.content_sha256) throw new Error(`本地字节 hash 不一致 ${local}`);
    const out = await store.uploadBytes(bytes, r.mime_type);
    if (out.content_hash !== r.content_sha256) throw new Error('M 返回 hash 与本地不一致');
    db.prepare("UPDATE media_assets SET m_content_hash=?, m_sync_state='synced', m_sync_attempts=0, m_synced_at=?, m_last_sync_error=NULL WHERE id=?")
      .run(out.content_hash, new Date().toISOString(), r.id);
    synced += 1;
    console.log(`[ok ] ${r.id} ${r.ingest_purpose} ${r.content_sha256.slice(0, 12)} deduplicated=${out.deduplicated}`);
  } catch (err) {
    failed += 1;
    db.prepare("UPDATE media_assets SET m_sync_attempts=m_sync_attempts+1, m_last_sync_error=? WHERE id=?").run(String(err && err.message ? err.message : err).slice(0, 200), r.id);
    console.error(`[fail] ${r.id} ${r.ingest_purpose}: ${err && err.message ? err.message : String(err)}`);
  }
}
db.close();
console.log(`[media-master] 完成：synced=${synced} failed=${failed} missingLocal=${missing}（dry=${apply ? 0 : rows.length}）`);
console.log('[media-master] 未删除任何本地文件；物理清理须待正式 release 接管全部消费者后的发布窗口。');
if (failed > 0 || missing > 0) process.exit(2);
