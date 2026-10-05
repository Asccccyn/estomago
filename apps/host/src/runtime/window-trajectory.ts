// 每窗口 append-only 协议轨迹（§2.2/§7.1）：实际送出的有序输入投影的唯一正本。
// 成功回合才推进（失败回合不落轨迹——provider_requests 仍逐笔记录实际发送供审计）；
// 换窗重建新轨迹（近期原话固定为初始段）；跨轮 previousPayload 断言以本表为依据。
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import type { OrMessage } from './or-payload.ts';
import type { PrevBoundary } from './cache-plan.ts';

export type TrajectoryRow = { windowId: string; messages: OrMessage[]; lastBoundary: PrevBoundary | null };

export class WindowTrajectoryService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  forWindow(windowId: string): TrajectoryRow | null {
    const row = this.db.prepare('SELECT messages_json, last_boundary_json FROM window_trajectories WHERE window_id = ?').get(windowId) as
      | { messages_json: string; last_boundary_json: string | null }
      | undefined;
    if (!row) return null;
    return {
      windowId,
      messages: JSON.parse(row.messages_json) as OrMessage[],
      lastBoundary: row.last_boundary_json ? (JSON.parse(row.last_boundary_json) as PrevBoundary) : null,
    };
  }

  /** 初始化（幂等）：system + 近期原话固定为初始段（§7.1：首次规范化后固定） */
  init(windowId: string, messages: OrMessage[]): void {
    if (this.forWindow(windowId) !== null) return;
    tx(this.db, () => {
      this.db.prepare('INSERT INTO window_trajectories(window_id, messages_json, last_boundary_json, updated_at) VALUES (?,?,NULL,?)')
        .run(windowId, JSON.stringify(messages), new Date().toISOString());
    });
  }

  /** 成功回合后整体替换（append-only 语义由调用方保证：只允许在旧数组尾部追加） */
  replace(windowId: string, messages: OrMessage[], lastBoundary: PrevBoundary | null): void {
    tx(this.db, () => {
      this.db.prepare('UPDATE window_trajectories SET messages_json = ?, last_boundary_json = ?, updated_at = ? WHERE window_id = ?')
        .run(JSON.stringify(messages), lastBoundary ? JSON.stringify(lastBoundary) : null, new Date().toISOString(), windowId);
    });
  }
}
