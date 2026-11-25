// 受控窗口目录更新（WISHSTAR_SHARED_READ 2026-11-25）：把 wishstar_read 的新定义
// （shared=我们的瓶子）替换进已冻结窗口的 catalog 与 summaries，使该窗口不经换窗、
// 不经重启即在下一轮请求生效。wire_tools_json 不动（激活态工具的 compact 定义在
// 装载时从 catalog 派生）；groups/激活名单不动；历史请求快照不动。
//
// 默认 dry-run 只打印差异；--apply 才写库，写前把原两列备份到 <db>.wishstar-read-backup-<ts>.json。
// 用法：node --experimental-strip-types scripts/refresh-wishstar-read-window.mjs --db <chat.sqlite3> [--window <id>] [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fullToolCatalog } from '../tests/helpers.ts';
import { storedToolset } from '../apps/host/src/runtime/tool-discovery.ts';
import { toolAbility } from '../apps/host/src/runtime/tool-catalog-search.ts';

const TOOL = 'wishstar_read';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dbPath = value('--db');
const windowId = value('--window');
if (!dbPath) throw Error('需要 --db <chat.sqlite3>（生产库路径）');

const fresh = fullToolCatalog().find(t => t.function.name === TOOL);
if (!fresh) throw Error('当前源码目录中没有 wishstar_read');
const freshDefinition = JSON.stringify(fresh);
const freshSummary = toolAbility(fresh);

const db = new DatabaseSync(dbPath);
const rows = db.prepare(windowId
  ? 'SELECT window_id, catalog_json, tool_summaries_json FROM window_toolsets WHERE window_id=?'
  : `SELECT window_id, catalog_json, tool_summaries_json FROM window_toolsets
     WHERE window_id=(SELECT id FROM windows WHERE conversation_id='primary' AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1)`).all(...(windowId ? [windowId] : []));
if (rows.length !== 1) throw Error(windowId ? `窗口不存在：${windowId}` : '没有找到 primary 的 ACTIVE 窗口');
const row = rows[0];

const catalog = JSON.parse(row.catalog_json);
const summaries = row.tool_summaries_json ? JSON.parse(row.tool_summaries_json) : null;
const index = catalog.findIndex(t => t.function?.name === TOOL);
if (index < 0) throw Error(`窗口 ${row.window_id} 的冻结目录里没有 ${TOOL}（旧协议窗口，本脚本不适用）`);
const oldDefinition = catalog[index];
const oldSummary = summaries?.[TOOL] ?? null;

const plan = [];
if (JSON.stringify(oldDefinition) !== freshDefinition) {
  plan.push({ column: 'catalog_json', before: oldDefinition.function.description, after: fresh.function.description,
    enumBefore: oldDefinition.function.parameters.properties.what.enum, enumAfter: fresh.function.parameters.properties.what.enum });
}
if (summaries && oldSummary !== freshSummary) {
  plan.push({ column: 'tool_summaries_json', before: oldSummary, after: freshSummary });
}
if (plan.length === 0) { console.log(`窗口 ${row.window_id} 的 ${TOOL} 已是当前定义，无需更新。`); db.close(); process.exit(0); }

console.log(`目标窗口：${row.window_id}`);
for (const p of plan) {
  console.log(`- ${p.column}`);
  console.log(`  旧：${p.before}${p.enumBefore ? ` [${p.enumBefore.join(',')}]` : ''}`);
  console.log(`  新：${p.after}${p.enumAfter ? ` [${p.enumAfter.join(',')}]` : ''}`);
}
if (!flag('--apply')) { console.log('dry-run：未写库。确认后加 --apply 执行。'); db.close(); process.exit(0); }

const backup = { window_id: row.window_id, catalog_json: row.catalog_json, tool_summaries_json: row.tool_summaries_json, at: new Date().toISOString() };
const backupPath = `${dbPath}.${TOOL}-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2) + '\n');

catalog[index] = fresh;
if (summaries) summaries[TOOL] = freshSummary;
db.prepare('UPDATE window_toolsets SET catalog_json=?, tool_summaries_json=? WHERE window_id=?')
  .run(JSON.stringify(catalog), summaries ? JSON.stringify(summaries) : row.tool_summaries_json, row.window_id);
console.log(`已写回窗口 ${row.window_id}；备份：${path.basename(backupPath)}`);

// 写后校验：与生产同一装载路径必须能读回，且激活面里的 compact 定义带上新枚举。
process.env.ESTOMAGO_TEST_MODE = '1';
const set = storedToolset(db, row.window_id);
const activated = set.tools.find(t => t.function.name === TOOL);
const enumNow = activated?.function.parameters?.properties?.what?.enum ?? set.catalog.find(t => t.function.name === TOOL)?.function.parameters.properties.what.enum;
if (JSON.stringify(enumNow) !== JSON.stringify(fresh.function.parameters.properties.what.enum)) {
  throw Error(`写后校验失败：装载面枚举仍为 [${enumNow}]`);
}
console.log(`校验通过：装载面 ${TOOL} 枚举 = [${enumNow.join(',')}]`);
db.close();
