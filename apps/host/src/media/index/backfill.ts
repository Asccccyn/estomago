// R8′（2026-10-23）：媒体索引后台补全——一跳有界批次。
// 独立任务边界：调用方为 app-context 的独立 setInterval（不经 BackgroundScheduler/
// enqueueBackground/supervisor 会话串行链——调度器的模型执行走同一 runSerialized，搬进去
// 只是换入口排队）。纯本地 worker HTTP 调用，无模型执行、无计价。
import type { MediaIndexService } from './service.ts';

export const MEDIA_BACKFILL_BATCH_PER_TICK = 5;

/** 一跳：worker 指纹可用时，取一个房间最多 5 张未索引图入索引；单图失败下一跳再试。 */
export async function runMediaBackfillTick(mediaIndex: MediaIndexService, signal: AbortSignal): Promise<number> {
  if (!mediaIndex.available || signal.aborted) return 0;
  const fingerprint = await mediaIndex.workerFingerprint(signal).catch(() => null);
  if (!fingerprint) return 0; // worker 不可用/测试 fake 门：本跳跳过
  let indexed = 0;
  const rooms = mediaIndex.roomsWithUnindexedImages(fingerprint);
  for (const roomId of rooms.slice(0, 1)) { // 每跳一个房间（有界公平）
    for (const assetId of mediaIndex.unindexedImagesInRoom(roomId, fingerprint).slice(0, MEDIA_BACKFILL_BATCH_PER_TICK)) {
      if (signal.aborted) return indexed;
      try { if ((await mediaIndex.indexImage(assetId, signal)).indexed) indexed += 1; } catch { /* 单图失败下跳再试 */ }
    }
  }
  return indexed;
}
