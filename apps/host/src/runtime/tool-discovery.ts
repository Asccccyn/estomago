import type { Db } from '../db/connection.ts';
import type { ToolSchemaMode } from '../config/schema.ts';
import { describeLiteralHanFields } from '../capabilities/model-arguments.ts';
import { definitionId, renderDefinition } from '../capabilities/definition.ts';
export { definitionId } from '../capabilities/definition.ts';
import type { ToolGroup } from '../capabilities/registry.ts';
import { includesInitialDefinition, recoverInitialGroups, resolveToolGroups, renderToolContext } from './tool-initial-visible.ts';
// P01.4/P01.1：只依赖叶类型（capabilities/contracts），不再从 host-tools 导入。
import type { HostToolSpec } from '../capabilities/contracts.ts';
export const DISCOVERY_NAMES = ['tool_catalog','tool_define','tool_invoke'] as const;
export function buildDeferredTools(): HostToolSpec[] {
  return [
    // 包4发现整改（2026-11-18）：catalog 增可选 query——按意图或准确工具名一次返回
    // 必要完整定义（含预载工具；索引来自本窗冻结 catalog，不另维护手写 map）。
    {type:'function',function:{name:'tool_catalog',description:'按业务意图（如"把这句话保存成原话""生成一张图"）或准确工具名查询工具，一次返回完成调用所需的完整定义（含参数）。不带 query 时列出全部工具的简短目录。查到的能力与当前窗口合同一致；搜索本身不是执行授权之外的新权限。',parameters:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:200,description:'业务意图短语或准确工具名'}},additionalProperties:false}}},
    {type:'function',function:{name:'tool_define',description:'需要使用某个工具时，按目录中的名称读取它的完整参数定义。',parameters:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}}},
    // RT01（复审 20261106）：公开 schema 与执行事实一致——P6 起允许不读定义直接
    // invoke（执行侧按冻结业务 schema/权限校验）；definition_id 仅在沿已读定义
    // 调用时携带（宿主核其版本，过期拒 TOOL_DEFINITION_STALE）。旧描述"按已读取
    // 的定义调用、不得猜参数"+必填 definition_id 与直接执行事实矛盾。
    {type:'function',function:{name:'tool_invoke',description:'调用工具。可直接按目录名称和 arguments 调用（参数以 tool_define 读取的完整定义为准）；若此前读过该工具的定义，携带返回的 definition_id 以便版本核对。',parameters:{type:'object',properties:{name:{type:'string'},definition_id:{type:'string',description:'可选：沿已读定义调用时携带（tool_define 返回值）；缺省=直接调用'},arguments:{type:'object',additionalProperties:true}},required:['name','arguments'],additionalProperties:false}}},
  ];
}
/** Remove the retired binding surface from newly advertised tools. The
 * persisted schema still proves what an earlier request actually delivered. */
export function modelDefinitionAfterBindingRetirement(spec: HostToolSpec): HostToolSpec | null {
  const definition = spec.function;
  if (definition.name === 'memory_source_bind') return null;
  const properties = definition.parameters.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return spec;
  if (definition.name === 'memory_hold') {
    const { source_ranges, source_selections, event_source_ranges, ...remaining } = properties;
    if (!source_ranges && !source_selections && !event_source_ranges && !definition.description.includes('memory_source_bind')) return spec;
    return {
      ...spec,
      function: {
        ...definition,
        description: '直接保存一件事为正式记忆。原文关联由后台任务处理。',
        parameters: { ...definition.parameters, properties: remaining },
      },
    };
  }
  if (definition.name !== 'memory_correct') return spec;

  const action = properties.action;
  if (!action || !Array.isArray(action.enum) || !action.enum.includes('binding')) return spec;
  const { binding_id: _removed, ...remaining } = properties;
  const correction = remaining.correction_action;
  if (correction && typeof correction.description === 'string') {
    remaining.correction_action = { ...correction, description: correction.description.replace('/binding/', '/') };
  }
  return {
    ...spec,
    function: {
      ...definition,
      description: definition.description
        .replace('错误的关联或绑定', '错误的关联')
        .replace('、binding（原文区间绑定纠错——同两动作）', '')
        .replace('或原文绑定', '')
        .replace('、binding、', '、'),
      parameters: {
        ...definition.parameters,
        properties: { ...remaining, action: { ...action, enum: action.enum.filter(value => value !== 'binding') } },
      },
    },
  };
}

export function modelToolsAfterBindingRetirement(specs: readonly HostToolSpec[]): HostToolSpec[] {
  return specs.flatMap(spec => modelDefinitionAfterBindingRetirement(spec) ?? []);
}

function directCatalog(catalog: readonly HostToolSpec[]): HostToolSpec[] {
  return modelToolsAfterBindingRetirement(catalog).map(describeLiteralHanFields);
}

/** Direct windows advertise ordinary business tools and the two read-only discovery tools. */
export function buildDirectTools(catalog: readonly HostToolSpec[], groups: Record<string, ToolGroup>): HostToolSpec[] {
  const [search, define] = buildDeferredTools();
  return [
    { ...search!, function: { ...search!.function, description: '按业务意图或名称查询当前可用的工具和完整定义。已有所需参数时，直接按业务工具名调用。' } },
    { ...define!, function: { ...define!.function, description: '按工具名核对完整参数定义。参数齐备时可直接调用业务工具。' } },
    ...directCatalog(catalog).filter(spec => groups[spec.function.name] !== 'T'),
  ];
}

export type WindowToolset = {
  protocol: ToolSchemaMode;
  tools: HostToolSpec[];
  catalog: HostToolSpec[];
  groups: Record<string, ToolGroup>;
  initialText: string | null;
  legacyGroups: boolean;
};

function validateDirectSnapshotTools(value: unknown): void {
  if (!Array.isArray(value) || value.some(tool =>
    tool?.type !== 'function' || typeof tool.function?.name !== 'string'
    || !tool.function.name || typeof tool.function.description !== 'string'
    || !tool.function.parameters || typeof tool.function.parameters !== 'object'
    || Array.isArray(tool.function.parameters))) {
    throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
  }
}

/** Distinguish existing deferred snapshots from native ones without rewriting rows or the CHECK. */
function snapshotProtocol(physical: 'legacy' | 'deferred', tools: HostToolSpec[]): ToolSchemaMode {
  if (physical === 'legacy') return 'legacy';
  if (!Array.isArray(tools)) throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
  const names = new Set(tools.map(tool => tool?.function?.name));
  if (names.has('tool_invoke')) return 'deferred';
  if (names.size !== tools.length || !names.has('tool_catalog') || !names.has('tool_define')) {
    throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
  }
  return 'direct';
}

export function storedToolset(db: Db, windowId: string): WindowToolset | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_toolsets'").get()) return null;
  const row = db.prepare('SELECT protocol,wire_tools_json,catalog_json,groups_json,initial_text FROM window_toolsets WHERE window_id=?').get(windowId) as {
    protocol: 'legacy' | 'deferred'; wire_tools_json: string; catalog_json: string; groups_json: string | null; initial_text: string | null;
  } | undefined;
  if (!row) return null;
  const tools = JSON.parse(row.wire_tools_json) as HostToolSpec[];
  const catalog = JSON.parse(row.catalog_json) as HostToolSpec[];
  const protocol = snapshotProtocol(row.protocol, tools);
  if (protocol === 'direct' && !row.groups_json) throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
  const groups: Record<string, ToolGroup> = row.groups_json
    ? JSON.parse(row.groups_json) : recoverInitialGroups(db, windowId, catalog);
  if (protocol === 'direct') {
    validateDirectSnapshotTools(tools);
    validateDirectSnapshotTools(catalog);
    if (!groups || catalog.some(spec => !['C', 'D', 'T'].includes(groups[spec.function.name]!))) {
      throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
    }
    const expected = catalog.filter(spec => groups[spec.function.name] !== 'T');
    const published = tools.filter(spec => !['tool_catalog', 'tool_define'].includes(spec.function.name));
    if (published.length !== expected.length || published.some((spec, index) => spec.function.name !== expected[index]!.function.name)) {
      throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
    }
  }
  return { protocol, tools, catalog, groups, initialText: row.initial_text, legacyGroups: protocol !== 'direct' && row.initial_text === null };
}

export function freezeWindowTools(db: Db, windowId: string, catalog: HostToolSpec[], mode: ToolSchemaMode, declared: Record<string, ToolGroup> = {}): HostToolSpec[] {
  const stored = storedToolset(db, windowId);
  if (stored) {
    // Recover old grouping metadata with sent evidence, without changing the wire or catalog.
    if (stored.legacyGroups) db.prepare('UPDATE window_toolsets SET groups_json=? WHERE window_id=? AND groups_json IS NULL')
      .run(JSON.stringify(stored.groups), windowId);
    return stored.tools;
  }

  // An already-sent legacy wire can be recovered as-is. Discovery tools require
  // the frozen catalog and task groups, which cannot be inferred from one request.
  const request = db.prepare('SELECT payload_json FROM provider_requests WHERE window_id=? AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1').get(windowId) as { payload_json: string } | undefined;
  let full: HostToolSpec[];
  let tools: HostToolSpec[];
  let groups: Record<string, ToolGroup> | null;
  let initialText: string | null = null;
  if (request) {
    let recovered: unknown;
    try { recovered = JSON.parse(request.payload_json).tools; } catch { /* checked below */ }
    if (!Array.isArray(recovered)) throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
    tools = recovered;
    if (tools.some(tool => (DISCOVERY_NAMES as readonly string[]).includes(tool?.function?.name))) {
      throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
    }
    full = tools;
    groups = null;
    mode = 'legacy';
  } else {
    full = mode === 'direct' ? directCatalog(catalog) : catalog;
    groups = resolveToolGroups(db, full, declared);
    tools = mode === 'direct' ? buildDirectTools(full, groups) : mode === 'deferred' ? buildDeferredTools() : full;
    if (mode !== 'legacy') initialText = renderToolContext(full, groups, mode);
  }
  const physical = mode === 'direct' ? 'deferred' : mode;
  db.prepare('INSERT OR IGNORE INTO window_toolsets(window_id,protocol,wire_tools_json,catalog_json,created_at,groups_json,initial_text) VALUES(?,?,?,?,?,?,?)')
    .run(windowId, physical, JSON.stringify(tools), JSON.stringify(full), new Date().toISOString(), groups ? JSON.stringify(groups) : null, initialText);
  return storedToolset(db, windowId)!.tools;
}

/** Add a task-only native definition after the caller has verified task scope. */
export function toolsetForTask(set: WindowToolset, name: string): HostToolSpec[] {
  if (set.protocol !== 'direct' || set.groups[name] !== 'T') return set.tools;
  const task = set.catalog.find(spec => spec.function.name === name);
  return task ? [...set.tools, task] : set.tools;
}

/** Report whether the full definition was actually delivered in this sent request.
 * A resident usage guide does not count as the full schema, and delivery is not an invocation gate. */
export function definitionWasSeen(db:Db,scope:{roomId:string;windowId:string;requestId:string},spec:HostToolSpec):boolean {
  const row=db.prepare(`SELECT p.payload_json,p.payload_wire_json,p.payload_format,p.tool_context_json FROM provider_requests p JOIN turns t ON t.id=p.turn_id
    WHERE p.id=? AND p.window_id=? AND t.conversation_id=? AND p.sent_at IS NOT NULL`).get(scope.requestId,scope.windowId,scope.roomId) as {payload_json:string;payload_wire_json:string|null;payload_format:string|null;tool_context_json:string|null}|undefined;
  if(!row)return false;
  try {
    const set = storedToolset(db,scope.windowId);
    if (set?.protocol === 'direct' && (row.payload_wire_json || row.payload_format !== 'sdk_projection_v1')) {
      const sent = JSON.parse(row.payload_wire_json ?? row.payload_json);
      if (Array.isArray(sent.tools) && sent.tools.some((tool: HostToolSpec) =>
        tool.function?.name === spec.function.name && definitionId(tool) === definitionId(spec))) return true;
    }
    // SDK projects provider-compatible schemas. A later tool_define result
    // can still prove delivery of the complete frozen business definition.
    const proofs=JSON.parse(row.tool_context_json??'[]');
    if(proofs.some((proof:any)=>proof.name===spec.function.name && proof.definition_id===definitionId(spec)))return true;
    const messages=JSON.parse(row.payload_wire_json??row.payload_json).messages as any[];
    const canonical = JSON.parse(row.payload_json).messages as any[];
    if (set?.groups[spec.function.name] === 'C' && canonical.some(m => m.role === 'system' &&
        (typeof m.content === 'string' ? [m.content] : (m.content ?? []).filter((b:any)=>b.type==='text').map((b:any)=>b.text))
          .some((text:string)=>includesInitialDefinition(text, renderDefinition(spec))))) return true;
    const ids=new Set<string>();
    for(const m of messages){
      if(m.role==='assistant')for(const tc of m.tool_calls??[]){
        if(tc.function?.name!=='tool_define')continue;
        const a=JSON.parse(tc.function.arguments);if(a.name===spec.function.name)ids.add(tc.id);
      }
      if(m.role==='tool'&&ids.has(m.tool_call_id)){
        const text=typeof m.content==='string'?m.content:(m.content??[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('');
        const result=JSON.parse(text);
        if(result.definition_id===definitionId(spec)&&result.name===spec.function.name
            &&JSON.stringify(result.parameters)===JSON.stringify(spec.function.parameters))return true;
      }
    }
  }catch{return false}
  return false;
}
export function taskDefinitionContext(set: WindowToolset, name: string, taskId: string): string | null {
  if (set.protocol === 'legacy') return null;
  const spec = set.catalog.find(s => s.function.name === name);
  if (!spec || (!set.legacyGroups && set.groups[name] !== 'T')) return null;
  if (set.protocol === 'direct') return `[tools/task:${taskId}：当前宿主任务；可直接调用 ${name}。]`;
  return `[tools/task:${taskId}：宿主任务附加定义；完成动作仍核验当前活动任务]\n${renderDefinition(spec)}`;
}

/** Provenance is written by the host request builder, never inferred from a user ID mention. */
export function recordToolContext(db: Db, requestId: string, windowId: string, messages: any[], task?: {name:string;id:string}): void {
  const set = storedToolset(db,windowId);
  if (!set || set.protocol !== 'deferred') return;
  const texts = (role:string) => messages.filter(m => m.role === role).flatMap(m => typeof m.content === 'string' ? [m.content] : (m.content ?? []).filter((b:any) => b.type === 'text').map((b:any) => b.text));
  const systems = texts('system');
  const proofs: Array<{kind:string;name:string;definition_id:string;task_id?:string}> = [];
  for (const spec of set.catalog) {
    if (set.groups[spec.function.name] === 'C' && systems.some(text => includesInitialDefinition(text, renderDefinition(spec)))) {
      proofs.push({kind:'initial',name:spec.function.name,definition_id:definitionId(spec)});
    }
  }
  if (task) {
    const context = taskDefinitionContext(set,task.name,task.id);
    const spec = set.catalog.find(s => s.function.name === task.name);
    if (context && spec && texts('user').some(text => text.includes(context))) proofs.push({kind:'task',name:task.name,definition_id:definitionId(spec),task_id:task.id});
  }
  db.prepare('UPDATE provider_requests SET tool_context_json=? WHERE id=?').run(JSON.stringify(proofs),requestId);
}

export function effectiveToolName(name:string,raw:unknown):string {
  if(name!=='tool_invoke')return name;
  try{const a=typeof raw==='string'?JSON.parse(raw):raw;return typeof a?.name==='string'?a.name:name}catch{return name}
}
