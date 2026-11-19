import type { Db } from '../db/connection.ts';
import type { CapabilityRegistry } from '../capabilities/registry.ts';
import { toolPresentation } from '../capabilities/model-bridge-meta.ts';

type ToolActivity = {
  tool: string; effective_tool?: string; label: string; tool_call_id: string | null;
  attempt_id: string | null; request_id: string | null; phase: string;
  ok?: boolean; error_code?: string | null; sequence: number; event_id: string; occurred_at: string;
};

/** Rebuild the display from persisted lifecycle events, without replaying tools. */
export function readToolActivity(db: Db, registry: CapabilityRegistry | null, turnId: string, attemptId: string | null): ToolActivity[] {
  const rows = db.prepare("SELECT sequence,event_id,occurred_at,payload_ref FROM runtime_stream_events WHERE turn_id=? AND kind='turn.tool' ORDER BY sequence")
    .all(turnId) as Array<{ sequence: number; event_id: string; occurred_at: string; payload_ref: string }>;
  const events = rows.map(row => ({ ...JSON.parse(row.payload_ref), sequence: row.sequence, event_id: row.event_id, occurred_at: row.occurred_at })) as ToolActivity[];
  const filtered = attemptId ? events.filter(event => event.attempt_id === attemptId) : events;
  const missing = new Set(filtered.filter(e => !e.effective_tool && e.tool_call_id && ['tool_define', 'tool_invoke'].includes(e.tool)).map(e => e.tool_call_id!));
  const recovered = new Map<string, Record<string, unknown>>();
  // Older events only stored the wrapper name. The sent request already holds
  // the real call arguments; expose only its registered target, never its input.
  if (missing.size) {
    const requests = db.prepare('SELECT payload_json FROM provider_requests WHERE turn_id=? ORDER BY created_at DESC').all(turnId) as Array<{ payload_json: string }>;
    for (const request of requests) {
      const messages = (JSON.parse(request.payload_json).messages ?? []) as Array<{ tool_calls?: Array<{ id: string; function: { arguments: string } }> }>;
      for (const message of messages) for (const call of message.tool_calls ?? []) {
        if (!missing.has(call.id)) continue;
        try {
          const args = JSON.parse(call.function.arguments);
          if (args && typeof args === 'object' && !Array.isArray(args)) recovered.set(call.id, args);
        } catch { /* Malformed provider arguments have no verified target. */ }
        missing.delete(call.id);
      }
      if (!missing.size) break;
    }
  }
  const calls = new Map<string, ToolActivity>();
  for (const event of filtered) {
    const key = [event.attempt_id ?? '', event.request_id ?? '', event.tool_call_id ?? event.event_id].join(':');
    const presentation = event.effective_tool ? { effective_tool: event.effective_tool, label: event.label }
      : toolPresentation(registry, event.tool, recovered.get(event.tool_call_id ?? '') ?? {});
    calls.set(key, { ...event, ...presentation, occurred_at: calls.get(key)?.occurred_at ?? event.occurred_at });
  }
  return [...calls.values()];
}
