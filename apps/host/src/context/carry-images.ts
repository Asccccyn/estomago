// 相册重构 P5（GLM_ALBUM_REFACTOR_EXECUTION 20261108，03 §8）：滚窗携带图片规划。
// 唯一计量范围：本次滚窗带入下一上下文段的图片 = 人工选集历史中实际包含的图片
// ∪ 携带设置（每次滚窗 + 下次滚窗一次）的图片，跨相册、跨模式按 asset 去重合并，
// 总数不得超过 CARRY_IMAGE_LIMIT（常量正本在 packages/contracts）。本模块是纯函数：
// 装配（buildEnvelope）与选集确认估算共用同一规划，别处不得另立计数。
//
// 2026-11-08 宿主用户裁定：开窗包按最新裁定执行——选集历史图片是真实图像输入（撤销
// 2026-10-18 textOnly 占位），与携带照片一并计入同一上限；超限明确阻断并列出来源，
// 不截前 10、不静默丢图、不挤掉任何一方。
import { CARRY_IMAGE_LIMIT, type CarrySetItem } from '../../../../packages/contracts/src/content.ts';
import type { AssetImageRefBlock, ProjectedBlock } from '../media/model-input.ts';

export type SelectionImage = { asset_id: string; message_id: string };
export type CarryModeLite = 'always' | 'next_once';

export type PlannedCarryImage = {
  asset_id: string;
  /** selection=选集历史自带；carry_always/carry_next_once=相册携带设置（供来源披露与减选提示） */
  source: 'selection' | `carry_${CarryModeLite}`;
  /** 相册携带关系的留言（原样保留；selection 图片的留言在其原消息文本里，不重复注入） */
  caption: string | null;
  meaning: string | null;
};

export type CarryPlan =
  | { ok: true; images: PlannedCarryImage[]; hasNextOnce: boolean }
  | { ok: false; code: 'CARRY_IMAGES_EXCEEDED'; count: number; limit: number; detail: string };

/** 合并去重：选集图优先（用户本次明确选择），其余名额给携带设置（always 先于 next_once）。 */
export function planCarryImages(o: {
  selectionImages: SelectionImage[];
  carryItems: CarrySetItem[];
  limit?: number;
}): CarryPlan {
  const limit = o.limit ?? CARRY_IMAGE_LIMIT;
  const images: PlannedCarryImage[] = [];
  const seen = new Set<string>();
  for (const s of o.selectionImages) {
    if (seen.has(s.asset_id)) continue;
    seen.add(s.asset_id);
    images.push({ asset_id: s.asset_id, source: 'selection', caption: null, meaning: null });
  }
  const ordered = [...o.carryItems].sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'always' ? -1 : 1));
  let hasNextOnce = false;
  for (const c of ordered) {
    if (seen.has(c.asset_id)) continue;
    seen.add(c.asset_id);
    images.push({ asset_id: c.asset_id, source: `carry_${c.mode}`, caption: c.caption, meaning: c.meaning });
    if (c.mode === 'next_once') hasNextOnce = true;
  }
  if (o.carryItems.some((c) => c.mode === 'next_once')) hasNextOnce = true;
  if (images.length > limit) {
    const selectionCount = images.filter((i) => i.source === 'selection').length;
    const carryCount = images.length - selectionCount;
    return {
      ok: false, code: 'CARRY_IMAGES_EXCEEDED', count: images.length, limit,
      detail: `合并后 ${images.length} 张（选集 ${selectionCount} + 相册携带 ${carryCount}，去重后）超过每次滚窗上限 ${limit}；请减选历史消息图片或调低相册携带设置`,
    };
  }
  return { ok: true, images, hasNextOnce };
}

/** 开窗携带块：一段 system 数据块（说明 + 留言原样文本）+ 实际 asset_image 引用块。
 *  物化由发送边界 materializeEnvelope 统一完成（内部持久形态不含 Base64，§6.2）。 */
export function buildCarryFragment(images: PlannedCarryImage[]): { blocks: ProjectedBlock[] } | null {
  if (images.length === 0) return null;
  const lines: string[] = [`[开窗携带照片 ${images.length} 张]（来自我们的相册携带设置与所选历史；留言为收藏时的原话）`];
  images.forEach((img, i) => {
    if (img.source === 'selection') return; // 选集图的正文/留言已在历史消息里，不重复
    const parts = [img.caption, img.meaning].filter((t): t is string => typeof t === 'string' && t.length > 0);
    lines.push(`${i + 1}. ${parts.length > 0 ? parts.join(' / ') : '（无留言）'}`);
  });
  const textBlock = { type: 'text' as const, text: lines.join('\n') };
  const imageBlocks: AssetImageRefBlock[] = images.map((img) => ({ type: 'asset_image' as const, asset_id: img.asset_id, projection_version: 'v1' as const }));
  return { blocks: [textBlock, ...imageBlocks] };
}

/** 携带图片块计数（装配自检与派发复检共用）：统计消息序列里 asset_image 块的数量。 */
export function countCarryImageBlocks(messages: Array<{ content: unknown }>): number {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type?: string }>) if (b?.type === 'asset_image') n += 1;
  }
  return n;
}
