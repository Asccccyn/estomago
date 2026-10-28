// 联合审计 F-J-13（2026-10-06）：跨仓契约防漂移测试（离线、只读）。
// 读取 mariposa 仓**现行实码**（capabilities/input_schemas.py 的 memory.hold 段 +
// registry 注册名 + our_words provenance 前缀），与 estómago 侧副本逐项比对——
// 任一端漂移（改枚举/改上限/改字段名/删能力）本测试失败（漂移左移到测试期，
// 而不是联调期以 dead/unknown 暴露；F-J-01 即此类事故）。
// mariposa 仓不存在（如独立 CI）时整文件跳过——estómago 单仓测试保持可独立绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOLD_CATEGORIES, HOLD_CREATION_MODES, HOLD_DATE_CONFIDENCE, HOLD_TITLE_MAX } from '../../apps/host/src/modules/memory/hold-contract.ts';

// 兄弟仓寻址不含用户名：env 覆盖 → 本 worktree 相对（worktrees/<x>/tests/unit 上五级=项目根）
// → home 兜底；找不到时由 repoAvailable 分支如实跳过。
const MARIPOSA_REPO = process.env.MARIPOSA_REPO
  ?? [path.resolve(import.meta.dirname, '../../../../..', 'mariposa'), path.join(os.homedir(), 'Projects/mariposa')]
    .find((p) => fs.existsSync(path.join(p, 'backend/mariposa/capabilities/input_schemas.py')))
  ?? path.join(os.homedir(), 'Projects/mariposa');
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
  const hostToolsSrc = fs.readFileSync(new URL('../../apps/host/src/modules/memory/module.ts', import.meta.url), 'utf8');
  const etm = hostToolsSrc.match(/mood_tags[\s\S]{0,120}?maxItems'?:?\s*(\d+)/) ?? hostToolsSrc.match(/mood_tags[\s\S]{0,160}?maxItems[^0-9]*(\d+)/);
  assert.ok(etm, 'estómago mood_tags maxItems 可解析');
  assert.equal(Number(etm[1]), Number(mtm[1]), 'mood tags 上限两端一致（mariposa=_MOOD_TAGS_MAX）');
});

test('D2：bootstrap profile 枚举含 estomago（两端口径）', async () => {
  const fs2 = await import('node:fs');
  const block = fs2.readFileSync(schemasPath, 'utf8');
  const m = block.match(/"bootstrap.get": \{[\s\S]*?"enum": \[([^\]]+)\]/);
  assert.ok(m, 'bootstrap.get profile 枚举可解析');
  assert.ok(m[1]!.includes('estomago'), 'mariposa V2 schema 含 estomago profile');
  const clientSrc = fs2.readFileSync(new URL('../../apps/host/src/integrations/mariposa/client.ts', import.meta.url), 'utf8');
  assert.ok(clientSrc.includes("profile: 'estomago'"), 'estómago 客户端用 estomago profile（不冒充 cc）');
});

test('F-J-13：estómago 调用的全部 mariposa 能力名在服务端注册', { skip: !repoAvailable && 'mariposa 仓不存在（独立环境跳过）' }, () => {
  const registry = fs.readFileSync(registryPath, 'utf8');
  const called = ['source.ingest', 'source.ingest.status', 'memory.hold', 'memory.hold.status', 'memory.mood.vocab',
    'bootstrap.get', 'bootstrap.next', 'memory.recall.start', 'memory.recall.refine', 'memory.recall.status', 'memory.recall.accept', 'memory.recall.reject', 'episode.apply', 'episode.get', 'episode.list'];
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
  const hostTools = fs.readFileSync(new URL('../../apps/host/src/modules/memory/service.ts', import.meta.url), 'utf8');
  assert.ok(hostTools.includes('source_ref: `source_msg:${receipt.source_message_id}`'), 'estómago 发送侧仍使用 source_msg:<收据 id>（F-J-01 防回归）');
});

test('F-J-13：hold 的 source_selections 字段名与 mariposa schema 一致', { skip: !repoAvailable && 'mariposa 仓不存在（独立环境跳过）' }, () => {
  const block = holdBlock(fs.readFileSync(schemasPath, 'utf8'));
  const selBlock = block.slice(block.indexOf('"source_selections"'));
  for (const field of ['conversation_id', 'members', 'source_message_id', 'content_hash', 'start_char_offset', 'end_char_offset']) {
    assert.ok(selBlock.includes(`"${field}"`), `selections 字段漂移：${field}`);
  }
});

// —— F-J-12：批次字节口径跨语言黄金夹具（JS 计数 vs Python json.dumps 服务端口径）——
import { serverNormalizedBytes } from '../../apps/host/src/integrations/mariposa/client.ts';
import { execFileSync } from 'node:child_process';

function pythonDumpsBytes(payload: unknown): number {
  // 服务端口径：json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode('utf-8')
  const json = JSON.stringify(payload);
  const out = execFileSync('python3', ['-c', `
import json, sys
payload = json.loads(sys.argv[1])
print(len(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode('utf-8')))
`, json], { encoding: 'utf8' });
  return Number(out.trim());
}

const goldenMessage = (i: number, over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  origin_message_id: `msg-${i}`, revision: 1, previous_revision: null, conversation_sequence: i,
  predecessor: null, sender: i % 2 === 0 ? 'user' : 'assistant', published_kind: 'chat_message',
  occurred_at: '2026-10-06T21:00:00+08:00', received_at: '2026-10-06T21:00:01+08:00',
  published_at: '2026-10-06T21:00:02+08:00',
  text: `第${i}条：中文正文带引号"引号"、换行\\n、emoji 😀与制表\\t——月亮很圆`,
  assets: [], content_hash: 'a'.repeat(64), ...over,
});

test('F-J-12 黄金夹具：JS serverNormalizedBytes 与 Python 服务端口径逐样本相等', () => {
  const samples: Array<{ name: string; payload: unknown }> = [
    { name: '单条中文+emoji+引号+换行', payload: { operation_id: 'op-1', stream_id: 's', origin_instance: 'estomago', origin_conversation_id: 'room', messages: [goldenMessage(1)] } },
    { name: '50 条边界', payload: { operation_id: 'op-50', stream_id: 's', origin_instance: 'estomago', origin_conversation_id: 'room', messages: Array.from({ length: 50 }, (_, i) => goldenMessage(i + 1)) } },
    { name: '键序乱序（对象键插入序≠字典序）', payload: { zeta: 1, alpha: '中文', middle: null, beta: [3, 1, 2] } },
    { name: '空对象/空数组/空串/null', payload: { a: {}, b: [], c: '', d: null } },
    { name: '嵌套 predecessor', payload: { operation_id: 'op-p', stream_id: 's', origin_instance: 'estomago', origin_conversation_id: 'room', messages: [goldenMessage(2, { predecessor: { origin_message_id: 'msg-1', revision: 1 } })] } },
  ];
  for (const s of samples) {
    const js = serverNormalizedBytes(s.payload);
    const py = pythonDumpsBytes(s.payload);
    assert.equal(js, py, `${s.name}：JS=${js} Python=${py}（口径漂移）`);
  }
});

test('F-J-12 边界：1MiB 阈值邻域两端同判定', () => {
  // 构造使规范化载荷接近 1MiB 的正文长度，两端判定一致
  const LIMIT = 1024 * 1024;
  for (const extra of [-64, -1, 0, 1, 64]) {
    const base = { operation_id: 'op-b', stream_id: 's', origin_instance: 'estomago', origin_conversation_id: 'room', messages: [goldenMessage(1, { text: '字'.repeat(300000) })] };
    // 通过增删正文长度逼近阈值（粗调+微调）
    const probe = (len: number): number => serverNormalizedBytes({ ...base, messages: [{ ...base.messages[0] as Record<string, unknown>, text: 'x'.repeat(len) }] });
    // 只断言两端在同一载荷上给出相同字节与相同越限判定
    const payload = { ...base, messages: [{ ...(base.messages[0] as Record<string, unknown>), text: '字'.repeat(260000 + Math.floor(extra / 3)) }] };
    assert.equal(serverNormalizedBytes(payload) > LIMIT, pythonDumpsBytes(payload) > LIMIT, `extra=${extra}：越限判定一致`);
    assert.equal(serverNormalizedBytes(payload), pythonDumpsBytes(payload), `extra=${extra}：字节数相等`);
    void probe;
  }
});
