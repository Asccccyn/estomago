import type { Db } from '../db/connection.ts';
import type { HostToolSpec } from '../capabilities/contracts.ts';
import type { ToolGroup } from '../capabilities/registry.ts';
import { definitionId, renderDefinition } from '../capabilities/definition.ts';

/** Configuration is resolved only by the new-window snapshot producer. */
export function resolveToolGroups(db: Db, specs: readonly HostToolSpec[], declared: Record<string, ToolGroup>): Record<string, ToolGroup> {
  let initial: string[] | null = null;
  const row = db.prepare('SELECT value FROM runtime_settings WHERE key=?').get('tools_initial_visible') as {value:string} | undefined;
  if (row) {
    try {
      const value = JSON.parse(row.value);
      if (Array.isArray(value) && value.every(name => typeof name === 'string')) initial = value;
    } catch { /* Keep descriptor groups if the stored override is invalid. */ }
  }
  return Object.fromEntries(specs.map(spec => {
    const name = spec.function.name, group = declared[name] ?? 'D';
    return [name, group === 'T' || initial === null ? group : initial.includes(name) ? 'C' : 'D'];
  }));
}

export function renderToolContext(specs: readonly HostToolSpec[], groups: Record<string, ToolGroup>): string | null {
  const initial = specs.filter(spec => groups[spec.function.name] === 'C');
  const deferred = specs.filter(spec => groups[spec.function.name] === 'D');
  const lines: string[] = [];
  if (initial.length) {
    lines.push('[tools/initial：以下工具完整定义随本窗提供；实际收到后可直接 tool_invoke，携带 definition_id]');
    lines.push(...initial.map(renderDefinition));
  }
  if (deferred.length) {
    lines.push('[tools/deferred：需要时可直接 tool_define(name)，取得完整定义后再调用]');
    lines.push(...deferred.map(spec => `- ${spec.function.name}：${spec.function.description.split(/[。\n]/)[0]}。`));
  }
  return lines.length ? lines.join('\n') : null;
}

export function renderInitialVisibleText(db: Db, specs: readonly HostToolSpec[], declared: Record<string, ToolGroup> = {}): string | null {
  return renderToolContext(specs, resolveToolGroups(db, specs, declared));
}

/** Recover in one pass over persisted requests; no live configuration or new catalog. */
export function recoverInitialGroups(db: Db, windowId: string, catalog: readonly HostToolSpec[]): Record<string, ToolGroup> {
  const groups: Record<string, ToolGroup> = Object.fromEntries(catalog.map(spec => [spec.function.name,'D']));
  const definitions = catalog.map(spec => ({name:spec.function.name,id:definitionId(spec),text:renderDefinition(spec)}));
  const rows = db.prepare('SELECT payload_json,tool_context_json FROM provider_requests WHERE window_id=? AND sent_at IS NOT NULL ORDER BY created_at').iterate(windowId);
  for (const raw of rows) {
    const row = raw as {payload_json:string;tool_context_json:string|null};
    try {
      const proof = JSON.parse(row.tool_context_json ?? '[]');
      const messages = JSON.parse(row.payload_json).messages;
      const texts = Array.isArray(messages) ? messages.filter((m:any)=>m.role==='system').flatMap((m:any)=>typeof m.content==='string'?[m.content]:(m.content??[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text)) : [];
      for (const spec of definitions) {
        if (proof.some((p:any)=>p.kind==='initial'&&p.name===spec.name&&p.definition_id===spec.id) || texts.some((text:string)=>text.includes('[tools/initial')&&text.includes(spec.text))) groups[spec.name]='C';
      }
    } catch { /* A malformed old request cannot establish definition delivery. */ }
  }
  return groups;
}

export function initialDefinitionSeen(db: Db, windowId: string, spec: HostToolSpec): boolean {
  return recoverInitialGroups(db,windowId,[spec])[spec.function.name] === 'C';
}
