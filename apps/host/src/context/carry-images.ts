// 相册重构 P5（GLM_ALBUM_REFACTOR_EXECUTION 20261108，03 §8）：滚窗携带图片规划。
// 唯一计量范围：本次滚窗带入下一上下文段的图片 = 人工选集历史中实际包含的图片
// ∪ 携带设置（每次滚窗 + 下次滚窗一次）的图片，跨相册、跨模式按 asset 去重合并，
// 总数不得超过 CARRY_IMAGE_LIMIT（常量正本在 packages/contracts）。本模块是纯函数：
// 装配（buildEnvelope）与选集确认估算共用同一规划，别处不得另立计数。
//
// 2026-11-08 宿主用户裁定：开窗包按最新裁定执行——选集历史图片是真实图像输入（撤销
// 2026-10-18 textOnly 占位），与携带照片一并计入同一上限；超限明确阻断并列出来源，
// 不截前 10、不静默丢图、不挤掉任何一方。
//
// R2 残余（复审 2026-11-08）：同图（跨相册条目/同 hash 不同 asset）的**全部**留言
// 逐条保留（03 §7.2 留言不得凭空合并、改写或丢弃；保留真实作者）——entry 持留言
// 数组，片段文本逐条列出。
import { CARRY_IMAGE_LIMIT, type CarrySetItem } from '../../../../packages/contracts/src/content.ts';
import type { AssetImageRefBlock, ProjectedBlock } from '../media/model-input.ts';

export type SelectionImage = { asset_id: string; content_sha256: string; message_id: string };
export type CarryModeLite = 'always' | 'next_once';

/** 一条相册留言（caption=收藏时原话，meaning=说明；作者随留言保留）。 */
export type CarryComment = { caption: string | null; meaning: string | null; added_by: string };

export type PlannedCarryImage = {
  asset_id: string;
  /** selection=选集历史自带（图块随历史消息走，不进片段）；carry_*=相册携带（片段注入） */
  source: 'selection' | `carry_${CarryModeLite}`;
  /** 该图全部相册留言（跨条目/跨相册合并收集，逐条保留；选集图同 hash 的相册留言也在列） */
  comments: CarryComment[];
  content_sha256: string;
};

export type CarryPlan =
  | { ok: true; images: PlannedCarryImage[]; hasNextOnce: boolean; fragmentImages: PlannedCarryImage[] }
  | { ok: false; code: 'CARRY_IMAGES_EXCEEDED'; count: number; limit: number; detail: string };

/** 合并去重（ALB-07 整改，审计 2026-11-08）：
 *  - 去重键=M 对象身份 content_sha256（同字节不同 E asset_id 仍是同一张图）；
 *  - 选集历史图优先：占额度但不进携带片段——它的图块由选集历史消息投影携带，
 *    片段里再放一份=同图两个图像块（旧缺陷：6 张被算成 12 块）；
 *  - 与选集图同 hash 的相册携带条目：图不重复注入，但其全部留言原样
 *    保留进片段文本（03 §7.2 留言不得丢弃）；
 *  - 其余名额给相册携带（always 先于 next_once；同 hash 多条携带关系合并为一张图
 *    + 留言数组，mode 取先到的 always）。 */
export function planCarryImages(o: {
  selectionImages: SelectionImage[];
  carryItems: Array<CarrySetItem & { content_sha256?: string | null }>;
  resolveHash?: (assetId: string) => string | null;
  limit?: number;
}): CarryPlan {
  const limit = o.limit ?? CARRY_IMAGE_LIMIT;
  const images: PlannedCarryImage[] = [];
  const byHash = new Map<string, PlannedCarryImage>();
  for (const sItem of o.selectionImages) {
    const hash = sItem.content_sha256 || (o.resolveHash ? o.resolveHash(sItem.asset_id) : null) || `est:${sItem.asset_id}`;
    if (byHash.has(hash)) continue;
    const entry: PlannedCarryImage = { asset_id: sItem.asset_id, source: 'selection', comments: [], content_sha256: hash };
    byHash.set(hash, entry);
    images.push(entry);
  }
  const ordered = [...o.carryItems].sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'always' ? -1 : 1));
  let hasNextOnce = o.carryItems.some((c) => c.mode === 'next_once');
  for (const c of ordered) {
    const hash = c.content_sha256 || (o.resolveHash ? o.resolveHash(c.asset_id) : null) || `est:${c.asset_id}`;
    const existing = byHash.get(hash);
    // 同图：全部留言逐条并入（不合并改写；无 caption 无 meaning 的空留言不占行）
    const comment: CarryComment = { caption: c.caption, meaning: c.meaning, added_by: c.added_by };
    if (comment.caption || comment.meaning) {
      if (existing) existing.comments.push(comment);
      else {
        const entry: PlannedCarryImage = { asset_id: c.asset_id, source: `carry_${c.mode}`, comments: [comment], content_sha256: hash };
        byHash.set(hash, entry);
        images.push(entry);
      }
      continue;
    }
    if (existing) continue; // 空留言同图：图已在规划，无新增内容
    const entry: PlannedCarryImage = { asset_id: c.asset_id, source: `carry_${c.mode}`, comments: [], content_sha256: hash };
    byHash.set(hash, entry);
    images.push(entry);
  }
  if (images.length > limit) {
    const selectionCount = images.filter((i) => i.source === 'selection').length;
    const carryCount = images.length - selectionCount;
    return {
      ok: false, code: 'CARRY_IMAGES_EXCEEDED', count: images.length, limit,
      detail: `合并后 ${images.length} 张（选集 ${selectionCount} + 相册携带 ${carryCount}，按 M 对象去重）超过每次滚窗上限 ${limit}；请减选历史消息图片或调低相册携带设置`,
    };
  }
  const fragmentImages = images.filter((i) => i.source !== 'selection');
  return { ok: true, images, hasNextOnce, fragmentImages };
}

const SPEAKER_LABELS: Record<string, string> = { qiaosheng: '乔乔', jiaming: 'char' };

function commentLines(comments: CarryComment[]): string[] {
  if (comments.length === 0) return ['（无留言）'];
  return comments.map((c) => `${SPEAKER_LABELS[c.added_by] ?? c.added_by}：${[c.caption, c.meaning].filter((t): t is string => typeof t === 'string' && t.length > 0).join(' / ')}`);
}

/** 开窗携带块：说明+留言原样文本（选集同图留言单列保留，逐条列出）+ 仅相册携带图的
 *  asset_image 块（选集历史图的图块随消息投影走，不在此重复——ALB-07）。 */
export function buildCarryFragment(fragmentImages: PlannedCarryImage[], allImages: PlannedCarryImage[] = fragmentImages): { blocks: ProjectedBlock[] } | null {
  const carryOnly = fragmentImages.filter((i) => i.source !== 'selection');
  const selectionNotes = allImages.filter((i) => i.source === 'selection' && i.comments.length > 0);
  if (carryOnly.length === 0 && selectionNotes.length === 0) return null;
  const lines: string[] = [];
  if (carryOnly.length > 0) lines.push(`[开窗携带照片 ${carryOnly.length} 张]（来自相册携带设置；留言为收藏时的原话，同图多条逐条保留）`);
  carryOnly.forEach((img, i) => {
    lines.push(`${i + 1}. ${commentLines(img.comments).join('\n   ')}`);
  });
  // 选集历史图（图块在消息里）的相册留言：原样逐条保留、不合并改写（ALB-07 留言不丢）
  for (const n of selectionNotes) {
    lines.push(`[所选历史图片的相册留言] ${commentLines(n.comments).join('；')}`);
  }
  const textBlock = { type: 'text' as const, text: lines.join('\n') };
  const imageBlocks: AssetImageRefBlock[] = carryOnly.map((img) => ({ type: 'asset_image' as const, asset_id: img.asset_id, projection_version: 'v1' as const }));
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
