// R8′（2026-10-23）：媒体索引后台补全——一跳有界批次。
// 独立任务边界：调用方为 app-context 的独立 setInterval（不经 BackgroundScheduler/
// enqueueBackground/supervisor 会话串行链——调度器的模型执行走同一 runSerialized，搬进去
// 只是换入口排队）。纯本地 worker HTTP 调用，无模型执行、无计价。
import type { MediaIndexService } from './service.ts';

export const MEDIA_BACKFILL_BATCH_PER_TICK = 5;

// RE-18（2026-10-24 返修）：公平推进——坏源不再饿死后到的房间/图片。
//  - 房间轮转游标（按 worker 指纹）：每跳服务的房间按轮转起点选择，首房间坏图
//    连续失败时第二跳即轮到后续房间（上轮反例：恒取首房间，第二房间零服务）；
//  - 单图失败退避：连续失败按 30s·2^min(n,5) 指数退避，退避期内跳过——坏前 5 张
//    全在退避时第 6 张好图同跳可达（不恢复任何秒数硬截止；成功即清退避）。
//  进程内状态；跨重启的持久进度表未落地（如实记录：重启后退避计数归零重试一轮）。
const roomCursor = new Map<string, number>();
const failureStreak = new Map<string, number>();
const retryNotBefore = new Map<string, number>();

/** 一跳：worker 指纹可用时，轮转选择一个房间，跳过退避中的坏图，最多 5 张入索引。 */
export async function runMediaBackfillTick(mediaIndex: MediaIndexService, signal: AbortSignal): Promise<number> {
  if (!mediaIndex.available || signal.aborted) return 0;
  const fingerprint = await mediaIndex.workerFingerprint(signal).catch(() => null);
  if (!fingerprint) return 0; // worker 不可用/测试 fake 门：本跳跳过
  let indexed = 0;
  const rooms = mediaIndex.roomsWithUnindexedImages(fingerprint);
  if (rooms.length === 0) return 0;
  // 游标=当前服务房间：做完留在原地（既有合同）；无可尝试项（做完/全在退避）才推进
  const offset = (roomCursor.get(fingerprint) ?? 0) % rooms.length;
  const ordered = [...rooms.slice(offset), ...rooms.slice(0, offset)];
  const now = Date.now();
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
  return indexed;
}
