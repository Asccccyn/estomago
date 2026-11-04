// Generated registry snapshot: detects changes; business contracts are tested separately.
import { test } from 'node:test';
import {fullToolCatalog } from '../helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildDeferredTools, definitionId } from '../../apps/host/src/runtime/tool-discovery.ts';

const goldenPath = new URL('../golden/tool-catalog-baseline.json', import.meta.url);
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as {
  baselineCommit: string; order: string[]; deferredOrder: string[];
  definitionIds: Record<string, string>; toolsSha256: string;
  tools: unknown[]; deferred: unknown[];
};

test('工具目录与当前生成快照逐字节一致（不以快照决定业务规则）', () => {
  const tools = fullToolCatalog();
  assert.equal(tools.length, golden.order.length, '工具数量不变');
  assert.equal(
    crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
    golden.toolsSha256,
    'fullToolCatalog() JSON sha256 与基线一致',
  );
  assert.deepEqual(tools.map((t) => t.function.name), golden.order, '目录顺序不变');
  assert.deepEqual(buildDeferredTools(), golden.deferred, 'deferred 三入口定义不变');
  for (const t of fullToolCatalog()) {
    assert.equal(definitionId(t), golden.definitionIds[t.function.name], `definitionId 不变：${t.function.name}`);
  }
});
