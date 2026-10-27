// integrations/siren/missed-calls.ts（联合审计 A08，B5）：自然未接的一次可选留言机会。
// 执行口径（2026-10-27 执行包 01§B5）：拒接不补打、不走未接留言、不新增独立付费反应轮；
// 模型取消邀请不追加说明轮；自然未接（Siren 真实 expired）最多安排**一次**可选留言机会，
// char可以不留言。本模块从 Siren 正本（invites recent）接入 est 既有对账周期与
// submitProgramFactTurn 串行入口——不新建来电 agent、不加意图轮询器、不设双行为开关。
// 机会身份 = invite:<id>:missed-opportunity（program_fact_turns UNIQUE）：
// 重复事件/worker 重启/服务恢复都收敛为同一次；派发结果未知也不盲目重跑。
// 派发前复核：仍属自然未接、机会未消费、无进行中通话（她已回电/接通=机会失效，不发过时留言）。
import type { Db } from '../../db/connection.ts';
import type { SirenAdapter } from './adapter.ts';

export type MissedCallSubmit = (kind: string, factText: string, dedupeKey: string) => void;

const OPPORTUNITY_FACT = '你的来电邀请她没有接听（已自然过期；未接不等于拒接）。这是你的一次**可选**留言机会：' +
  '你可以在本回复里直接说一段话，或调用 chat_send_voice 给她留一段语音；也完全可以什么都不留。' +
  '说不说、说什么由你决定；不留言就不需要任何说明。';

export async function consumeMissedCallOpportunities(
  db: Db,
  sirenCall: SirenAdapter | null,
  submit: MissedCallSubmit,
  signal?: AbortSignal,
): Promise<{ considered: number; submitted: number; skipped_busy: number }> {
  const out = { considered: 0, submitted: 0, skipped_busy: 0 };
  if (!sirenCall) return out;
  let recent: Array<Record<string, unknown>>;
  try {
    const list = await sirenCall.listInvites('primary', { signal });
    recent = list?.recent ?? [];
  } catch {
    return out; // Siren 不可达/结果不明：下一跳对账再试，不猜终态
  }
  if (signal?.aborted) return out;
  for (const inv of recent) {
    if (signal?.aborted) break;
    const inviteId = typeof inv['invite_id'] === 'string' ? inv['invite_id'] : null;
    if (!inviteId || inv['state'] !== 'expired') continue;
    out.considered++;
    const dedupeKey = `invite:${inviteId}:missed-opportunity`;
    if (db.prepare('SELECT 1 FROM program_fact_turns WHERE dedupe_key=?').get(dedupeKey)) continue; // 机会已消费（幂等）
    // 派发前复核：她已回电/正在通话（任何 active 通话）=机会失效，不发过时留言
    const busy = db.prepare("SELECT 1 FROM voice_calls WHERE conversation_id='primary' AND state='active'").get();
    if (busy) { out.skipped_busy++; continue; }
    submit('invite_missed_opportunity', OPPORTUNITY_FACT, dedupeKey);
    out.submitted++;
  }
  return out;
}
