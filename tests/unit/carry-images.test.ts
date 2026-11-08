// 相册重构 P5：携带图片规划器合同（GLM_ALBUM_REFACTOR_EXECUTION 20261108，03 §8）。
// 纯函数：选集图+相册携带合并去重 ≤ CARRY_IMAGE_LIMIT；选集优先；always 先于
// next_once；超限结构化拒绝（带来源明细）；片段构建（留言原样+asset_image 块）；
// 块计数（装配/派发复检共用）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCarryImages, buildCarryFragment, countCarryImageBlocks } from '../../apps/host/src/context/carry-images.ts';
import { CARRY_IMAGE_LIMIT, type CarrySetItem } from '../../packages/contracts/src/content.ts';

const carry = (asset_id: string, mode: 'always' | 'next_once', caption: string | null = null): CarrySetItem =>
  ({ asset_id, mode, entry_id: `e-${asset_id}`, kind: 'important_photos', caption, meaning: null, added_by: 'jiaming' });

test('PLAN-1: 合并去重与优先级——选集优先、always 先于 next_once、跨来源同图一张', () => {
  const r = planCarryImages({
    selectionImages: [{ asset_id: 'a1', message_id: 'm1' }, { asset_id: 'a2', message_id: 'm2' }],
    carryItems: [carry('a2', 'always'), carry('a3', 'next_once'), carry('a4', 'always'), carry('a1', 'next_once')],
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.images.map((i) => [i.asset_id, i.source]), [
    ['a1', 'selection'], ['a2', 'selection'], // 选集优先：a1/a2 不重复计携带
    ['a4', 'carry_always'], ['a3', 'carry_next_once'], // always 先于 next_once
  ]);
  assert.equal(r.hasNextOnce, true); // a3 仍是 next_once（a1 的 next_once 被选集身份覆盖后不存在于清单）
});

test('PLAN-2: 恰好 10 张通过；11 张（任何来源组合）结构化拒绝并带明细', () => {
  const ten = planCarryImages({ selectionImages: [], carryItems: Array.from({ length: 10 }, (_, i) => carry(`c${i}`, 'always')) });
  assert.equal(ten.ok, true);
  const elevenSel = planCarryImages({ selectionImages: Array.from({ length: 11 }, (_, i) => ({ asset_id: `s${i}`, message_id: `m${i}` })), carryItems: [] });
  assert.equal(elevenSel.ok, false);
  if (elevenSel.ok) return;
  assert.equal(elevenSel.code, 'CARRY_IMAGES_EXCEEDED');
  assert.equal(elevenSel.count, 11);
  assert.equal(elevenSel.limit, CARRY_IMAGE_LIMIT);
  assert.match(elevenSel.detail, /选集 11 \+ 相册携带 0/);
  const mixed = planCarryImages({ selectionImages: Array.from({ length: 8 }, (_, i) => ({ asset_id: `s${i}`, message_id: `m${i}` })), carryItems: [carry('x1', 'next_once'), carry('x2', 'next_once'), carry('x3', 'next_once')] });
  assert.equal(mixed.ok, false);
  if (mixed.ok) return;
  assert.match(mixed.detail, /选集 8 \+ 相册携带 3/);
});

test('PLAN-3: 片段构建——携带项留言原样文本 + 全部 asset_image 块；选集图不重复写留言', () => {
  const r = planCarryImages({ selectionImages: [{ asset_id: 's1', message_id: 'm1' }], carryItems: [carry('c1', 'always', '这张拍得好'), carry('c2', 'next_once')] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const frag = buildCarryFragment(r.images)!;
  const text = (frag.blocks[0] as { type: 'text'; text: string }).text;
  assert.match(text, /开窗携带照片 3 张/);
  assert.match(text, /这张拍得好/);
  assert.doesNotMatch(text, /无留言.*无留言.*无留言/, '选集图不注入留言行');
  assert.equal(countCarryImageBlocks([{ content: frag.blocks }]), 3);
  assert.equal(buildCarryFragment([]), null);
});

test('PLAN-4: 计数器——只数 asset_image 块，文本块/非数组内容不计', () => {
  assert.equal(countCarryImageBlocks([
    { content: [{ type: 'text', text: 'x' }, { type: 'asset_image', asset_id: 'a', projection_version: 'v1' }] },
    { content: 'plain string' },
    { content: [{ type: 'asset_image', asset_id: 'b', projection_version: 'v1' }] },
  ]), 2);
});
