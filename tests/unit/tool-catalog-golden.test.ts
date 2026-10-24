// P01 等价基线（workcard P01.3/P01.5）：工具目录逐字节保真。
// golden 于 849b1d5 纯净代码下采集（tests/golden/tool-catalog-baseline.json，
// baselineCommit 记录采集点）。结构重构期间目录/顺序/schema/description/默认词表
// 不得漂移（06 号文档：definitionId 以原序列化为依据；不得先排序 properties）。
// 本测试只对照，不提供重录开关；golden 更新必须由复核者对照 849b1d5 diff 逐字决定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildHostTools } from '../../apps/host/src/runtime/host-tools.ts';
import { buildDeferredTools, definitionId } from '../../apps/host/src/runtime/tool-discovery.ts';

const goldenPath = new URL('../golden/tool-catalog-baseline.json', import.meta.url);
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as {
  baselineCommit: string; order: string[]; deferredOrder: string[];
  definitionIds: Record<string, string>; toolsSha256: string;
  tools: unknown[]; deferred: unknown[];
};

test('工具目录与 849b1d5 基线逐字节一致（名称/顺序/schema/description/默认词表）', () => {
  const tools = buildHostTools();
  assert.equal(tools.length, golden.order.length, '工具数量不变');
  assert.equal(
    crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
    golden.toolsSha256,
    'buildHostTools() JSON sha256 与基线一致',
  );
  assert.deepEqual(tools.map((t) => t.function.name), golden.order, '目录顺序不变');
  assert.deepEqual(buildDeferredTools(), golden.deferred, 'deferred 三入口定义不变');
  for (const t of buildHostTools()) {
    assert.equal(definitionId(t), golden.definitionIds[t.function.name], `definitionId 不变：${t.function.name}`);
  }
});
