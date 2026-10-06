// 联合审计 F-J-13（2026-10-06）：跨仓契约防漂移测试（离线、只读）。
// 读取 mariposa 仓**现行实码**（capabilities/input_schemas.py 的 memory.hold 段 +
// registry 注册名 + our_words provenance 前缀），与 estómago 侧副本逐项比对——
// 任一端漂移（改枚举/改上限/改字段名/删能力）本测试失败（漂移左移到测试期，
// 而不是联调期以 dead/unknown 暴露；F-J-01 即此类事故）。
// mariposa 仓不存在（如独立 CI）时整文件跳过——estómago 单仓测试保持可独立绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HOLD_CATEGORIES, HOLD_CREATION_MODES, HOLD_DATE_CONFIDENCE, HOLD_TITLE_MAX } from '../../apps/host/src/runtime/host-tools.ts';

const MARIPOSA_REPO = process.env.MARIPOSA_REPO ?? '/Users/owner/Projects/mariposa';
const schemasPath = path.join(MARIPOSA_REPO, 'backend/mariposa/capabilities/input_schemas.py');
const registryPath = path.join(MARIPOSA_REPO, 'backend/mariposa/capabilities/registry.py');
const ourWordsPath = path.join(MARIPOSA_REPO, 'backend/mariposa/memory/our_words.py');
const repoAvailable = fs.existsSync(schemasPath) && fs.existsSync(registryPath);

/** 截取 "memory.hold": {...} 配置块（到下一个四缩进能力键或文件尾） */
function holdBlock(source: string): string {
  return blockOf(source, 'memory.hold');
}
function blockOf(source: string, key: string): string {
  const start = source.indexOf(`"${key}": {`);
  assert.ok(start >= 0, `mariposa input_schemas 含 ${key} 段`);
  const rest = source.slice(start + key.length + 6);
  const next = rest.search(/\n    "[a-z_.]+": \{/);
  return next >= 0 ? source.slice(start, start + key.length + 6 + next) : source.slice(start);
}
function enumOf(block: string, key: string): string[] {
  const i = block.indexOf(`"${key}":`);
  assert.ok(i >= 0, `${key} 键存在`);
  const after = block.slice(i);
  const lb = after.indexOf('[');
  const rb = after.indexOf(']', lb);
  assert.ok(lb >= 0 && rb > lb, `${key} 枚举可解析`);
  return after.slice(lb + 1, rb).split(',').map((x) => x.trim().replace(/["\s]/g, '')).filter(Boolean);
}
function firstNumAfter(block: string, key: string, marker: string): number {
  const i = block.indexOf(`"${key}"`);
  assert.ok(i >= 0, `${key} 存在`);
  const after = block.slice(i);
  const j = after.indexOf(marker);
  assert.ok(j >= 0, `${key} ${marker} 可解析`);
  const m = after.slice(j).match(/\d+/);
  assert.ok(m, `${key} ${marker} 后有数字`);
  return Number(m[0]);
}

test('F-J-13：estómago hold 副本与 mariposa 现行 schema 一致（枚举/上限）', { skip: !repoAvailable && 'mariposa 仓不存在（独立环境跳过）' }, () => {
  const block = holdBlock(fs.readFileSync(schemasPath, 'utf8'));
  // 九分类（顺序与值）
  const cats = enumOf(block, 'categories');
  assert.deepEqual([...HOLD_CATEGORIES], cats, '九分类枚举漂移');
  // creation_mode / date_confidence
  assert.deepEqual([...HOLD_CREATION_MODES], enumOf(block, 'creation_mode'), 'creation_mode 枚举漂移');
  assert.deepEqual([...HOLD_DATE_CONFIDENCE], enumOf(block, 'date_confidence'), 'date_confidence 枚举漂移');
  // 标题上限（maxLength）
  assert.equal(firstNumAfter(block, 'original_title', 'maxLength'), HOLD_TITLE_MAX, '标题上限漂移');
  // mood tags 上限（maxItems）
  // mood.tags 上限在 mariposa 侧是常量 _MOOD_TAGS_MAX（非字面量）——解析常量值比对
  const schemas = fs.readFileSync(schemasPath, 'utf8');
  const servicePy = fs.readFileSync(path.join(MARIPOSA_REPO, 'backend/mariposa/memory/service.py'), 'utf8');
  const mtm = servicePy.match(/MOOD_TAGS_MAX\s*=\s*(\d+)/);
  assert.ok(mtm, 'MOOD_TAGS_MAX 可解析（memory/service.py 单一事实源）');
  const hostToolsSrc = fs.readFileSync(new URL('../../apps/host/src/runtime/host-tools.ts', import.meta.url), 'utf8');
  const etm = hostToolsSrc.match(/mood_tags[\s\S]{0,120}?maxItems'?:?\s*(\d+)/) ?? hostToolsSrc.match(/mood_tags[\s\S]{0,160}?maxItems[^0-9]*(\d+)/);
  assert.ok(etm, 'estómago mood_tags maxItems 可解析');
  assert.equal(Number(etm[1]), Number(mtm[1]), 'mood tags 上限两端一致（mariposa=_MOOD_TAGS_MAX）');
});

test('F-J-13：estómago 调用的全部 mariposa 能力名在服务端注册', { skip: !repoAvailable && 'mariposa 仓不存在（独立环境跳过）' }, () => {
  const registry = fs.readFileSync(registryPath, 'utf8');
  const called = ['source.ingest', 'source.ingest.status', 'memory.hold', 'memory.hold.status', 'memory.mood.vocab'];
  for (const cap of called) {
    assert.ok(registry.includes(`add("${cap}"`) || registry.includes(`"${cap}"`), `mariposa registry 缺能力：${cap}`);
  }
});

test('F-J-13：our_words source_ref 合同=source_msg: 前缀（两端）', { skip: !repoAvailable && 'maripago 仓不存在（独立环境跳过）' }, () => {
  // mariposa 侧：provenance 校验要求前缀
  const ourWords = fs.readFileSync(ourWordsPath, 'utf8');
  assert.ok(ourWords.includes('source_msg:'), 'mariposa our_words 仍要求 source_msg: 前缀');
  // estómago 侧：host-tools 发送侧带前缀（F-J-01 修复的防回归锚——直接断言源码形态，
  // 因为前缀拼接在私有函数内，单测形状断言已在 hold-quote.test.ts 覆盖发送值）
  const hostTools = fs.readFileSync(new URL('../../apps/host/src/runtime/host-tools.ts', import.meta.url), 'utf8');
  assert.ok(hostTools.includes('source_ref: `source_msg:${receipt.source_message_id}`'), 'estómago 发送侧仍使用 source_msg:<收据 id>（F-J-01 防回归）');
});

test('F-J-13：hold 的 source_selections 字段名与 mariposa schema 一致', { skip: !repoAvailable && 'mariposa 仓不存在（独立环境跳过）' }, () => {
  const block = holdBlock(fs.readFileSync(schemasPath, 'utf8'));
  const selBlock = block.slice(block.indexOf('"source_selections"'));
  for (const field of ['conversation_id', 'members', 'source_message_id', 'content_hash', 'start_char_offset', 'end_char_offset']) {
    assert.ok(selBlock.includes(`"${field}"`), `selections 字段漂移：${field}`);
  }
});
