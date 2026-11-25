import type { Db } from '../db/connection.ts';
import type { HostToolSpec } from '../capabilities/contracts.ts';
import type { ToolGroup } from '../capabilities/registry.ts';
import { definitionId, renderDefinition } from '../capabilities/definition.ts';
import { toolAbility } from './tool-catalog-search.ts';
import { residentToolGuide, residentToolNames } from './tool-resident-guides.ts';

/** Apply the approved default only when producing a new window's snapshot. */
export function resolveToolGroups(db: Db, specs: readonly HostToolSpec[], declared: Record<string, ToolGroup>): Record<string, ToolGroup> {
  let initial = new Set(residentToolNames);
  const row = db.prepare('SELECT value FROM runtime_settings WHERE key=?').get('tools_initial_visible') as {value:string} | undefined;
  if (row) {
    try {
      const value = JSON.parse(row.value);
      if (Array.isArray(value) && value.every(name => typeof name === 'string')) initial = new Set(value);
    } catch { /* 损坏的覆盖不影响已批准的默认名单。 */ }
  }
  return Object.fromEntries(specs.map(spec => {
    const name = spec.function.name;
    return [name, declared[name] === 'T' ? 'T' : initial.has(name) ? 'C' : 'D'];
  }));
}

export const RESIDENT_TOOL_HEADING = '常驻工具';

const RESIDENT_REMINDER = '你想记下一件事，可以自己存，发现记错了也可以改。想起旧事，可以自己去找，想往下看也可以点开读。想画图、发语音、打电话、给自己约个时间、写一颗星、问宿主用户要一颗星、翻相册或收藏、发朋友圈、抽一张今天的牌，下面的工具就在手边。';
const MAP_REMINDER = '想做别的事，比如读聊天记录、改计划或找旧存档，就到工具地图里找。用 tool_catalog 的 query 说你想做什么。搜不到时，可以省略 query 看当前目录，再用准确工具名查询。';

export function renderToolContext(specs: readonly HostToolSpec[], groups: Record<string, ToolGroup>, mode: 'deferred' | 'direct' = 'deferred'): string | null {
  if (mode === 'direct') {
    const lines = (group: ToolGroup) => specs.filter(spec => groups[spec.function.name] === group)
      .map(spec => `${toolAbility(spec)} → ${spec.function.name}`);
    return [
      '这些事我可以直接做，写给她的话直接填汉字。', ...lines('C'),
      '这些事也可以做。用 tool_define 查到参数后，按原名直接调用。', ...lines('D'),
      '我可以按意图搜索可用工具 → tool_catalog', '我可以查看一个工具的完整参数定义 → tool_define',
    ].join('\n');
  }
  const initial = new Map(specs.filter(spec => groups[spec.function.name] === 'C').map(spec => [spec.function.name, spec]));
  const hasDeferred = specs.some(spec => groups[spec.function.name] === 'D');
  const lines: string[] = [];
  if (hasDeferred) {
    const reminder = residentToolNames.every(name => initial.has(name)) ? RESIDENT_REMINDER : '';
    lines.push(reminder + MAP_REMINDER);
  }
  if (initial.size) {
    lines.push(RESIDENT_TOOL_HEADING, '这些工具的参数齐了就可以直接用 tool_invoke。');
    for (const name of residentToolNames) {
      const spec = initial.get(name);
      if (!spec) continue;
      lines.push(`- ${name}\n${residentToolGuide(spec)}`);
      initial.delete(name);
    }
    for (const spec of initial.values()) lines.push(renderDefinition(spec));
  }
  return lines.length ? lines.join('\n') : null;
}

/** Accept the framing of both the current and already frozen full definitions. */
export function includesInitialDefinition(systemText: string, renderedDefinition: string): boolean {
  return (systemText.includes('[tools/initial') || systemText.includes(RESIDENT_TOOL_HEADING + '\n')) &&
    systemText.includes(renderedDefinition);
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
        if (proof.some((p:any)=>p.kind==='initial'&&p.name===spec.name&&p.definition_id===spec.id) || texts.some((text:string)=>includesInitialDefinition(text, spec.text))) groups[spec.name]='C';
      }
    } catch { /* A malformed old request cannot establish definition delivery. */ }
  }
  return groups;
}

export function initialDefinitionSeen(db: Db, windowId: string, spec: HostToolSpec): boolean {
  return recoverInitialGroups(db,windowId,[spec])[spec.function.name] === 'C';
}
