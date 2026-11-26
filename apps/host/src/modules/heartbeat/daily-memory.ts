import type { Db } from '../../db/connection.ts';
import { tx } from '../../db/connection.ts';
import type { MariposaClient } from '../../integrations/mariposa/client.ts';
import { quoteBackgroundTool } from '../../runtime/background-tool-cost.ts';
import { settleBackgroundDispatch } from '../../runtime/background-ledger.ts';
import type { BackgroundScheduler } from '../../runtime/background-scheduler.ts';
import type { HeartbeatSource } from '../../../../../packages/contracts/src/heartbeat.ts';
import { HeartbeatCards } from './service.ts';
import type { HeartbeatDailyMemorySelection } from './sources.ts';
import type { HeartbeatSolMemorySelector } from './sol-memory-selector.ts';

export const HEARTBEAT_DAILY_MEMORY_TASK = 'bgt_heartbeat_daily_memory';
export const DAILY_MEMORY_WINDOW_MS = 60_000; // existing scheduler polls every 15s; missed midnight is not retried at noon
const DAY_MS = 86400_000, SHANGHAI_OFFSET = 8 * 3600_000;
const midnightOf = (now: number): number => Math.floor((now + SHANGHAI_OFFSET) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET;
const dateOf = (now: number): string => new Date(now + SHANGHAI_OFFSET).toISOString().slice(0, 10);

export function nextDailyMemoryDue(now: number): string {
  const midnight = midnightOf(now);
  return new Date(now - midnight < DAILY_MEMORY_WINDOW_MS ? midnight : midnight + DAY_MS).toISOString();
}

type Result = { outcome: 'completed' | 'noop' | 'failed' | 'unknown' | 'cancelled'; result_code: string };
type Candidate = { source: HeartbeatSource; text: string };
type Cursor = { memory_id: string; memory_date: string | null };

function memoryRef(raw: unknown, room: string): Candidate | null {
  const row = raw as { visibility?: unknown; representation?: unknown; content_gap?: unknown; memory_id?: unknown; version?: unknown; text?: unknown } | null;
  if (!row || row.visibility !== 'active' || row.representation === 'forgotten_summary' || row.content_gap
    || typeof row.memory_id !== 'string' || !row.memory_id || row.memory_id.length > 256
    || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1
    || typeof row.text !== 'string' || !row.text.trim()) return null;
  return { source: { kind: 'memory', namespace: 'mariposa', id: row.memory_id, revision: row.version,
    identity: 'mariposa:memory:' + row.memory_id, permissionScope: room }, text: row.text };
}

/** First-party daily source operation, not a chat turn and not a surfacing job.
 * The scheduler owns its unique daily occurrence and existing shared budget ledger. */
export class HeartbeatDailyMemory {
  private readonly cards: HeartbeatCards;
  private readonly db: Db;
  private readonly memory: MariposaClient;
  private readonly sol: HeartbeatSolMemorySelector;
  private readonly identityReady: () => boolean;
  constructor(db: Db, memory: MariposaClient, sol: HeartbeatSolMemorySelector, identityReady: () => boolean) {
    this.db=db; this.memory=memory; this.sol=sol; this.identityReady=identityReady;
    this.cards = new HeartbeatCards(db);
  }

  install(now = Date.now()): void {
    const nowIso = new Date(now).toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO background_tasks(id,conversation_id,actor_id,kind,enabled,revision,schedule_kind,
      next_due_at,timezone,local_time,payload_json,created_by_actor_id,origin,created_at,updated_at)
      VALUES(?,'primary','jiaming','heartbeat_memory',1,1,'daily',?,'Asia/Shanghai','00:00','{}','system','system_heartbeat_memory',?,?)`)
      .run(HEARTBEAT_DAILY_MEMORY_TASK, nextDailyMemoryDue(now), nowIso, nowIso);
  }

  readonly read: HeartbeatDailyMemorySelection = async (room, businessDate, signal) => {
    if (signal.aborted) return null;
    const row = this.db.prepare(`SELECT memory_id,revision,frozen_at FROM heartbeat_daily_memory_choices
      WHERE conversation_id=? AND business_date=?`).get(room,businessDate) as {memory_id:string;revision:number;frozen_at:string} | undefined;
    return row ? { businessDate, frozenAt: row.frozen_at, memoryId: row.memory_id, revision: row.revision } : null;
  };

  async execute(input: { runId: string; conversationId: string; signal: AbortSignal;
    recordDispatch: BackgroundScheduler['recordDispatchStart'] }): Promise<Result> {
    const failed = (result_code: string): Result => ({outcome:'failed',result_code});
    const row = this.db.prepare(`SELECT scheduled_for FROM background_runs WHERE id=? AND task_id=? AND kind='heartbeat_memory'
      AND conversation_id=? AND state IN ('claimed','running')`).get(input.runId,HEARTBEAT_DAILY_MEMORY_TASK,input.conversationId) as { scheduled_for:string } | undefined;
    const due = Date.parse(row?.scheduled_for ?? ''), now = Date.now();
    if (!row || !Number.isFinite(due) || due !== midnightOf(due) || now < due || now - due >= DAILY_MEMORY_WINDOW_MS) return failed('DAILY_MEMORY_MIDNIGHT_MISSED');
    const date = dateOf(due);
    if (await this.read(input.conversationId,date,input.signal)) return {outcome:'completed',result_code:'DAILY_MEMORY_ALREADY_SELECTED'};
    if (input.signal.aborted) return {outcome:'cancelled',result_code:'DAILY_MEMORY_CANCELLED'};
    if (!this.identityReady()) return failed('IDENTITY_BLOCKED');
    if (!this.sol.configured()) return failed('DAILY_MEMORY_SOL_NOT_CONFIGURED');
    let quote;
    try { quote = quoteBackgroundTool(this.db,'heartbeat_memory_select'); }
    catch { return failed('BUDGET_ESTIMATE_UNAVAILABLE'); }
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(Math.max(1,DAILY_MEMORY_WINDOW_MS - (Date.now() - due)))]);
    const candidates = await this.candidates(input.conversationId,signal);
    if (signal.aborted || input.signal.aborted) return {outcome:'cancelled',result_code:'DAILY_MEMORY_CANCELLED'};
    if (!candidates) return failed('DAILY_MEMORY_SOURCE_UNAVAILABLE');
    if (!candidates.length) return {outcome:'noop',result_code:'DAILY_MEMORY_NO_ELIGIBLE_CANDIDATE'};
    // Last permission and cooldown check happened on the pointed source before dispatch.
    if (!this.identityReady()) return failed('IDENTITY_BLOCKED');
    const admission = input.recordDispatch({runId:input.runId,logicalActionKey:'heartbeat:daily-memory:' + date,attemptNo:1,
      dispatchKind:'tool',capabilityName:quote.toolName,reservedCostMicroUsd:quote.maxCostMicroUsd});
    if (!admission.allowed) return failed(admission.code ?? 'BACKGROUND_TOOL_ADMISSION_REJECTED');
    try {
      const result = await this.sol.select(candidates.map(({source,text})=>({id:source.id,text:Array.from(text).slice(0,1500).join('')})),signal);
      if (result.status !== 'selected') return {outcome:result.status,result_code:result.code};
      const selected = candidates.find(candidate=>candidate.source.id===result.id)!;
      // The selected id must remain permitted, version-pinned and unconsumed;
      // never reroll when it changed between prompt, response and commitment.
      const verified = await this.verify(selected.source,input.conversationId,signal);
      if (!verified || signal.aborted) return failed('DAILY_MEMORY_SOURCE_CHANGED');
      const committed = tx(this.db,()=>{
        // A source may have been consumed by an earlier day's in-flight draw
        // during our source I/O. Recheck the common ledger in this writer.
        if (signal.aborted || !this.cards.isSourceEligible(selected.source)
          || !this.db.prepare("SELECT 1 FROM background_runs WHERE id=? AND state='running'").get(input.runId)) return false;
        this.db.prepare(`INSERT INTO heartbeat_daily_memory_choices(conversation_id,business_date,memory_id,revision,frozen_at,selected_at,run_id,provider_response_id)
          VALUES(?,?,?,?,?,?,?,?)`).run(input.conversationId,date,selected.source.id,selected.source.revision,
          new Date(due).toISOString(),new Date().toISOString(),input.runId,result.responseId);
        return true;
      });
      if (!committed) return failed('DAILY_MEMORY_SOURCE_CHANGED');
      return {outcome:'completed',result_code:'DAILY_MEMORY_SELECTED'};
    } finally {
      // Configured quote is an upper bound, not a verified actual price.
      settleBackgroundDispatch(this.db,admission.dispatchId,{actualCostMicroUsd:null,outcomeCode:'cost_unknown'});
    }
  }

  private async verify(source: HeartbeatSource, room: string, signal: AbortSignal): Promise<Candidate | null> {
    if (signal.aborted || !this.cards.isSourceEligible(source)) return null;
    try {
      const response = await this.memory.memoryGet(source.id,signal);
      const candidate = response.ok ? memoryRef(response.result,room) : null;
      return candidate?.source.id===source.id && candidate.source.revision===source.revision && !signal.aborted ? candidate : null;
    } catch { return null; }
  }

  private async candidates(room: string, signal: AbortSignal): Promise<Candidate[] | null> {
    const sample: HeartbeatSource[] = [], cursorKeys = new Set<string>(), identities = new Set<string>();
    let cursor: Cursor | null = null, eligible = 0;
    try {
      do {
        if (signal.aborted) return null;
        const page = await this.memory.memoryListForHeartbeat(cursor,signal);
        if (!page.ok || !Array.isArray(page.result.items)) return null;
        for (const raw of page.result.items) {
          const candidate=memoryRef(raw,room);
          if (!candidate || identities.has(candidate.source.identity) || !this.cards.isSourceEligible(candidate.source)) continue;
          identities.add(candidate.source.identity);
          // Reservoir sample across the entire paged range, never just page one.
          const slot=Math.floor(Math.random() * ++eligible);
          if (sample.length < 4) sample.push(candidate.source);
          else if (slot < 4) sample[slot] = candidate.source;
        }
        cursor = page.result.next_cursor as Cursor | null;
        if (cursor) {
          const key=JSON.stringify(cursor);
          if (typeof cursor.memory_id!=='string' || cursorKeys.has(key)) return null;
          cursorKeys.add(key);
        }
      } while (cursor);
      const candidates=await Promise.all(sample.map(source=>this.verify(source,room,signal)));
      return signal.aborted ? null : candidates.filter((item):item is Candidate=>item!==null);
    } catch { return null; }
  }
}
