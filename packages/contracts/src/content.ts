export const CONTENT_ALBUMS = [
  { album: 'chat_screenshots', title: '聊天截图' },
  { album: 'important_photos', title: '重要照片' },
  { album: 'stickers', title: '表情' },
] as const;

// —— 相册重构携带合同（GLM_ALBUM_REFACTOR_EXECUTION 20261108，03 §7/§8）——
// 每次滚窗带入下一上下文段的图片总数上限。这是跨相册、跨模式、含手选历史图片的
// 合并上限的唯一正本常量：content 的携带设置写入校验与 E 的滚窗装配/派发校验都必须
// 引用本值，不得在别处另立 10。E 是最终投递额度的唯一正本（03 §8.6）；本常量只是
// 两侧共用的数字合同。
export const CARRY_IMAGE_LIMIT = 10;

// 携带模式（03 §7.1 三模式）：none=仅收藏；next_once=下次滚窗一次（成功投递后由 E
// 经 consume 接口消费）；always=每次滚窗（可随时改回 none 取消）。
export const CARRY_MODES = ['none', 'next_once', 'always'] as const;
export type CarryMode = (typeof CARRY_MODES)[number];

// E 读取的合并有效携带集合（按 asset 去重；同一 asset 既有 always 又有 next_once 时
// 以 always 为准——去重后身份唯一，留言取该 asset 首条携带关系）。
export type CarrySetItem = {
  asset_id: string;
  mode: Exclude<CarryMode, 'none'>;
  entry_id: string;
  kind: string;
  caption: string | null;
  meaning: string | null;
  added_by: 'qiaosheng' | 'jiaming';
};
export type CarrySet = { limit: number; items: CarrySetItem[] };
