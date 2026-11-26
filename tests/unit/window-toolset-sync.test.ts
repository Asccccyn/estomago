// 冷启动目录同步（她 2026-11-25 裁定：不换窗也要能用最新版工具）。
//  - ACTIVE direct 窗口：同名定义替换、新工具追加 'D'、wire C 组与 summaries 一并重建；
//  - 幂等：无差异不写；CLOSED 窗口与 legacy/deferred 协议不动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDb, fullToolCatalog } from '../helpers.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { freezeWindowTools, storedToolset, syncWindowToolsetsToCurrent, definitionId } from '../../apps/host/src/runtime/tool-discovery.ts';

function fixture() {
  const { db, root } = makeDb();
  const messages = new MessageService(db);
  messages.ensureConversation('c1');
  return { db, root, messages };
}
function window(db: Awaited<ReturnType<typeof fixture>>['db'], id: string, status: string) {
  db.prepare('INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES(?,?,?,\'now\',\'now\')').run(id, 'c1', status);
}

test('ACTIVE direct 窗口冷启动同步：替换旧定义、追加新工具、wire/summaries 重建、幂等', () => {
  const { db, root } = fixture();
  try {
    window(db, 'w1', 'ACTIVE');
    const current = fullToolCatalog();
    // 旧冻结目录：wishstar_read 用旧文案/无 shared 枚举，且缺一个当前存在的新工具。
    const newToolName = 'memory_recall_next';
    const oldCatalog = JSON.parse(JSON.stringify(current.filter(t => t.function.name !== newToolName))) as typeof current;
    const oldRead = oldCatalog.find(t => t.function.name === 'wishstar_read')!;
    oldRead.function.description = '旧版描述：读取自己的私人星、纪念日、待收星、开星请求或通知。';
    oldRead.function.parameters.properties.what.enum = ['hidden', 'dates', 'offers', 'notifications', 'requests'];
    freezeWindowTools(db, 'w1', oldCatalog, 'direct');
    const before = storedToolset(db, 'w1')!;
    assert.equal(before.catalog.find(t => t.function.name === newToolName), undefined, '冻结时新工具不存在');

    const r1 = syncWindowToolsetsToCurrent(db, current);
    assert.equal(r1.windows, 1);
    assert.equal(r1.refreshed, 1);
    assert.deepEqual(r1.skipped, []);
    assert.ok(r1.replaced.includes('wishstar_read'), '旧定义被替换');
    assert.ok(r1.added.includes(newToolName), '新工具被追加');

    const after = storedToolset(db, 'w1')!;
    const newRead = after.catalog.find(t => t.function.name === 'wishstar_read')!;
    assert.equal(newRead.function.description, current.find(t => t.function.name === 'wishstar_read')!.function.description, 'catalog 同步到当前定义');
    assert.ok(newRead.function.parameters.properties.what.enum.includes('shared'), '枚举带 shared');
    const added = after.catalog.find(t => t.function.name === newToolName)!;
    assert.equal(after.groups[newToolName], 'D', '新工具按需发现组');
    assert.equal(definitionId(added), definitionId(current.find(t => t.function.name === newToolName)!));
    // wire 的 C 组 compact 跟随当前目录（wishstar_write_star 是常驻）：
    // argumentShape 只投影 type/enum/required，比较这两个投影即可。
    const shapeOf = (p: Record<string, unknown>): unknown => JSON.parse(JSON.stringify(p, (k, v) => k === 'description' || k === 'minLength' || k === 'maxLength' ? undefined : v));
    const wireWrite = after.tools.find(t => t.function.name === 'wishstar_write_star')!;
    const catalogWrite = current.find(t => t.function.name === 'wishstar_write_star')!;
    assert.deepEqual(wireWrite.function.parameters.properties && shapeOf(wireWrite.function.parameters.properties.visibility),
      catalogWrite.function.parameters.properties && shapeOf(catalogWrite.function.parameters.properties.visibility),
      'wire 常驻 compact 的枚举与当前目录一致');
    assert.ok(after.summaries && typeof after.summaries[newToolName] === 'string', 'summaries 覆盖新工具');

    const r2 = syncWindowToolsetsToCurrent(db, current);
    assert.equal(r2.refreshed, 0, '幂等：无差异不写');
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLOSED 窗口与 deferred 协议窗口不动', () => {
  const { db, root } = fixture();
  try {
    const current = fullToolCatalog();
    window(db, 'wc', 'CLOSED');
    freezeWindowTools(db, 'wc', current, 'direct');
    const closedBefore = JSON.stringify(storedToolset(db, 'wc')!.catalog);
    window(db, 'wd', 'ACTIVE');
    freezeWindowTools(db, 'wd', current, 'deferred');
    const deferredBefore = JSON.stringify(storedToolset(db, 'wd')!.catalog);

    const r = syncWindowToolsetsToCurrent(db, current);
    assert.equal(r.refreshed, 0, 'CLOSED 不在同步范围');
    assert.equal(JSON.stringify(storedToolset(db, 'wc')!.catalog), closedBefore, 'CLOSED 目录原样');
    assert.equal(JSON.stringify(storedToolset(db, 'wd')!.catalog), deferredBefore, 'deferred 协议原样');
    assert.ok(r.skipped.includes('wd'), 'deferred 如实记 skipped');
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('已是最新的 ACTIVE 窗口：零写入', () => {
  const { db, root } = fixture();
  try {
    const current = fullToolCatalog();
    window(db, 'w2', 'ACTIVE');
    freezeWindowTools(db, 'w2', current, 'direct');
    const r = syncWindowToolsetsToCurrent(db, current);
    assert.equal(r.windows, 1);
    assert.equal(r.refreshed, 0);
    assert.deepEqual(r.replaced, []);
    assert.deepEqual(r.added, []);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
