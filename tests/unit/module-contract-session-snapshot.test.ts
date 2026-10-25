// P01.5：合成正常会话快照——迁移等价基线（06 号文档"迁移前要采集的离线对照"1/2/3/5 项）。
// golden 于 P01 卡采集（采集提交见 golden 内 baselineNote；源基线 849b1d5，语义等价性由
// tool-catalog-golden + P01 各定向测试共同保证）。结构重构期间逐字节对照；
// 对照失败按 06 分类处理，禁止一次性重录掩盖变化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSyntheticSession } from '../helpers/module-contract-session.ts';

const goldenPath = new URL('../golden/module-contract-session-baseline.json', import.meta.url);
type Golden = { baselineCommit: string; baselineNote: string; records: unknown[]; facts: Record<string, unknown> };
const golden: Golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));

test('合成正常会话 wire 与 P01 基线逐字一致（工具目录/已见定义/同轮浮现/已发布语音投影）', async () => {
  const { records, facts } = await runSyntheticSession();
  assert.deepEqual(records, golden.records, 'wire 记录（归一化 ID/时间戳后）与基线不一致');
  assert.deepEqual(facts, golden.facts, '关键事实（define/invoke 回执、语音消息、浮现绑定）与基线不一致');
  assert.ok(facts.hold_calls === 1, 'memory_hold 经 define→invoke 真实执行一次');
});
