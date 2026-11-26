#!/usr/bin/env node
// P1·G3（四仓合并审计 20261106，F06/F07）：content 存量对账 dry-run——只读。
// 读取 <home>/content/content.sqlite3 与 <home>/data/chat.sqlite3（mode=ro），
// 按 content 当前权威快照（不是历史回执）分类：
//   有效作品 → 应有的 owner+asset 正式保护成员；墓碑 → 带版本零集合；
//   13 类旧回执（指纹版本 0）→ 兼容分类；Host 引用表现状 → 差异与拟执行动作。
// 不写任何数据库；实际回填走 Host 内 ContentOperationCoordinator.reconcileOwner
// 的同一确认路径（需显式授权后另行执行），本脚本禁止扮演“批量改 committed”的后门。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const args = process.argv.slice(2);
const homeIdx = args.indexOf('--home');
const home = homeIdx >= 0 ? args[homeIdx + 1] : null;
if (!home || home === path.join(os.homedir(), 'Library', 'Application Support', 'estomago') && !args.includes('--prod')) {
  console.error('用法：node scripts/content-stock-reconcile.mjs --home <stateRoot> [--prod]');
  console.error('  --home 指向要核对的 estomago stateRoot；对生产根必须再加 --prod 显式确认（仍只读）。');
  process.exit(2);
}
const contentDbPath = path.join(home, 'content', 'content.sqlite3');
const hostDbPath = path.join(home, 'data', 'chat.sqlite3');
for (const p of [contentDbPath, hostDbPath]) {
  if (!fs.existsSync(p)) { console.error(`缺少数据库：${p}`); process.exit(2); }
}
const openRo = (p) => new DatabaseSync(`file:${p}?mode=ro`, { readOnly: true });
// 只读脚本对“未迁移的新表”容错：缺表=未部署新链（如实标注，不建表）
const tryAll = (db, sql, params = []) => { try { return db.prepare(sql).all(...params); } catch { return null; } };
const tryGet = (db, sql, params = []) => { try { return db.prepare(sql).get(...params); } catch { return null; } };
const content = openRo(contentDbPath);
const host = openRo(hostDbPath);

// —— content 权威快照（与 apps/content referenceSnapshot 同语义，只读重建） ——
const creations = content.prepare('SELECT id, creator_actor, icon_asset_id, work_asset_id, revision, deleted_at FROM creations ORDER BY created_at').all();
const plan = [];
for (const c of creations) {
  const deleted = c.deleted_at !== null;
  const members = deleted ? [] : [c.icon_asset_id, c.work_asset_id].filter((a) => typeof a === 'string' && a !== null);
  const ownerState = tryGet(host, 'SELECT applied_revision, deleted, asset_ids_json FROM content_owner_state WHERE owner_type = ? AND owner_id = ?', ['creation', c.id]);
  const hostRefs = (tryAll(host, "SELECT asset_id, state, owner_revision FROM asset_external_refs WHERE owner_service = 'content' AND owner_type = 'creation' AND owner_id = ? AND state IN ('protected','committed')", [c.id]) ?? [])
    .filter((r) => members.includes(r.asset_id));
  plan.push({
    owner: `creation:${c.id}`,
    creator: c.creator_actor,
    status: deleted ? 'tombstone_zero_set' : 'valid',
    snapshot_revision: c.revision,
    expected_members: [...new Set(members)],
    applied_owner_state: ownerState ? { revision: ownerState.applied_revision, deleted: Boolean(ownerState.deleted), assets: JSON.parse(ownerState.asset_ids_json) } : null,
    active_host_refs: hostRefs,
    action: ownerState && ownerState.applied_revision >= c.revision && JSON.stringify([...new Set(members)].sort()) === JSON.stringify((ownerState ? JSON.parse(ownerState.asset_ids_json) : []).sort())
      ? 'already_applied'
      : `reconcile_owner(snapshot@${c.revision})`,
  });
}

// —— 其他四类对象（当前生产为 0，如实列出计数） ——
const counts = {};
const tableCountSql = [
  ['posts', 'SELECT COUNT(*) n, SUM(deleted_at IS NOT NULL) d FROM feed_posts'],
  ['comments', 'SELECT COUNT(*) n, SUM(deleted_at IS NOT NULL) d FROM feed_comments'],
  ['album_entries', 'SELECT COUNT(*) n, SUM(deleted_at IS NOT NULL) d FROM album_entries'],
  ['future_notes', 'SELECT COUNT(*) n, SUM(deleted_at IS NOT NULL) d FROM future_notes'],
];
for (const [name, sql] of tableCountSql) {
  const r = tryGet(content, sql);
  if (r === null) { counts[name] = { total: 'schema_v1（无墓碑列，物理删除形态）' }; continue; }
  counts[name] = { total: r.n, tombstones: r.d ?? 0 };
}

// —— 旧回执分类（13 类存量；指纹版本 0=旧算法，不重写不换 key） ——
const receipts = tryAll(content, 'SELECT actor, idem_key, fingerprint_version, resource_type, action, status, request_hash FROM content_receipts ORDER BY created_at')
  ?? tryAll(content, 'SELECT actor, idem_key, NULL AS fingerprint_version, NULL AS resource_type, NULL AS action, status, request_hash FROM content_receipts ORDER BY created_at')
  ?? [];
const receiptClasses = { v2_typed: 0, legacy_fingerprint0: 0, by_resource: {} };
for (const r of receipts) {
  if ((r.fingerprint_version ?? 0) >= 2) receiptClasses.v2_typed++;
  else receiptClasses.legacy_fingerprint0++;
  const inferred = r.resource_type ?? inferFromHashKnown(r.request_hash);
  receiptClasses.by_resource[inferred] = (receiptClasses.by_resource[inferred] ?? 0) + 1;
}
// 存量回执响应形状未读取（本脚本不读 response_json，避免正文进日志）；资源类型未知时标 unknown
function inferFromHashKnown() { return 'unknown(见response_json)'; }

// —— Host 现状与保护缺口 ——
const stock = {
  media_assets: tryGet(host, "SELECT COUNT(*) n, SUM(state = 'available') avail FROM media_assets"),
  message_attachments: tryGet(host, 'SELECT COUNT(DISTINCT asset_id) n FROM message_attachments'),
  external_refs_active: tryGet(host, "SELECT COUNT(*) n FROM asset_external_refs WHERE state IN ('protected','committed')"),
  content_operation_intents: tryAll(host, "SELECT state, COUNT(*) n FROM outbox WHERE target = 'content.operation' GROUP BY state") ?? 'table_missing(未部署P1链)',
};

console.log(JSON.stringify({
  read_only: true, home,
  content_stock: counts,
  creations_plan: plan,
  receipts: { total: receipts.length, ...receiptClasses },
  host_stock: stock,
  notes: [
    'dry-run 不写库；回填须走 Host ContentOperationCoordinator.reconcileOwner 同一确认路径（版本单调准入）。',
    '墓碑/零集合以 content 当前 revision 为版本锚；不从活跃引用行推算。',
    '旧回执（指纹版本 0）保留原 hash/响应，兼容解析集中在 content 受限入口；不足证据=待核冲突。',
  ],
}, null, 2));
content.close();
host.close();
