import type { HostToolSpec, ToolExecContext, ToolExecResult } from '../capabilities/contracts.ts';
import { toolCapability } from '../capabilities/domain-factory.ts';
import type { CapabilityRegistry } from '../capabilities/registry.ts';
import { tx, type Db } from '../db/connection.ts';

export const TURN_COMPLETION_TOOL = 'background_complete';
export type TurnCompletion = 'done' | 'noop';

const definition: HostToolSpec = {
  type: 'function',
  function: {
    name: TURN_COMPLETION_TOOL,
    description: '结束当前回合。done 表示做完了已有动作，noop 表示不用再做或再回复。心跳邀请后尚未抽卡时，noop 表示这次不抽。',
    parameters: {
      type: 'object',
      properties: { outcome: { type: 'string', enum: ['done', 'noop'] } },
      required: ['outcome'],
      additionalProperties: false,
    },
  },
};

type CompletionScope = { completion_outcome: TurnCompletion | null; live: number };

function scopeFor(db: Db, ctx: ToolExecContext): CompletionScope | null {
  if (!ctx.attemptId || !ctx.turnId || ctx.purpose === 'pre_rotate_review') return null;
  const trigger = ctx.purpose === 'chat' ? null : ctx.purpose;
  return (db.prepare(`
    SELECT a.completion_outcome,
           (a.state = 'running' AND t.state = 'running' AND
            (? IS NULL OR b.state = 'running')) AS live
      FROM attempts a JOIN turns t ON t.id = a.turn_id
      LEFT JOIN background_runs b
        ON b.id = ? AND b.turn_id = t.id AND b.window_id = a.window_id
        AND b.conversation_id = t.conversation_id
     WHERE a.id = ? AND t.id = ? AND t.conversation_id = ? AND a.window_id = ?
       AND NOT EXISTS (SELECT 1 FROM attempts newer
                        WHERE newer.turn_id = t.id AND newer.attempt_no > a.attempt_no)
       AND ((? IS NULL AND t.trigger NOT IN ('proactive_turn', 'cache_keepalive'))
            OR (t.trigger = ? AND b.id IS NOT NULL))
  `).get(trigger, ctx.backgroundRunId ?? null, ctx.attemptId, ctx.turnId, ctx.roomId, ctx.windowId, trigger, trigger) as CompletionScope | undefined) ?? null;
}

export function readTurnCompletion(db: Db, attemptId: string, turnId: string | null): TurnCompletion | null {
  if (!turnId) return null;
  const row = db.prepare('SELECT completion_outcome FROM attempts WHERE id = ? AND turn_id = ?')
    .get(attemptId, turnId) as { completion_outcome: TurnCompletion | null } | undefined;
  return row?.completion_outcome ?? null;
}

export function canDiscoverTurnCompletion(db: Db, ctx: ToolExecContext): boolean {
  const scope = scopeFor(db, ctx);
  return scope?.live === 1 && scope.completion_outcome === null;
}

function receipt(outcome: TurnCompletion): ToolExecResult {
  return { ok: true, output: { completed: true, outcome } };
}

/** Match the attempt's single logical operation before any new dispatch admission. */
export function checkTurnCompletion(db: Db, ctx: ToolExecContext, outcome: TurnCompletion): ToolExecResult | null {
  const scope = scopeFor(db, ctx);
  if (scope?.completion_outcome) {
    return scope.completion_outcome === outcome
      ? receipt(scope.completion_outcome)
      : { ok: false, output: { error_code: 'IDEMPOTENCY_CONFLICT' } };
  }
  return scope?.live === 1 ? null : { ok: false, output: { error_code: 'TURN_COMPLETION_NOT_ACTIVE' } };
}

export function registerTurnCompletionCapability(registry: Pick<CapabilityRegistry, 'register'>, db: Db): void {
  registry.register(toolCapability({
    owner: 'turn',
    id: TURN_COMPLETION_TOOL,
    group: 'D',
    baselineOrder: 21,
    free: true,
    definition,
    memoryOnlyAllowed: false,
    label: '结束本轮',
    silent: true,
    run: ({ outcome }: { outcome: TurnCompletion }, ctx) => tx(db, () => {
      // Leave the attempt running until the supervisor has committed receipts
      // for the batch. Only record the decision that fences new dispatches.
      const checked = checkTurnCompletion(db, ctx, outcome);
      if (checked) return checked;
      const result = receipt(outcome);
      ctx.recordCompletionCheckpoint?.(result);
      db.prepare('UPDATE attempts SET completion_outcome = ? WHERE id = ?').run(outcome, ctx.attemptId!);
      return result;
    }),
    toModel: (value: ToolExecResult['output']) => value,
  }));
}
