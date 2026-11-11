// R8′（2026-10-23）：媒体索引后台补全——一跳有界批次。
// 独立任务边界：调用方为 app-context 的独立 setInterval（不经 BackgroundScheduler/
// enqueueBackground/supervisor 会话串行链——调度器的模型执行走同一 runSerialized，搬进去
// 只是换入口排队）。纯本地 worker HTTP 调用，无模型执行、无计价。
// RR4-W2a（林石见 2026-11-10 修正稿）：索引覆盖来源 = 聊天图片附件（房间轮转，既有）
// ∪ 相册有效成员 ∪ 作品图片资产——仅收藏/仅入表情/仅存作品、未发进聊天的图同链补齐。
// 相册/作品枚举按游标跨 tick 续进（每跳 ≤3 页拉取 + ≤5 张编码，到末尾换下一个来源，
// 全来源到尾后开始下一轮）；不重复全量扫描，也不新增定时器/任务平台/第二套索引。
// 枚举来源是 E 侧业务可读集合的正本（content 相册+作品）；M 媒体间独立存在、无 E
// 资产行的对象不经本索引面（indexImage 需要 E 资产正本），如实不冒充覆盖。
import type { MediaIndexService } from './service.ts';

export const MEDIA_BACKFILL_BATCH_PER_TICK = 5;
const SOURCE_PAGES_PER_TICK = 3; // 每跳枚举拉取页数上界（约束枚举工作量，不约束业务范围）

/** 一个枚举来源的一页候选（asset_id 列表 + 续读游标；next=null=到末尾）。 */
export type MediaSourcePage = { assets: string[]; next: string | null };
/** 来源页拉取器：source 形如 'album:stickers'|'creations'。返回 null=该来源本轮不可用
 *  （游标保留，下一跳重试；不算失败也不推进完成状态）。 */
export type MediaSourceFetcher = (source: string, cursor: string | null) => Promise<MediaSourcePage | null>;

// RE-18（2026-10-24 返修）：公平推进——坏源不再饿死后到的房间/图片。
//  - 房间轮转游标（按 worker 指纹）：每跳服务的房间按轮转起点选择，首房间坏图
//    连续失败时第二跳即轮到后续房间（上轮反例：恒取首房间，第二房间零服务）；
//  - 单图失败退避：连续失败按 30s·2^min(n,5) 指数退避，退避期内跳过——坏前 5 张
//    全在退避时第 6 张好图同跳可达（不恢复任何秒数硬截止；成功即清退避）。
//  进程内状态；跨重启的持久进度表未落地（如实记录：重启后退避计数归零重试一轮）。
const roomCursor = new Map<string, number>();
const failureStreak = new Map<string, number>();
const retryNotBefore = new Map<string, number>();

// RR4-W2a：来源枚举的跨 tick 进度（按 worker 指纹）。游标续进；来源到尾置 done，
// 全来源 done 后清空开始下一轮。buffer=已拉取未编码的候选（页内配额耗尽不重拉）。
type SourceProgress = { idx: number; cursors: Map<string, string | null>; done: Set<string>; buffer: string[] };
const sourceProgress = new Map<string, SourceProgress>();

/** 一跳：房间轮转（聊天附件）+ 相册/作品来源（游标续进），各自 ≤5 张入索引。 */
export async function runMediaBackfillTick(
  mediaIndex: MediaIndexService,
  signal: AbortSignal,
  sources: string[] = [],
  fetchPage?: MediaSourceFetcher,
): Promise<number> {
  if (!mediaIndex.available || signal.aborted) return 0;
  const fingerprint = await mediaIndex.workerFingerprint(signal).catch(() => null);
  if (!fingerprint) return 0; // worker 不可用/测试 fake 门：本跳跳过
  let indexed = 0;
  const now = Date.now();
  const rooms = mediaIndex.roomsWithUnindexedImages(fingerprint);
  if (rooms.length > 0) {
    // 游标=当前服务房间：做完留在原地（既有合同）；无可尝试项（做完/全在退避）才推进
    const offset = (roomCursor.get(fingerprint) ?? 0) % rooms.length;
    const ordered = [...rooms.slice(offset), ...rooms.slice(0, offset)];
    for (const roomId of ordered) {
      if (signal.aborted) return indexed;
      let attempted = 0;
      for (const assetId of mediaIndex.unindexedImagesInRoom(roomId, fingerprint)) {
        if (signal.aborted) return indexed;
        if (attempted >= MEDIA_BACKFILL_BATCH_PER_TICK) break;
        if ((retryNotBefore.get(assetId) ?? 0) > now) continue; // 退避期：跳过不占批次
        try {
          if ((await mediaIndex.indexImage(assetId, signal)).indexed) indexed += 1;
          failureStreak.delete(assetId);
          retryNotBefore.delete(assetId);
        } catch {
          const n = (failureStreak.get(assetId) ?? 0) + 1;
          failureStreak.set(assetId, n);
          retryNotBefore.set(assetId, now + 30_000 * 2 ** Math.min(n, 5));
        }
        attempted += 1;
      }
      // 每跳一个有作为的房间（有界批次）；本房间无可尝试项（做完/全在退避）才让位给
      // 轮转中的下一房间——既有合同（本房间做完再换）与公平（坏源退避不堵后房）兼得
      if (attempted > 0) {
        roomCursor.set(fingerprint, offset + ordered.indexOf(roomId)); // 留在本房间
        break;
      }
    }
  }
  if (sources.length === 0 || !fetchPage) return indexed;

  // —— 相册/作品来源：游标续进的有界枚举 + 编码（同一退避机制） ——
  let prog = sourceProgress.get(fingerprint);
  if (!prog) {
    prog = { idx: 0, cursors: new Map(), done: new Set(), buffer: [] };
    sourceProgress.set(fingerprint, prog);
  }
  if (prog.done.size >= sources.length) { prog.done.clear(); prog.cursors.clear(); prog.idx = 0; } // 全来源到尾：下一轮
  let pagesFetched = 0;
  let attempted = 0;
  while (attempted < MEDIA_BACKFILL_BATCH_PER_TICK && pagesFetched < SOURCE_PAGES_PER_TICK && !signal.aborted) {
    if (prog.buffer.length === 0) {
      let page: MediaSourcePage | null = null;
      for (let hops = 0; hops < sources.length && page === null; hops++) {
        if (prog.idx >= sources.length) prog.idx = 0;
        const src = sources[prog.idx]!;
        if (prog.done.has(src)) { prog.idx += 1; continue; }
        page = await fetchPage(src, prog.cursors.get(src) ?? null);
        if (page === null) { prog.idx += 1; continue; } // 本轮不可用：游标保留，让位下一来源
        pagesFetched += 1;
        prog.cursors.set(src, page.next);
        if (page.next === null) { prog.done.add(src); prog.idx += 1; }
      }
      if (page === null) break; // 全来源本轮不可用或全在尾段：结束本跳
      prog.buffer = page.assets;
      if (prog.buffer.length === 0) continue;
    }
    const assetId = prog.buffer.shift()!;
    if ((retryNotBefore.get(assetId) ?? 0) > now) continue;
    if (mediaIndex.assetIndexed(assetId, fingerprint)) continue; // 已索引：不占编码配额
    try {
      if ((await mediaIndex.indexImage(assetId, signal)).indexed) indexed += 1;
      failureStreak.delete(assetId);
      retryNotBefore.delete(assetId);
    } catch {
      const n = (failureStreak.get(assetId) ?? 0) + 1;
      failureStreak.set(assetId, n);
      retryNotBefore.set(assetId, now + 30_000 * 2 ** Math.min(n, 5));
    }
    attempted += 1;
  }
  return indexed;
}
