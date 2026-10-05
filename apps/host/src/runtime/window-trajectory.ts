// 每窗口 append-only 协议轨迹（§2.2/§7.1）：实际送出的有序输入投影的唯一正本。
// 成功回合才推进（失败回合不落轨迹——provider_requests 仍逐笔记录实际发送供审计）；
// 换窗重建新轨迹（近期原话固定为初始段）；跨轮 previousPayload 断言以本表为依据。
// 审计 F06/F14：manifest_json=实际已见对话清单（id/revision/seq）——提醒范围、书签视野、
// 已检查去重全部以这份"实际发送证据"为准，不从聊天库另行投影。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import type { OrMessage } from './or-payload.ts';
import type { PrevBoundary } from './cache-plan.ts';
import type { ManifestEntry } from '../context/review-policy.ts';

export type TrajectoryRow = { windowId: string; messages: OrMessage[]; lastBoundary: PrevBoundary | null; manifest: ManifestEntry[] | null }; // manifest=null：v11 前旧行未知（F27：不当作空清单）

export class WindowTrajectoryService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  forWindow(windowId: string): TrajectoryRow | null {
    const row = this.db.prepare('SELECT messages_json, last_boundary_json, manifest_json FROM window_trajectories WHERE window_id = ?').get(windowId) as
      | { messages_json: string; last_boundary_json: string | null; manifest_json: string | null }
      | undefined;
    if (!row) return null;
    return {
      windowId,
      messages: JSON.parse(row.messages_json) as OrMessage[],
      lastBoundary: row.last_boundary_json ? (JSON.parse(row.last_boundary_json) as PrevBoundary) : null,
      manifest: row.manifest_json === null ? null : (JSON.parse(row.manifest_json) as ManifestEntry[]),
    };
  }

  /** 初始化（幂等）：system+I+近期原话固定为初始段；manifest=初始段对应的真实消息清单 */
  init(windowId: string, messages: OrMessage[], manifest: ManifestEntry[]): void {
    if (this.forWindow(windowId) !== null) return;
    tx(this.db, () => {
      this.db.prepare('INSERT INTO window_trajectories(window_id, messages_json, last_boundary_json, manifest_json, updated_at) VALUES (?,?,NULL,?,?)')
        .run(windowId, JSON.stringify(messages), JSON.stringify(manifest), new Date().toISOString());
    });
  }

  /** 审计 F27：只为旧轨迹行回填重建出的 manifest（不动消息/边界） */
  replaceManifest(windowId: string, manifest: ManifestEntry[]): void {
    tx(this.db, () => {
      this.db.prepare('UPDATE window_trajectories SET manifest_json = ?, updated_at = ? WHERE window_id = ?')
        .run(JSON.stringify(manifest), new Date().toISOString(), windowId);
    });
  }

  /** 成功回合后整体替换（append-only 语义由调用方保证；manifest 与 messages 同步推进） */
  replace(windowId: string, messages: OrMessage[], lastBoundary: PrevBoundary | null, manifest: ManifestEntry[]): void {
    tx(this.db, () => {
      this.db.prepare('UPDATE window_trajectories SET messages_json = ?, last_boundary_json = ?, manifest_json = ?, updated_at = ? WHERE window_id = ?')
        .run(JSON.stringify(messages), lastBoundary ? JSON.stringify(lastBoundary) : null, JSON.stringify(manifest), new Date().toISOString(), windowId);
    });
  }
}
