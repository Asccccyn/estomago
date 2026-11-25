// WAKE_KEEPWARM_V1 + Heartbeat v2.1 (2026-11-24):
// Unified conversation heartbeat state and authoritative schedule evaluator.
// Strictly separates three facts:
//   1. Owner appearance (`user_appearance_revision`, `last_user_message_*`) -> resets consecutive count
//   2. Real chat anchor (`last_real_activity_at`, `activity_revision`) & effective heartbeat start
//      (`last_effective_heartbeat_at`) -> drives the 50-minute schedule
//   3. Consecutive unanswered automatic heartbeats (`consecutive_unanswered_count`, capped at 3) ->
//      counted once per logical confirmed-sent keepwarm run, CAS-guarded by `user_appearance_revision`.
import type { Db } from '../db/connection.ts';
import { tx } from '../db/connection.ts';
import { POLICY_CONSTANTS } from '../config/policy-constants.ts';
import { effectiveRevisionText } from '../messages/effective-text.ts';
import { HEARTBEAT_BLOCKED_BEFORE_SEND } from './background-ledger.ts';
import { CACHE_TTL_MS } from './cache-observation.ts';
import {
  classifyRestFallbackWithoutSol,
  classifyRestLocally,
  classifyRestRecoveryMode,
  detectRestKindLocally,
  type RestKind,
  type RestRecoveryMode,
} from './conversation-rest.ts';
import type { SolRestJudgment } from './conversation-rest-sol.ts';
import {
  addCalendarDays,
  effectiveSleepState,
  keepwarmSleepState,
  overnightMorningDate,
  type SleepWindowConfig,
} from './keepwarm-sleep.ts';

export const MORNING_WAKE_OCCURRENCE_PREFIX = 'morning-wake:';
/** Grace window for truly-offline missed morning fallback (10 minutes). */
export const MORNING_WAKE_GRACE_MS = CACHE_TTL_MS - POLICY_CONSTANTS.background.keepwarm.idle_after_cache_ms;
/** Nighttime early-resume gap threshold: exactly 4 hours (14,400 seconds), millisecond precision. */
export const NIGHT_EARLY_RESUME_GAP_MS = 4 * 3_600_000;
/** Pause automatic heartbeats after 3 consecutive unanswered automatic rounds. */
export const MAX_CONSECUTIVE_UNANSWERED_HEARTBEATS = 3;

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

export function shanghaiDateOfMs(nowMs: number): string {
  return new Date(nowMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function morningWakeOccurrenceKey(conversationId: string, businessDate: string): string {
  return `${MORNING_WAKE_OCCURRENCE_PREFIX}${conversationId}:${businessDate}`;
}

export function isMorningWakeOccurrence(occurrenceKey: string | null | undefined): boolean {
  return typeof occurrenceKey === 'string'
    && occurrenceKey.startsWith(MORNING_WAKE_OCCURRENCE_PREFIX)
    && !occurrenceKey.includes(':recovered:')
    && !occurrenceKey.includes(':deferred:');
}

export function isMorningWakeRun(db: Db, runId: string | null | undefined): boolean {
  if (!runId) return false;
  const row = db.prepare('SELECT occurrence_key FROM background_runs WHERE id = ?').get(runId) as { occurrence_key: string } | undefined;
  return isMorningWakeOccurrence(row?.occurrence_key);
}

export type MorningWakeTarget =
  | {
      scheduled: true;
      businessDate: string;
      dueAtMs: number;
      basis: 'morning_baseline' | 'morning_postponed';
      postponedByAtMs: number | null;
    }
  | {
      scheduled: false;
      businessDate: string;
      reason:
        | 'SLEEP_CONFIG_INVALID'
        | 'NO_ACTIVE_WINDOW'
        | 'ALREADY_CONSUMED'
        | 'DAYTIME_RESTING'
        | 'WAIT_NEXT_USER_MESSAGE'
        | 'SUPERSEDED_BY_EARLY_RESUME'
        | 'MISSED_GRACE'
        | 'MISSED_WHILE_DISABLED'
        | 'SLEEP_WINDOW'
        | 'REST_JUDGMENT_PENDING';
      dueAtMs?: number;
      basis?: 'morning_baseline' | 'morning_postponed';
      postponedByAtMs?: number | null;
    };

export type HeartbeatScheduleState = {
  scheduled: boolean;
  /** Which execution path applies when dueAtMs <= nowMs. */
  kind: 'morning_wake' | 'cache_idle' | 'none';
  dueAtMs: number | null;
  basis: 'morning_baseline' | 'real_message' | 'maintenance' | null;
  /** Authoritative anchor identity matching dueAtMs for unique occurrence_key claiming. */
  anchorKey: string | null;
  businessDate: string;
  blockedReason:
    | 'KEEPWARM_DISABLED'
    | 'KEEPWARM_SLEEP_CONFIG_INVALID'
    | 'REST_JUDGMENT_PENDING'
    | 'KEEPWARM_RESTING'
    | 'KEEPWARM_RESTING_WAIT_USER'
    | 'KEEPWARM_CONSECUTIVE_LIMIT'
    | 'KEEPWARM_SLEEP_WINDOW'
    | 'MORNING_WAKE_MISSED_GRACE'
    | null;
  sleepWindowActive: boolean;
  localTime: string | null;
  /** Conditional next 08:00 fallback preview (NULL when disabled or catch-up/nap wait-user). */
  nextMorningPreview: { targetAtMs: number; businessDate: string } | null;
  resting: boolean;
  restRecoveryMode: RestRecoveryMode | null;
  restMorningDate: string | null;
  earlyResumedDate: string | null;
  consecutiveUnansweredCount: number;
  pendingRestJudgment: boolean;
  activityRevision: number;
  userAppearanceRevision: number;
};

export type ConversationActivityRow = {
  conversation_id: string;
  activity_revision: number;
  last_real_message_id: string | null;
  last_real_message_revision: number | null;
  last_real_activity_at: string | null;
  maintenance_request_id: string | null;
  maintenance_for_activity_revision: number | null;
  maintenance_window_id: string | null;
  maintenance_dispatch_started_at: string | null;
  resting: number;
  rest_decided_at: string | null;
  rest_source: RestDecision['source'] | null;
  rest_message_id: string | null;
  user_appearance_revision: number;
  last_user_message_id: string | null;
  last_user_message_at: string | null;
  rest_recovery_mode: RestRecoveryMode | null;
  rest_morning_date: string | null;
  early_resumed_date: string | null;
  morning_fallback_superseded_date: string | null;
  morning_yielded_date: string | null;
  morning_yielded_at: string | null;
  consecutive_unanswered_count: number;
  last_effective_heartbeat_at: string | null;
  last_effective_heartbeat_run_id: string | null;
  last_effective_heartbeat_window_id: string | null;
  streak_paused_date: string | null;
  pending_rest_message_id: string | null;
  pending_rest_revision: number | null;
  pending_rest_accepted_at: string | null;
  pending_rest_control_revision: number | null;
  pending_rest_user_appearance_revision: number | null;
  pending_rest_was_night_pause: number | null;
  pending_rest_gap_eligible: number | null;
  keepwarm_suppressed_due_before_at: string | null;
  updated_at: string;
};

/** The owner's standing decision to pause the heartbeat. */
export type RestDecision =
  | { kind: 'rest' | 'resume'; source: 'owner_message'; messageId: string; atIso: string; restKind?: RestKind }
  | { kind: 'resume'; source: 'control'; atIso: string };

export type RestState = {
  resting: boolean;
  decided_at: string | null;
  source: RestDecision['source'] | null;
  recovery_mode?: RestRecoveryMode | null;
  morning_date?: string | null;
};

export class ConversationActivityService {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  get(conversationId: string): ConversationActivityRow | null {
    return (this.db.prepare('SELECT * FROM conversation_activity WHERE conversation_id = ?').get(conversationId) as ConversationActivityRow | undefined) ?? null;
  }

  resting(conversationId: string): boolean {
    return this.get(conversationId)?.resting === 1;
  }

  restState(conversationId: string): RestState {
    const row = this.get(conversationId);
    return {
      resting: row?.resting === 1,
      decided_at: row?.rest_decided_at ?? null,
      source: row?.rest_source ?? null,
      recovery_mode: row?.rest_recovery_mode ?? null,
      morning_date: row?.rest_morning_date ?? null,
    };
  }

  /** Whether the fixed nighttime sleep window (e.g. 23:00–08:00) is CURRENTLY active
   *  and not already exempted by an early resume for this overnight cycle. */
  isInActiveSleepWindow(row: ConversationActivityRow | null, sleepWindow: SleepWindowConfig, nowMs: number): boolean {
    const sleep = keepwarmSleepState(sleepWindow, nowMs);
    const overnightDate = overnightMorningDate(sleepWindow, nowMs);
    if (sleep.blocked && sleep.code === 'KEEPWARM_SLEEP_WINDOW' && overnightDate !== null) {
      return row?.early_resumed_date !== overnightDate;
    }
    return false;
  }

  /** Whether the conversation is currently in nighttime pause (either inside the
   *  unresumed sleep window, or in an active normal-night-rest waiting for 08:00). */
  isInNightPause(row: ConversationActivityRow | null, sleepWindow: SleepWindowConfig, nowMs: number): boolean {
    if (this.isInActiveSleepWindow(row, sleepWindow, nowMs)) return true;
    if (row?.resting === 1 && row.rest_recovery_mode === 'morning_0800' && row.rest_morning_date) {
      const targetMs = Date.parse(`${row.rest_morning_date}T08:00:00+08:00`);
      if (Number.isFinite(targetMs) && nowMs < targetMs) return true;
    }
    return false;
  }

  /** Single shared writer for a confirmed owner rest decision (used by local fast-path,
   *  Sol async adoption, message-edit re-evaluation, and direct noteRestDecision).
   *  Atomically updates rest recovery mode and clears any prior early-resume / superseded
   *  morning markers belonging to this rest's cycle so a new normal night rest restores 08:00. */
  private applyRestDecisionInTx(input: {
    conversationId: string;
    prev: ConversationActivityRow | null;
    messageId: string;
    acceptedAtIso: string;
    acceptMs: number;
    restKind: RestKind;
    requireUserAppearanceRevision?: number;
  }): boolean {
    const { mode, morningDate } = classifyRestRecoveryMode(input.acceptMs, input.restKind);
    const today = shanghaiDateOfMs(input.acceptMs);
    const cycleDate = mode === 'morning_0800' ? morningDate : today;
    const nextEarlyResumed = cycleDate && input.prev?.early_resumed_date === cycleDate
      ? null
      : (input.prev?.early_resumed_date ?? null);
    const nextMorningSuperseded = mode === 'morning_0800' && morningDate && input.prev?.morning_fallback_superseded_date === morningDate
      ? null
      : (input.prev?.morning_fallback_superseded_date ?? null);
    const whereClause = input.requireUserAppearanceRevision !== undefined
      ? 'WHERE conversation_id = ? AND user_appearance_revision = ?'
      : 'WHERE conversation_id = ?';
    const params = [
      input.acceptedAtIso,
      input.messageId,
      mode,
      morningDate,
      nextEarlyResumed,
      nextMorningSuperseded,
      input.acceptedAtIso,
      input.conversationId,
      ...(input.requireUserAppearanceRevision !== undefined ? [input.requireUserAppearanceRevision] : []),
    ];
    const res = this.db.prepare(`
      UPDATE conversation_activity SET
        resting = 1,
        rest_decided_at = ?,
        rest_source = 'owner_message',
        rest_message_id = ?,
        rest_recovery_mode = ?,
        rest_morning_date = ?,
        early_resumed_date = ?,
        morning_fallback_superseded_date = ?,
        pending_rest_message_id = NULL,
        pending_rest_revision = NULL,
        pending_rest_accepted_at = NULL,
        pending_rest_control_revision = NULL,
        pending_rest_user_appearance_revision = NULL,
        pending_rest_was_night_pause = NULL,
        pending_rest_gap_eligible = NULL,
        updated_at = ?
      ${whereClause}
    `).run(...params);
    return Number(res.changes) === 1;
  }

  /** Called inside submitUserMessageWithTurn's SQL transaction on FIRST formal acceptance
   *  of an owner foreground message, BEFORE noteRealPublication overwrites last_real_activity_at.
   *  Computes exact pre-overwrite nighttime gap, increments user_appearance_revision, resets
   *  consecutive unanswered count, and either applies immediate local rest/recovery or stages
   *  a fenced pending Sol rest judgment. */
  noteOwnerMessageAccepted(input: {
    conversationId: string;
    messageId: string;
    revision: number;
    content: string;
    acceptedAtIso: string;
    sleepWindow: SleepWindowConfig;
    controlRevision: number;
    solConfigured: boolean;
  }): { needsSol: boolean; gapMs: number | null; wasInNightPause: boolean } {
    const acceptMs = Date.parse(input.acceptedAtIso);
    const prev = this.get(input.conversationId);
    const prevLastRealMs = prev?.last_real_activity_at ? Date.parse(prev.last_real_activity_at) : null;
    const prevRestDecidedMs = prev?.resting === 1 && prev.rest_decided_at ? Date.parse(prev.rest_decided_at) : null;
    const prevAnchorMs = prevLastRealMs !== null && Number.isFinite(prevLastRealMs)
      ? (prevRestDecidedMs !== null && Number.isFinite(prevRestDecidedMs) ? Math.max(prevLastRealMs, prevRestDecidedMs) : prevLastRealMs)
      : (prevRestDecidedMs !== null && Number.isFinite(prevRestDecidedMs) ? prevRestDecidedMs : null);
    const gapMs = prevAnchorMs !== null && Number.isFinite(acceptMs)
      ? acceptMs - prevAnchorMs
      : null;

    const inSleepWindowNow = this.isInActiveSleepWindow(prev, input.sleepWindow, acceptMs);
    const wasInNightPause = this.isInNightPause(prev, input.sleepWindow, acceptMs);
    const gapEligible = wasInNightPause && gapMs !== null && gapMs >= NIGHT_EARLY_RESUME_GAP_MS;
    const overnightDate = overnightMorningDate(input.sleepWindow, acceptMs);
    const today = shanghaiDateOfMs(acceptMs);

    const nextUserRev = (prev?.user_appearance_revision ?? 0) + 1;

    // Ensure row exists with updated owner-appearance facts and reset streak (code owns appearance & count).
    this.db.prepare(`
      INSERT INTO conversation_activity(
        conversation_id, activity_revision, user_appearance_revision,
        last_user_message_id, last_user_message_at,
        consecutive_unanswered_count, streak_paused_date,
        morning_yielded_date, morning_yielded_at,
        keepwarm_suppressed_due_before_at, updated_at
      )
      VALUES (?, 0, ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        user_appearance_revision = excluded.user_appearance_revision,
        last_user_message_id = excluded.last_user_message_id,
        last_user_message_at = excluded.last_user_message_at,
        consecutive_unanswered_count = 0,
        streak_paused_date = NULL,
        morning_yielded_date = NULL,
        morning_yielded_at = NULL,
        keepwarm_suppressed_due_before_at = NULL,
        updated_at = excluded.updated_at
    `).run(input.conversationId, nextUserRev, input.messageId, input.acceptedAtIso, input.acceptedAtIso);

    const precheck = classifyRestLocally(input.content);
    if (precheck.kind === 'needs_sol' && !input.solConfigured) {
      // Without Sol configured, use local fallback ONLY when unambiguous; ambiguous cues
      // follow the exact same conservative "uncertain" handling as Sol timeout/503/uncertain
      // (preserve existing rest/recovery state while keeping owner appearance & count reset).
      const fallback = classifyRestFallbackWithoutSol(input.content);
      if (fallback === 'rest') {
        this.applyRestDecisionInTx({
          conversationId: input.conversationId,
          prev,
          messageId: input.messageId,
          acceptedAtIso: input.acceptedAtIso,
          acceptMs,
          restKind: detectRestKindLocally(input.content),
        });
        return { needsSol: false, gapMs, wasInNightPause };
      }
      if (fallback === 'not_rest') {
        this.applyNotRestRecoveryInTx({
          conversationId: input.conversationId,
          prev,
          messageId: input.messageId,
          acceptedAtIso: input.acceptedAtIso,
          acceptMs,
          wasInNightPause,
          inSleepWindowNow,
          gapEligible,
          overnightDate,
          today,
        });
        return { needsSol: false, gapMs, wasInNightPause };
      }
      this.clearPendingRestInTx(input.conversationId);
      return { needsSol: false, gapMs, wasInNightPause };
    }

    if (precheck.kind === 'clear_rest') {
      this.applyRestDecisionInTx({
        conversationId: input.conversationId,
        prev,
        messageId: input.messageId,
        acceptedAtIso: input.acceptedAtIso,
        acceptMs,
        restKind: precheck.restKind,
      });
      return { needsSol: false, gapMs, wasInNightPause };
    }

    if (precheck.kind === 'needs_sol') {
      this.db.prepare(`
        UPDATE conversation_activity SET
          pending_rest_message_id = ?,
          pending_rest_revision = ?,
          pending_rest_accepted_at = ?,
          pending_rest_control_revision = ?,
          pending_rest_user_appearance_revision = ?,
          pending_rest_was_night_pause = ?,
          pending_rest_gap_eligible = ?,
          updated_at = ?
        WHERE conversation_id = ?
      `).run(
        input.messageId,
        input.revision,
        input.acceptedAtIso,
        input.controlRevision,
        nextUserRev,
        wasInNightPause ? 1 : 0,
        gapEligible ? 1 : 0,
        input.acceptedAtIso,
        input.conversationId,
      );
      return { needsSol: true, gapMs, wasInNightPause };
    }

    // clear_not_rest: clear any pending Sol judgment and apply code recovery rules.
    this.applyNotRestRecoveryInTx({
      conversationId: input.conversationId,
      prev,
      messageId: input.messageId,
      acceptedAtIso: input.acceptedAtIso,
      acceptMs,
      wasInNightPause,
      inSleepWindowNow,
      gapEligible,
      overnightDate,
      today,
    });
    return { needsSol: false, gapMs, wasInNightPause };
  }

  /** Called inside editMessage's SQL transaction when an owner message is legally revised
   *  (e.g. while queued before dispatch). Does NOT count as a new user appearance or reset
   *  counts, but invalidates any pending Sol rest judgment for the superseded revision and
   *  re-evaluates the new revision text under the original message's accepted timestamp/gap. */
  noteOwnerMessageRevised(input: {
    conversationId: string;
    messageId: string;
    supersededRevision: number;
    revision: number;
    newContent?: string;
    sleepWindow: SleepWindowConfig;
    controlRevision: number;
    solConfigured: boolean;
  }): { needsSol: boolean } {
    const row = this.get(input.conversationId);
    if (!row) return { needsSol: false };
    // Never let an edit to an older message clobber a newer owner message's pending or settled state.
    if (row.pending_rest_message_id !== null && row.pending_rest_message_id !== input.messageId) {
      return { needsSol: false };
    }
    if (row.last_user_message_id !== null && row.last_user_message_id !== input.messageId) {
      return { needsSol: false };
    }
    const hadPending = row.pending_rest_message_id === input.messageId
      && row.pending_rest_revision === input.supersededRevision;
    const hadSettledRest = row.resting === 1 && row.rest_message_id === input.messageId;
    if (!hadPending && !hadSettledRest) return { needsSol: false };

    let resolvedContent = input.newContent;
    if (resolvedContent === undefined) {
      const revRow = this.db.prepare('SELECT content FROM message_revisions WHERE message_id = ? AND revision = ?')
        .get(input.messageId, input.revision) as { content: string } | undefined;
      if (!revRow) {
        if (hadPending) this.clearPendingRestInTx(input.conversationId);
        return { needsSol: false };
      }
      resolvedContent = effectiveRevisionText(this.db, input.messageId, input.revision, revRow.content);
    }

    const acceptedAtIso = hadPending && row.pending_rest_accepted_at
      ? row.pending_rest_accepted_at
      : (row.rest_decided_at ?? new Date().toISOString());
    const acceptMs = Date.parse(acceptedAtIso);
    const overnightDate = overnightMorningDate(input.sleepWindow, acceptMs);
    const today = shanghaiDateOfMs(acceptMs);
    const inSleepWindowNow = this.isInActiveSleepWindow(row, input.sleepWindow, acceptMs);
    // When revoking this message's own settled rest (e.g. 21:00:05 "我睡了" -> "我还在，继续聊"),
    // do not count the edited message's own resting=1 as a pre-existing nighttime pause.
    const wasInNightPause = hadPending ? row.pending_rest_was_night_pause === 1 : inSleepWindowNow;
    const gapEligible = hadPending ? row.pending_rest_gap_eligible === 1 : false;

    const precheck = classifyRestLocally(resolvedContent);
    if (precheck.kind === 'needs_sol' && !input.solConfigured) {
      const fallback = classifyRestFallbackWithoutSol(resolvedContent);
      if (fallback === 'rest') {
        this.applyRestDecisionInTx({
          conversationId: input.conversationId,
          prev: row,
          messageId: input.messageId,
          acceptedAtIso,
          acceptMs,
          restKind: detectRestKindLocally(resolvedContent),
        });
        return { needsSol: false };
      }
      if (fallback === 'not_rest') {
        this.applyNotRestRecoveryInTx({
          conversationId: input.conversationId,
          prev: row,
          messageId: input.messageId,
          acceptedAtIso,
          acceptMs,
          wasInNightPause,
          inSleepWindowNow,
          gapEligible,
          overnightDate,
          today,
        });
        return { needsSol: false };
      }
      this.clearPendingRestInTx(input.conversationId);
      return { needsSol: false };
    }

    if (precheck.kind === 'clear_rest') {
      this.applyRestDecisionInTx({
        conversationId: input.conversationId,
        prev: row,
        messageId: input.messageId,
        acceptedAtIso,
        acceptMs,
        restKind: precheck.restKind,
      });
      return { needsSol: false };
    }

    if (precheck.kind === 'needs_sol') {
      this.db.prepare(`
        UPDATE conversation_activity SET
          pending_rest_message_id = ?,
          pending_rest_revision = ?,
          pending_rest_accepted_at = ?,
          pending_rest_control_revision = ?,
          pending_rest_user_appearance_revision = ?,
          pending_rest_was_night_pause = ?,
          pending_rest_gap_eligible = ?,
          updated_at = ?
        WHERE conversation_id = ?
      `).run(
        input.messageId,
        input.revision,
        acceptedAtIso,
        input.controlRevision,
        row.user_appearance_revision,
        wasInNightPause ? 1 : 0,
        gapEligible ? 1 : 0,
        new Date().toISOString(),
        input.conversationId,
      );
      return { needsSol: true };
    }

    // clear_not_rest: supersede pending rev 1 (and clear settled rest if this exact message caused it).
    this.applyNotRestRecoveryInTx({
      conversationId: input.conversationId,
      prev: row,
      messageId: input.messageId,
      acceptedAtIso,
      acceptMs,
      wasInNightPause,
      inSleepWindowNow,
      gapEligible,
      overnightDate,
      today,
    });
    return { needsSol: false };
  }

  private applyNotRestRecoveryInTx(input: {
    conversationId: string;
    prev: ConversationActivityRow | null;
    messageId: string;
    acceptedAtIso: string;
    acceptMs: number;
    wasInNightPause: boolean;
    inSleepWindowNow: boolean;
    gapEligible: boolean;
    overnightDate: string | null;
    today: string;
  }): void {
    const clearPending = `
      pending_rest_message_id = NULL,
      pending_rest_revision = NULL,
      pending_rest_accepted_at = NULL,
      pending_rest_control_revision = NULL,
      pending_rest_user_appearance_revision = NULL,
      pending_rest_was_night_pause = NULL,
      pending_rest_gap_eligible = NULL`;

    if (input.wasInNightPause) {
      if (input.gapEligible) {
        const wasResting = input.prev?.resting === 1;
        // ONLY grant an overnight early-resume exemption when the nighttime sleep window
        // (e.g. 23:00–08:00) has ALREADY started. Returning from an 18:00 rest at 22:11 clears
        // resting WITHOUT exempting the upcoming 23:00 cutoff!
        const grantEarlyResume = input.inSleepWindowNow;
        const targetMorningDate = grantEarlyResume
          ? (input.overnightDate ?? input.prev?.rest_morning_date ?? input.today)
          : null;
        this.db.prepare(`
          UPDATE conversation_activity SET
            resting = 0,
            rest_recovery_mode = NULL,
            rest_morning_date = NULL,
            rest_decided_at = CASE WHEN ? = 1 THEN ? ELSE rest_decided_at END,
            rest_source = CASE WHEN ? = 1 THEN 'owner_message' ELSE rest_source END,
            rest_message_id = CASE WHEN ? = 1 THEN ? ELSE rest_message_id END,
            early_resumed_date = CASE WHEN ? = 1 THEN ? ELSE early_resumed_date END,
            morning_fallback_superseded_date = CASE WHEN ? = 1 THEN ? ELSE morning_fallback_superseded_date END,
            ${clearPending},
            updated_at = ?
          WHERE conversation_id = ?
        `).run(
          wasResting ? 1 : 0, input.acceptedAtIso,
          wasResting ? 1 : 0,
          wasResting ? 1 : 0, input.messageId,
          grantEarlyResume ? 1 : 0, targetMorningDate,
          grantEarlyResume ? 1 : 0, targetMorningDate,
          input.acceptedAtIso, input.conversationId,
        );
      } else {
        // Nighttime gap < 4h: stay paused, preserve existing rest / 08:00 fallback!
        this.db.prepare(`
          UPDATE conversation_activity SET
            ${clearPending},
            updated_at = ?
          WHERE conversation_id = ?
        `).run(input.acceptedAtIso, input.conversationId);
      }
      return;
    }

    // Daytime (not in nighttime pause): immediate resume regardless of gap!
    const wasResting = input.prev?.resting === 1;
    // If she speaks in daytime (>= 08:00), today's unconsumed 08:00 fallback is superseded by active chat.
    const today08Ms = Date.parse(`${input.today}T08:00:00+08:00`);
    const supersedeToday = input.acceptMs >= today08Ms ? input.today : (input.prev?.morning_fallback_superseded_date ?? null);
    this.db.prepare(`
      UPDATE conversation_activity SET
        resting = 0,
        rest_recovery_mode = NULL,
        rest_morning_date = NULL,
        rest_decided_at = CASE WHEN ? = 1 THEN ? ELSE rest_decided_at END,
        rest_source = CASE WHEN ? = 1 THEN 'owner_message' ELSE rest_source END,
        rest_message_id = CASE WHEN ? = 1 THEN ? ELSE rest_message_id END,
        morning_fallback_superseded_date = ?,
        ${clearPending},
        updated_at = ?
      WHERE conversation_id = ?
    `).run(
      wasResting ? 1 : 0, input.acceptedAtIso,
      wasResting ? 1 : 0,
      wasResting ? 1 : 0, input.messageId,
      supersedeToday,
      input.acceptedAtIso, input.conversationId,
    );
  }

  /** Apply async Sol rest judgment with strict message/revision/appearance/control-version fencing.
   *  Returns true if applied, false if discarded as stale or superseded. */
  applySolRestResult(input: {
    conversationId: string;
    messageId: string;
    revision: number;
    capturedUserAppearanceRevision: number;
    capturedControlRevision: number;
    currentControlRevision: number;
    sleepWindow: SleepWindowConfig;
    result: SolRestJudgment;
  }): boolean {
    return tx(this.db, () => {
      const row = this.get(input.conversationId);
      if (!row) return false;
      if (row.pending_rest_message_id !== input.messageId || row.pending_rest_revision !== input.revision) {
        return false;
      }
      // Verify the message has NOT been legally edited to a newer revision while Sol was in flight (Review #5).
      const msgRev = this.db.prepare('SELECT current_revision FROM messages WHERE id = ?')
        .get(input.messageId) as { current_revision: number } | undefined;
      if (!msgRev || msgRev.current_revision !== input.revision) {
        this.clearPendingRestInTx(input.conversationId);
        return false;
      }
      if (row.user_appearance_revision !== input.capturedUserAppearanceRevision) {
        return false;
      }
      if (row.pending_rest_control_revision !== input.capturedControlRevision || input.currentControlRevision !== input.capturedControlRevision) {
        // Manual keepwarm toggle changed while Sol was in flight: discard stale Sol result and clear pending marker.
        this.clearPendingRestInTx(input.conversationId);
        return false;
      }
      const acceptedAtIso = row.pending_rest_accepted_at;
      if (!acceptedAtIso) {
        this.clearPendingRestInTx(input.conversationId);
        return false;
      }
      const acceptMs = Date.parse(acceptedAtIso);
      const today = shanghaiDateOfMs(acceptMs);

      if (input.result.status === 'ok' && input.result.decision === 'rest') {
        return this.applyRestDecisionInTx({
          conversationId: input.conversationId,
          prev: row,
          messageId: input.messageId,
          acceptedAtIso,
          acceptMs,
          restKind: input.result.restKind,
          requireUserAppearanceRevision: input.capturedUserAppearanceRevision,
        });
      }

      if (input.result.status === 'ok' && input.result.decision === 'not_rest') {
        const overnightDate = overnightMorningDate(input.sleepWindow, acceptMs);
        const inSleepWindowNow = this.isInActiveSleepWindow(row, input.sleepWindow, acceptMs);
        this.applyNotRestRecoveryInTx({
          conversationId: input.conversationId,
          prev: row,
          messageId: input.messageId,
          acceptedAtIso,
          acceptMs,
          wasInNightPause: row.pending_rest_was_night_pause === 1,
          inSleepWindowNow,
          gapEligible: row.pending_rest_gap_eligible === 1,
          overnightDate,
          today,
        });
        return true;
      }

      // Sol returned 'uncertain', 'timeout', or 'failed': NEVER pretend asleep or awake!
      // Only release the pending lock while keeping existing resting/recovery state intact.
      this.clearPendingRestInTx(input.conversationId);
      return true;
    });
  }

  private clearPendingRestInTx(conversationId: string): void {
    this.db.prepare(`
      UPDATE conversation_activity SET
        pending_rest_message_id = NULL,
        pending_rest_revision = NULL,
        pending_rest_accepted_at = NULL,
        pending_rest_control_revision = NULL,
        pending_rest_user_appearance_revision = NULL,
        pending_rest_was_night_pause = NULL,
        pending_rest_gap_eligible = NULL
      WHERE conversation_id = ? AND pending_rest_message_id IS NOT NULL
    `).run(conversationId);
  }

  /** Clear pending Sol judgments invalidated by manual toggle or host restart. */
  clearAllPendingRest(): void {
    this.db.prepare(`
      UPDATE conversation_activity SET
        pending_rest_message_id = NULL,
        pending_rest_revision = NULL,
        pending_rest_accepted_at = NULL,
        pending_rest_control_revision = NULL,
        pending_rest_user_appearance_revision = NULL,
        pending_rest_was_night_pause = NULL,
        pending_rest_gap_eligible = NULL
      WHERE pending_rest_message_id IS NOT NULL
    `).run();
  }

  /** Record an effective automatic heartbeat once per logical run (confirmed model send).
   *  Idempotent via background_runs.streak_counted_at; CAS-guarded by user_appearance_revision
   *  so a late confirmation after the owner arrived never writes old counts onto her fresh streak. */
  noteEffectiveHeartbeat(input: {
    conversationId: string;
    runId: string;
    windowId: string;
    startedAtIso: string;
    isMorningWake: boolean;
    morningBusinessDate?: string | null;
  }): boolean {
    return tx(this.db, () => {
      const run = this.db.prepare(
        'SELECT id, input_user_appearance_revision, streak_counted_at FROM background_runs WHERE id = ?',
      ).get(input.runId) as { id: string; input_user_appearance_revision: number | null; streak_counted_at: string | null } | undefined;
      if (!run || run.streak_counted_at !== null) return false;
      const marked = Number(
        this.db.prepare('UPDATE background_runs SET streak_counted_at = ? WHERE id = ? AND streak_counted_at IS NULL')
          .run(input.startedAtIso, input.runId).changes,
      );
      if (marked !== 1) return false;

      const act = this.get(input.conversationId);
      if (!act) return false;
      // If Qiaosheng has already appeared since this run was claimed, do NOT write old count back!
      if (run.input_user_appearance_revision !== null && act.user_appearance_revision !== run.input_user_appearance_revision) {
        return false;
      }

      const startedMs = Date.parse(input.startedAtIso);
      const businessDate = input.morningBusinessDate ?? shanghaiDateOfMs(Number.isFinite(startedMs) ? startedMs : Date.now());
      // Per v2.1 §2.5 (Review #4): the 08:00 morning fallback ALWAYS starts the new day's
      // chain at count 1 (even if the previous evening only reached 1 or 2 before 23:00).
      const nextCount = input.isMorningWake ? 1 : act.consecutive_unanswered_count + 1;
      const nextPausedDate = nextCount >= MAX_CONSECUTIVE_UNANSWERED_HEARTBEATS ? businessDate : null;

      const clearExpiredMorningRest = input.isMorningWake
        && act.resting === 1
        && act.rest_recovery_mode === 'morning_0800'
        && (act.rest_morning_date === null || act.rest_morning_date <= businessDate);

      const res = this.db.prepare(`
        UPDATE conversation_activity SET
          consecutive_unanswered_count = ?,
          streak_paused_date = ?,
          last_effective_heartbeat_at = ?,
          last_effective_heartbeat_run_id = ?,
          last_effective_heartbeat_window_id = ?,
          resting = CASE WHEN ? = 1 THEN 0 ELSE resting END,
          rest_recovery_mode = CASE WHEN ? = 1 THEN NULL ELSE rest_recovery_mode END,
          rest_morning_date = CASE WHEN ? = 1 THEN NULL ELSE rest_morning_date END,
          morning_yielded_date = NULL,
          morning_yielded_at = NULL,
          updated_at = ?
        WHERE conversation_id = ? AND user_appearance_revision = ?
      `).run(
        nextCount,
        nextPausedDate,
        input.startedAtIso,
        input.runId,
        input.windowId,
        clearExpiredMorningRest ? 1 : 0,
        clearExpiredMorningRest ? 1 : 0,
        clearExpiredMorningRest ? 1 : 0,
        input.startedAtIso,
        input.conversationId,
        act.user_appearance_revision,
      );
      return Number(res.changes) === 1;
    });
  }

  /** Record that the Host was online and actively yielding the morning opportunity to a live call
   *  or foreground user turn, distinguishing online yield from true offline missed grace (R2).
   *  Writes only when the yield state changes or refreshes (>60s), avoiding redundant tick writes. */
  noteOnlineMorningYield(conversationId: string, businessDate: string, nowIso: string): void {
    const row = this.get(conversationId);
    if (!row) return;
    const nowMs = Date.parse(nowIso);
    if (
      row.morning_yielded_date === businessDate
      && row.morning_yielded_at !== null
      && Number.isFinite(nowMs)
      && nowMs - Date.parse(row.morning_yielded_at) < 60_000
    ) {
      return;
    }
    this.db.prepare('UPDATE conversation_activity SET morning_yielded_date = ?, morning_yielded_at = ?, updated_at = ? WHERE conversation_id = ?')
      .run(businessDate, nowIso, nowIso, conversationId);
  }

  /** Explicit rest/resume decision (direct API & tests).
   *  Fixes R1: a new message's rest decision overwrites an earlier rest decision and recovery mode;
   *  an idempotent replay of the exact same messageId changes nothing. */
  noteRestDecision(conversationId: string, decision: RestDecision): boolean {
    if (decision.kind === 'rest') {
      const atMs = Date.parse(decision.atIso);
      const effectiveMs = Number.isFinite(atMs) ? atMs : Date.now();
      const existing = this.get(conversationId);
      if (existing?.resting === 1 && existing.rest_message_id === decision.messageId) {
        return false;
      }
      if (!existing) {
        this.db.prepare('INSERT INTO conversation_activity(conversation_id, updated_at) VALUES (?, ?)').run(conversationId, decision.atIso);
      }
      return this.applyRestDecisionInTx({
        conversationId,
        prev: existing,
        messageId: decision.messageId,
        acceptedAtIso: decision.atIso,
        acceptMs: effectiveMs,
        restKind: decision.restKind ?? 'sleep',
      });
    }
    return Number(this.db.prepare(`
      UPDATE conversation_activity SET
        resting = 0,
        rest_decided_at = ?,
        rest_source = ?,
        rest_message_id = NULL,
        rest_recovery_mode = NULL,
        rest_morning_date = NULL,
        updated_at = ?
      WHERE conversation_id = ? AND resting = 1
    `).run(decision.atIso, decision.source, decision.atIso, conversationId).changes) === 1;
  }

  /** Explicit resume endpoint (kept idempotent; never modifies the manual switch or 50-minute anchor). */
  resumeRest(conversationId: string, operation: { actorId: string; operationId: string }): RestState & { changed: boolean; duplicate: boolean } {
    return tx(this.db, () => {
      const prior = this.db.prepare(`
        SELECT response_json FROM background_operations
        WHERE actor_id = ? AND conversation_id = ? AND action = 'heartbeat_resume' AND operation_id = ?
      `).get(operation.actorId, conversationId, operation.operationId) as { response_json: string } | undefined;
      if (prior) return { ...JSON.parse(prior.response_json) as RestState & { changed: boolean }, duplicate: true };
      const changed = this.noteRestDecision(conversationId, { kind: 'resume', source: 'control', atIso: new Date().toISOString() });
      const response = { ...this.restState(conversationId), changed };
      this.db.prepare(`
        INSERT INTO background_operations(actor_id, conversation_id, action, operation_id, request_hash, response_json, created_at)
        VALUES (?, ?, 'heartbeat_resume', ?, 'resume', ?, ?)
      `).run(operation.actorId, conversationId, operation.operationId, JSON.stringify(response), new Date().toISOString());
      return { ...response, duplicate: false };
    });
  }

  /** Formal chat publication (owner first acceptance, assistant reply, heartbeat formal speech,
   *  or assistant paragraph append). Updates L and increments activity_revision.
   *  Does NOT reset consecutive_unanswered_count (only owner appearance does). */
  noteRealPublication(conversationId: string, messageId: string, revision: number, atIso: string): void {
    this.db.prepare(
      `INSERT INTO conversation_activity(conversation_id, activity_revision, last_real_message_id, last_real_message_revision, last_real_activity_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         activity_revision = activity_revision + 1,
         last_real_message_id = excluded.last_real_message_id,
         last_real_message_revision = excluded.last_real_message_revision,
         last_real_activity_at = excluded.last_real_activity_at,
         maintenance_request_id = NULL,
         maintenance_for_activity_revision = NULL,
         maintenance_window_id = NULL,
         maintenance_dispatch_started_at = NULL,
         updated_at = excluded.updated_at`,
    ).run(conversationId, messageId, revision, atIso, atIso);
  }

  /** Maintenance receipt CAS: records a completed maintenance/autonomous refresh for the
   *  captured activity_revision. Late receipts after a newer real message are ignored. */
  noteMaintenanceReceipt(input: { conversationId: string; capturedActivityRevision: number; requestId: string; windowId: string; dispatchStartedAtIso: string }): boolean {
    const r = this.db.prepare(
      `UPDATE conversation_activity SET
         maintenance_request_id = ?, maintenance_for_activity_revision = ?,
         maintenance_window_id = ?, maintenance_dispatch_started_at = ?, updated_at = ?
       WHERE conversation_id = ? AND activity_revision = ?
         AND (maintenance_dispatch_started_at IS NULL OR maintenance_for_activity_revision != ?
              OR julianday(maintenance_dispatch_started_at) <= julianday(?))`,
    ).run(input.requestId, input.capturedActivityRevision, input.windowId, input.dispatchStartedAtIso, input.dispatchStartedAtIso, input.conversationId, input.capturedActivityRevision, input.capturedActivityRevision, input.dispatchStartedAtIso);
    return Number(r.changes) === 1;
  }

  /** Internal authoritative 50-minute anchor resolver returning both dueAtMs and the exact
   *  anchor identity used for occurrence_key deduplication (prevents quiet autonomous wakes
   *  from stalling keepwarm on a stale last_effective_heartbeat_run_id key — Review #3). */
  private resolveKeepwarmAnchor(input: { conversationId: string; windowId: string }):
    | { scheduled: true; dueAtMs: number; basis: 'real_message' | 'maintenance'; activityRevision: number; anchorKey: string }
    | { scheduled: false; reason: 'NO_REAL_ACTIVITY' } {
    const row = this.get(input.conversationId);
    if (!row) return { scheduled: false, reason: 'NO_REAL_ACTIVITY' };
    const idleMs = POLICY_CONSTANTS.background.keepwarm.idle_after_cache_ms;

    const L = row.last_real_activity_at !== null ? Date.parse(row.last_real_activity_at) : NaN;
    const hbAnchor = row.last_effective_heartbeat_at !== null && row.last_effective_heartbeat_window_id === input.windowId
      ? Date.parse(row.last_effective_heartbeat_at)
      : NaN;
    const validMaint = row.maintenance_request_id !== null
      && row.maintenance_for_activity_revision === row.activity_revision
      && row.maintenance_window_id === input.windowId
      && row.maintenance_dispatch_started_at !== null
      ? Date.parse(row.maintenance_dispatch_started_at)
      : NaN;

    let bestMs = Number.isFinite(L) ? L : NaN;
    let basis: 'real_message' | 'maintenance' = 'real_message';
    let anchorKey = 'real';

    if (Number.isFinite(hbAnchor) && (!Number.isFinite(bestMs) || hbAnchor >= bestMs)) {
      bestMs = hbAnchor;
      basis = 'maintenance';
      anchorKey = `hb:${row.last_effective_heartbeat_run_id ?? 'none'}`;
    }
    if (Number.isFinite(validMaint) && (!Number.isFinite(bestMs) || validMaint > bestMs || (validMaint === bestMs && !Number.isFinite(hbAnchor)))) {
      bestMs = validMaint;
      basis = 'maintenance';
      anchorKey = `maint:${row.maintenance_request_id}`;
    }

    if (!Number.isFinite(bestMs)) return { scheduled: false, reason: 'NO_REAL_ACTIVITY' };
    return { scheduled: true, dueAtMs: bestMs + idleMs, basis, activityRevision: row.activity_revision, anchorKey };
  }

  /** Unified 50-minute target: max of latest formal chat publication (L), latest effective
   *  automatic heartbeat start (for quiet/tool-only rounds on the same window), and valid
   *  same-window maintenance receipt. Old morningSatisfied short-circuit is retired. */
  nextKeepwarmTarget(input: { conversationId: string; windowId: string; cacheTtlMs?: number }):
    | { scheduled: true; dueAtMs: number; basis: 'real_message' | 'maintenance'; activityRevision: number }
    | { scheduled: false; reason: 'NO_REAL_ACTIVITY' } {
    const resolved = this.resolveKeepwarmAnchor(input);
    if (!resolved.scheduled) return resolved;
    return { scheduled: true, dueAtMs: resolved.dueAtMs, basis: resolved.basis, activityRevision: resolved.activityRevision };
  }

  private isMorningOccurrenceConsumed(conversationId: string, businessDate: string): boolean {
    const occKey = morningWakeOccurrenceKey(conversationId, businessDate);
    const existing = this.db.prepare(
      'SELECT state, first_dispatch_started_at FROM background_runs WHERE occurrence_key = ? LIMIT 1',
    ).get(occKey) as { state: string; first_dispatch_started_at: string | null } | undefined;
    return Boolean(existing && (existing.first_dispatch_started_at !== null || existing.state !== 'claimed'));
  }

  private hasActivePendingRest(row: ConversationActivityRow | null, currentControlRevision?: number): boolean {
    if (!row || !row.pending_rest_message_id) return false;
    if (currentControlRevision !== undefined && row.pending_rest_control_revision !== null
      && row.pending_rest_control_revision !== currentControlRevision) {
      return false;
    }
    return true;
  }

  /** Shanghai 08:00 fallback evaluation (v2.1):
   *  - Retires the old 07:11 postpone rule.
   *  - Honors normal night rest (morning_0800), catch-up/nap wait-user (next_user_message),
   *    early-resume superseding, and online-yield vs offline missed grace. */
  morningWakeTarget(input: {
    conversationId: string;
    windowId: string | null;
    sleepWindow: SleepWindowConfig;
    nowMs: number;
    targetBusinessDate?: string;
    currentControlRevision?: number;
  }): MorningWakeTarget {
    const today = shanghaiDateOfMs(input.nowMs);
    const businessDate = input.targetBusinessDate ?? today;
    if (keepwarmSleepState(input.sleepWindow, input.nowMs).code === 'KEEPWARM_SLEEP_CONFIG_INVALID') {
      return { scheduled: false, businessDate, reason: 'SLEEP_CONFIG_INVALID' };
    }
    if (!input.windowId) {
      return { scheduled: false, businessDate, reason: 'NO_ACTIVE_WINDOW' };
    }
    const act = this.get(input.conversationId);
    if (this.hasActivePendingRest(act, input.currentControlRevision)) {
      return { scheduled: false, businessDate, reason: 'REST_JUDGMENT_PENDING' };
    }
    if (act?.resting === 1) {
      const mode = act.rest_recovery_mode ?? 'next_user_message';
      if (mode === 'next_user_message') {
        return { scheduled: false, businessDate, reason: 'WAIT_NEXT_USER_MESSAGE' };
      }
      if (act.rest_morning_date && businessDate < act.rest_morning_date) {
        return { scheduled: false, businessDate, reason: 'DAYTIME_RESTING' };
      }
    }
    if (act?.early_resumed_date === businessDate || act?.morning_fallback_superseded_date === businessDate) {
      return { scheduled: false, businessDate, reason: 'SUPERSEDED_BY_EARLY_RESUME' };
    }
    if (this.isMorningOccurrenceConsumed(input.conversationId, businessDate)) {
      return { scheduled: false, businessDate, reason: 'ALREADY_CONSUMED' };
    }
    const baselineMs = Date.parse(`${businessDate}T08:00:00+08:00`);
    const suppressedBeforeMs = act?.keepwarm_suppressed_due_before_at ? Date.parse(act.keepwarm_suppressed_due_before_at) : NaN;
    if (Number.isFinite(suppressedBeforeMs) && baselineMs <= suppressedBeforeMs) {
      return { scheduled: false, businessDate, reason: 'MISSED_WHILE_DISABLED', dueAtMs: baselineMs, basis: 'morning_baseline', postponedByAtMs: null };
    }
    const onlineYieldValid = act?.morning_yielded_date === businessDate
      && act.morning_yielded_at !== null
      && input.nowMs - Date.parse(act.morning_yielded_at) < MORNING_WAKE_GRACE_MS;
    if (input.nowMs >= baselineMs && (input.nowMs - baselineMs >= MORNING_WAKE_GRACE_MS) && !onlineYieldValid) {
      return { scheduled: false, businessDate, reason: 'MISSED_GRACE', dueAtMs: baselineMs, basis: 'morning_baseline', postponedByAtMs: null };
    }
    if (keepwarmSleepState(input.sleepWindow, baselineMs).blocked) {
      return { scheduled: false, businessDate, reason: 'SLEEP_WINDOW', dueAtMs: baselineMs, basis: 'morning_baseline', postponedByAtMs: null };
    }
    return { scheduled: true, businessDate, dueAtMs: baselineMs, basis: 'morning_baseline', postponedByAtMs: null };
  }

  /** Single authoritative heartbeat schedule evaluator shared by scheduler, dispatch gate, and settings API. */
  evaluateHeartbeatSchedule(input: {
    conversationId: string;
    windowId: string | null;
    sleepWindow: SleepWindowConfig;
    keepwarmEnabled: boolean;
    nowMs: number;
    currentControlRevision?: number;
  }): HeartbeatScheduleState {
    const act = this.get(input.conversationId);
    const today = shanghaiDateOfMs(input.nowMs);
    const rawSleep = keepwarmSleepState(input.sleepWindow, input.nowMs);
    const effSleep = effectiveSleepState(input.sleepWindow, input.nowMs, act?.early_resumed_date);
    const resting = act?.resting === 1;
    const restRecoveryMode: RestRecoveryMode | null = resting ? (act?.rest_recovery_mode ?? 'next_user_message') : null;
    const restMorningDate = resting ? (act?.rest_morning_date ?? null) : null;
    const consecutiveUnansweredCount = act?.consecutive_unanswered_count ?? 0;
    const pendingRestJudgment = this.hasActivePendingRest(act, input.currentControlRevision);
    const base = {
      anchorKey: null as string | null,
      businessDate: today,
      sleepWindowActive: effSleep.blocked,
      localTime: rawSleep.local_time,
      resting,
      restRecoveryMode,
      restMorningDate,
      earlyResumedDate: act?.early_resumed_date ?? null,
      consecutiveUnansweredCount,
      pendingRestJudgment,
      activityRevision: act?.activity_revision ?? 0,
      userAppearanceRevision: act?.user_appearance_revision ?? 0,
    };

    // 1. Invalid sleep window config fails closed.
    if (rawSleep.code === 'KEEPWARM_SLEEP_CONFIG_INVALID') {
      return { ...base, scheduled: false, kind: 'none', dueAtMs: null, basis: null, blockedReason: 'KEEPWARM_SLEEP_CONFIG_INVALID', nextMorningPreview: null };
    }

    // 2. Manual switch OFF overrides everything (4h gap, Sol, midnight, 08:00, restart).
    if (!input.keepwarmEnabled) {
      return { ...base, scheduled: false, kind: 'none', dueAtMs: null, basis: null, blockedReason: 'KEEPWARM_DISABLED', nextMorningPreview: null };
    }

    // 3. Pending Sol rest judgment holds dispatch until resolved/timed-out.
    if (pendingRestJudgment) {
      return { ...base, scheduled: false, kind: 'none', dueAtMs: null, basis: null, blockedReason: 'REST_JUDGMENT_PENDING', nextMorningPreview: null };
    }

    // 4. Standing rest decision.
    if (resting) {
      if (restRecoveryMode === 'next_user_message') {
        // Catch-up sleep (>=02:00), daytime nap, or wait-for-me: NEVER preview or trigger 08:00.
        return { ...base, scheduled: false, kind: 'none', dueAtMs: null, basis: null, blockedReason: 'KEEPWARM_RESTING_WAIT_USER', nextMorningPreview: null };
      }
      // Normal evening rest (18:00–01:59:59): conditional morning 08:00 fallback.
      const defaultMorningDate = Number(rawSleep.local_time?.slice(0, 2) ?? '22') < 2 ? today : addCalendarDays(today, 1);
      const targetDate = restMorningDate && restMorningDate >= today ? restMorningDate : (restMorningDate ? today : defaultMorningDate);
      const morning = this.morningWakeTarget({
        conversationId: input.conversationId,
        windowId: input.windowId,
        sleepWindow: input.sleepWindow,
        nowMs: input.nowMs,
        targetBusinessDate: targetDate,
        currentControlRevision: input.currentControlRevision,
      });
      if (morning.scheduled) {
        if (input.nowMs >= morning.dueAtMs) {
          // 08:00 reached! Ready to run morning fallback as Round 1.
          return {
            ...base,
            businessDate: morning.businessDate,
            scheduled: true,
            kind: 'morning_wake',
            dueAtMs: morning.dueAtMs,
            basis: 'morning_baseline',
            blockedReason: null,
            nextMorningPreview: { targetAtMs: morning.dueAtMs, businessDate: morning.businessDate },
          };
        }
        // Still before target 08:00 (e.g. 22:30 tonight or 01:59): ordinary paused, conditional 08:00 previewed (R5).
        return {
          ...base,
          businessDate: morning.businessDate,
          scheduled: true,
          kind: 'morning_wake',
          dueAtMs: morning.dueAtMs,
          basis: 'morning_baseline',
          blockedReason: 'KEEPWARM_RESTING',
          nextMorningPreview: { targetAtMs: morning.dueAtMs, businessDate: morning.businessDate },
        };
      }
      // Morning fallback missed grace, missed while disabled, or no active window: preview next day's 08:00 if appropriate.
      const nextDay = addCalendarDays(today, 1);
      const nextPreview = (morning.reason === 'MISSED_GRACE' || morning.reason === 'MISSED_WHILE_DISABLED') && input.windowId
        ? { targetAtMs: Date.parse(`${nextDay}T08:00:00+08:00`), businessDate: nextDay }
        : null;
      return {
        ...base,
        scheduled: false,
        kind: 'none',
        dueAtMs: null,
        basis: null,
        blockedReason: morning.reason === 'MISSED_GRACE' ? 'MORNING_WAKE_MISSED_GRACE' : 'KEEPWARM_RESTING',
        nextMorningPreview: nextPreview,
      };
    }

    // 5. Consecutive 3 unanswered heartbeats pause.
    if (consecutiveUnansweredCount >= MAX_CONSECUTIVE_UNANSWERED_HEARTBEATS) {
      const pausedDate = act?.streak_paused_date ?? today;
      if (today <= pausedDate) {
        // Still the same Shanghai day: paused; next day 08:00 can start a fresh chain.
        const nextDay = addCalendarDays(pausedDate, 1);
        const nextPreview = input.windowId
          ? { targetAtMs: Date.parse(`${nextDay}T08:00:00+08:00`), businessDate: nextDay }
          : null;
        return {
          ...base,
          scheduled: false,
          kind: 'none',
          dueAtMs: null,
          basis: null,
          blockedReason: 'KEEPWARM_CONSECUTIVE_LIMIT',
          nextMorningPreview: nextPreview,
        };
      }
      // Next Shanghai day (today > pausedDate): never start at midnight; wait for 08:00 fallback!
      const morning = this.morningWakeTarget({
        conversationId: input.conversationId,
        windowId: input.windowId,
        sleepWindow: input.sleepWindow,
        nowMs: input.nowMs,
        targetBusinessDate: today,
        currentControlRevision: input.currentControlRevision,
      });
      if (morning.scheduled) {
        const dueNow = input.nowMs >= morning.dueAtMs;
        return {
          ...base,
          businessDate: today,
          scheduled: true,
          kind: 'morning_wake',
          dueAtMs: morning.dueAtMs,
          basis: 'morning_baseline',
          blockedReason: dueNow ? null : 'KEEPWARM_SLEEP_WINDOW',
          nextMorningPreview: { targetAtMs: morning.dueAtMs, businessDate: today },
        };
      }
      const nextDay = addCalendarDays(today, 1);
      return {
        ...base,
        scheduled: false,
        kind: 'none',
        dueAtMs: null,
        basis: null,
        blockedReason: morning.reason === 'MISSED_GRACE' ? 'MORNING_WAKE_MISSED_GRACE' : 'KEEPWARM_CONSECUTIVE_LIMIT',
        nextMorningPreview: input.windowId ? { targetAtMs: Date.parse(`${nextDay}T08:00:00+08:00`), businessDate: nextDay } : null,
      };
    }

    // 6. Nighttime sleep window (when NOT early-resumed for this overnight cycle).
    if (effSleep.blocked) {
      const morningDate = overnightMorningDate(input.sleepWindow, input.nowMs) ?? today;
      const morning = this.morningWakeTarget({
        conversationId: input.conversationId,
        windowId: input.windowId,
        sleepWindow: input.sleepWindow,
        nowMs: input.nowMs,
        targetBusinessDate: morningDate,
        currentControlRevision: input.currentControlRevision,
      });
      if (morning.scheduled) {
        return {
          ...base,
          businessDate: morningDate,
          scheduled: true,
          kind: 'morning_wake',
          dueAtMs: morning.dueAtMs,
          basis: 'morning_baseline',
          blockedReason: 'KEEPWARM_SLEEP_WINDOW',
          nextMorningPreview: { targetAtMs: morning.dueAtMs, businessDate: morningDate },
        };
      }
      return {
        ...base,
        businessDate: morningDate,
        scheduled: false,
        kind: 'none',
        dueAtMs: null,
        basis: null,
        blockedReason: 'KEEPWARM_SLEEP_WINDOW',
        nextMorningPreview: null,
      };
    }

    if (!input.windowId) {
      return { ...base, scheduled: false, kind: 'none', dueAtMs: null, basis: null, blockedReason: null, nextMorningPreview: null };
    }

    // 7. Daytime 08:00 morning fallback (when overnight pause wasn't superseded by early resume or daytime chat).
    const today08Ms = Date.parse(`${today}T08:00:00+08:00`);
    const lastRealMs = act?.last_real_activity_at ? Date.parse(act.last_real_activity_at) : null;
    const lastHbMs = act?.last_effective_heartbeat_at ? Date.parse(act.last_effective_heartbeat_at) : null;
    const hadActivityTodayAfter08 = (lastRealMs !== null && lastRealMs >= today08Ms)
      || (lastHbMs !== null && lastHbMs >= today08Ms);

    if (input.nowMs >= today08Ms && !hadActivityTodayAfter08) {
      const morning = this.morningWakeTarget({
        conversationId: input.conversationId,
        windowId: input.windowId,
        sleepWindow: input.sleepWindow,
        nowMs: input.nowMs,
        targetBusinessDate: today,
        currentControlRevision: input.currentControlRevision,
      });
      if (morning.scheduled) {
        return {
          ...base,
          businessDate: today,
          scheduled: true,
          kind: 'morning_wake',
          dueAtMs: morning.dueAtMs,
          basis: 'morning_baseline',
          blockedReason: null,
          nextMorningPreview: { targetAtMs: morning.dueAtMs, businessDate: today },
        };
      }
      if (morning.reason === 'MISSED_GRACE' || morning.reason === 'MISSED_WHILE_DISABLED') {
        // Truly offline past 08:10 or manually disabled across 08:00: do not backfill.
        const nextDay = addCalendarDays(today, 1);
        return {
          ...base,
          scheduled: false,
          kind: 'none',
          dueAtMs: null,
          basis: null,
          blockedReason: morning.reason === 'MISSED_GRACE' ? 'MORNING_WAKE_MISSED_GRACE' : null,
          nextMorningPreview: { targetAtMs: Date.parse(`${nextDay}T08:00:00+08:00`), businessDate: nextDay },
        };
      }
    }

    // 8. Unified 50-minute cycle (active daytime OR early-resumed pre-08:00).
    const ordinary = this.resolveKeepwarmAnchor({ conversationId: input.conversationId, windowId: input.windowId });
    if (!ordinary.scheduled) {
      return { ...base, scheduled: false, kind: 'none', dueAtMs: null, basis: null, blockedReason: null, nextMorningPreview: null };
    }
    // Suppress opportunities that already fell due while the manual switch was OFF (Review #2).
    const suppressedBeforeMs = act?.keepwarm_suppressed_due_before_at ? Date.parse(act.keepwarm_suppressed_due_before_at) : NaN;
    if (Number.isFinite(suppressedBeforeMs) && ordinary.dueAtMs <= suppressedBeforeMs) {
      const nextDay = addCalendarDays(today, 1);
      return {
        ...base,
        scheduled: false,
        kind: 'none',
        dueAtMs: null,
        basis: null,
        blockedReason: null,
        nextMorningPreview: { targetAtMs: Date.parse(`${nextDay}T08:00:00+08:00`), businessDate: nextDay },
      };
    }
    // An anchor from before today's 08:00 without early resume belongs to the overnight pause
    // (handled solely by Step 7's 08:00 fallback), never revived as an ordinary keepwarm round.
    const ordinaryAnchorMs = ordinary.dueAtMs - POLICY_CONSTANTS.background.keepwarm.idle_after_cache_ms;
    if (input.sleepWindow.enabled && input.nowMs >= today08Ms && ordinaryAnchorMs < today08Ms && act?.early_resumed_date !== today) {
      const nextDay = addCalendarDays(today, 1);
      return {
        ...base,
        scheduled: false,
        kind: 'none',
        dueAtMs: null,
        basis: null,
        blockedReason: null,
        nextMorningPreview: { targetAtMs: Date.parse(`${nextDay}T08:00:00+08:00`), businessDate: nextDay },
      };
    }
    const targetSleep = effectiveSleepState(input.sleepWindow, ordinary.dueAtMs, act?.early_resumed_date);
    if (targetSleep.blocked) {
      // Target falls at or after 23:00 cutoff: void tonight's target, preview tomorrow's 08:00!
      const nextMorningDate = overnightMorningDate(input.sleepWindow, ordinary.dueAtMs) ?? addCalendarDays(today, 1);
      const nextPreview = { targetAtMs: Date.parse(`${nextMorningDate}T08:00:00+08:00`), businessDate: nextMorningDate };
      return {
        ...base,
        businessDate: nextMorningDate,
        scheduled: true,
        kind: 'morning_wake',
        dueAtMs: nextPreview.targetAtMs,
        basis: 'morning_baseline',
        blockedReason: 'KEEPWARM_SLEEP_WINDOW',
        nextMorningPreview: nextPreview,
      };
    }

    return {
      ...base,
      anchorKey: ordinary.anchorKey,
      scheduled: true,
      kind: 'cache_idle',
      dueAtMs: ordinary.dueAtMs,
      basis: ordinary.basis,
      blockedReason: null,
      nextMorningPreview: null,
    };
  }
}
