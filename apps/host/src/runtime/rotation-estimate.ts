// 换窗工作集估算——R4b（2026-11-07）自 supervisor.rotateIfNeeded 迁出，行为逐字保留。
// 政策单一正本：旧窗工作集（硬门口径）=实际发送载荷（轨迹消息+冻结工具目录）与
// 上次实际 usage 校准取 max；下一输入预测=工作集+本轮新增输入。改换窗容量口径只看本文件。
import type { Db } from '../db/connection.ts';
import type { OrMessage } from './or-payload.ts';
import type { TrajectoryRow } from './window-trajectory.ts';
import { lastRequestUsageForWindow, providerInputTotal } from '../usage/attribution.ts';
import { HOST_BOUNDARY_RULES } from '../context/fixed-runtime.ts';

export type RotationMaterials = { identityText: string; rulesText: string; iText: string | null } | null;

/** 系统段字符（identity+I+规则+固定运行片段+边界规则）——轨迹路径 system 段已在
 *  messages 内时由调用方取 0（F-J-33 只在无轨迹回退时计入）。 */
export function systemFragmentChars(materials: RotationMaterials): number {
  return (materials?.identityText.length ?? 0) + (materials?.rulesText.length ?? 0) + (materials?.iText?.length ?? 0) + HOST_BOUNDARY_RULES.length;
}

export function estimateRotationWorkingSet(input: {
  db: Db;
  conversationId: string;
  currentInputSequence: number;
  windowId: string;
  trajectoryRow: TrajectoryRow | null;
  fallbackDialogue: Array<{ id: string; revision: number; sequence: number; role: 'user' | 'assistant'; content: string; turnId: string | null }>;
  materials: RotationMaterials;
  charsPerToken: number | null;
  /** 注入：与工具循环硬门同一口径（含冻结工具目录）的 token 估算 */
  estimateTokensFor: (messages: unknown[]) => number;
}): { workingSet: number; nextWithIncoming: number } {
  const charsPerToken = input.charsPerToken ?? 1.5;
  // D06（审计 3655d60）：**旧窗工作集不含新入站消息**——硬门只判旧窗自身是否无可挽回（blocked_hard）；
  // 新消息长度只并入"下一输入"预测触发换窗（§4.2：大输入先保存、先提醒旧窗、新输入只进新窗一次）。
  // 新窗装下新输入的最终校验由工具循环每轮的 P2 容量门承担（F03 尾），真实硬门不放松。
  const currentInputLen = (input.db.prepare(
    `SELECT LENGTH(r.content) AS len FROM messages m JOIN message_revisions r ON r.message_id = m.id AND r.revision = m.current_revision
     WHERE m.conversation_id = ? AND m.sequence = ?`,
  ).get(input.conversationId, input.currentInputSequence) as { len: number | null } | undefined)?.len ?? 0;
  // 审计 F25：估算只用实际发送集合——轨迹正本（无轨迹的新窗首轮回退库内近期，此时二者一致）。
  // 被拒/未发送的历史大消息不得污染当前工作集（否则短输入被持续 CAPACITY_BLOCKED_HARD）。
  // 她 1024 裁定②：工作集=实际发送载荷（轨迹消息+冻结工具目录，与工具循环硬门同一口径）
  const trajMessagesForEstimate: unknown[] = input.trajectoryRow ? input.trajectoryRow.messages : input.fallbackDialogue;
  // F-J-33：无轨迹回退路径补 system 材料（轨迹路径 system 段已在 messages 内）
  const systemChars = input.trajectoryRow ? 0 : systemFragmentChars(input.materials);
  const oldWindowEstimate = input.estimateTokensFor(trajMessagesForEstimate) + Math.ceil(systemChars / charsPerToken); // 旧窗自身工作集
  const lastUsage = lastRequestUsageForWindow(input.db, input.windowId);
  const lastActual = lastUsage ? providerInputTotal(lastUsage) : null;
  const workingSet = Math.max(oldWindowEstimate, lastActual ?? 0);
  // R21（复审 2026-10-07）：下一输入=旧工作集+本轮新增输入（system 只计
  // 一次）——此前 Math.max(workingSet, incomingEstimate) 漏加本轮输入，
  // 临界消息在旧窗超软线却不触发提醒/换窗（既有问题，硬门不受影响）
  const nextWithIncoming = workingSet + Math.ceil(currentInputLen / charsPerToken);
  return { workingSet, nextWithIncoming };
}

export type { OrMessage };
