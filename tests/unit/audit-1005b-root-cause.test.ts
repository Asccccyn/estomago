// mariposa 审计 1005B 根因修复回归（estómago 侧适配）：
//  - F：classifyError 按 HTTP 语义优先分类——mariposa 429 的结构化码是
//    RATE_LIMITED，旧实现只认 'HTTP_429' 合成码（分支不可达），一次限流
//    就把归档批次判永久 dead（与 F15"429 可重试"意图相反）。
//  - 词表动态化：refreshMoodCategories 拉正本 → 工具枚举随动；失败保快照。
// 纯函数/假 transport，零网络零凭据。
import { test } from 'node:test';
import {validateToolArgs, fullToolCatalog } from '../helpers.ts';
import assert from 'node:assert/strict';
import { classifyError, MariposaClient } from '../../apps/host/src/integrations/mariposa/client.ts';
import { currentMoodCategories, refreshMoodCategories } from '../../apps/host/src/modules/memory/mood-vocab.ts';
import type { MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';

test('F：HTTP 状态优先——mariposa 结构化码 RATE_LIMITED + 429 = retry_later（旧实现判 dead）', () => {
  assert.equal(classifyError('RATE_LIMITED', 429), 'retry_later');
  assert.equal(classifyError('AUTH_LOCKED', 423), 'retry_later', '门禁锁=指数退避后可解');
  assert.equal(classifyError('SOURCE_HASH_MISMATCH', 422), 'dead', '领域错误不因有状态码变可重试');
  assert.equal(classifyError('IDEMPOTENCY_CONFLICT', 409), 'dead');
});

test('F：无状态合成码路径保持兼容（传输层异常没有 httpStatus）', () => {
  assert.equal(classifyError('HTTP_429'), 'retry_later');
  assert.equal(classifyError('HTTP_503'), 'retry_later');
  assert.equal(classifyError('SOURCE_NOT_READY'), 'retry_later');
  assert.equal(classifyError('VERSION_CONFLICT'), 'dead');
  assert.equal(classifyError('TRANSPORT_UNKNOWN'), 'dead', '未知传输错误不盲重试（调用方有界处理）');
});

test('词表动态化：refreshMoodCategories 拉到正本 → 枚举/校验随动；失败保快照', async () => {
  const before = currentMoodCategories().join('|');
  const okTransport: MariposaTransport = async () => ({
    ok: true,
    result: { categories: ['开心', '爱', '平静'], version: 'mood-vocab-test' },
  });
  const client = new MariposaClient({ transport: okTransport });
  assert.equal(await refreshMoodCategories(client), true);
  assert.equal(currentMoodCategories().join('|'), '开心|爱|平静', '词表随正本更新');
  const spec = fullToolCatalog().find((t) => t.function.name === 'memory_hold')!;
  const moodEnum = ((spec.function.parameters as { properties: Record<string, { items?: { enum?: string[] } }> }).properties.mood_tags!.items!.enum);
  assert.deepEqual(moodEnum, ['开心', '爱', '平静'], '工具枚举用当前词表');
  assert.equal(validateToolArgs('memory_hold', { original_title: 't', categories: ['daily'], text: 'x', mood_tags: ['平静'], creation_mode: 'contemporaneous' }).ok, true, '新词可过形状门');
  assert.equal(validateToolArgs('memory_hold', { original_title: 't', categories: ['daily'], text: 'x', mood_tags: ['生气'], creation_mode: 'contemporaneous' }).ok, false, '正本已移除的旧词=形状门拒（域校验仍以服务端为准）');

  // mariposa 不可达：transport 抛异常 → 保快照不阻塞
  const downTransport: MariposaTransport = async () => { throw new Error('unreachable'); };
  const down = new MariposaClient({ transport: downTransport });
  assert.equal(await refreshMoodCategories(down), false);
  assert.equal(currentMoodCategories().join('|'), '开心|爱|平静', '失败保快照');
});
