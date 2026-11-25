import type { Db } from '../db/connection.ts';
import type { ToolSchemaMode } from '../config/schema.ts';
import { describeLiteralHanFields } from '../capabilities/model-arguments.ts';
import { definitionId, renderDefinition } from '../capabilities/definition.ts';
export { definitionId } from '../capabilities/definition.ts';
import type { ToolGroup } from '../capabilities/registry.ts';
import { toolAbility } from './tool-catalog-search.ts';
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

export function directCatalog(catalog: readonly HostToolSpec[]): HostToolSpec[] {
  return modelToolsAfterBindingRetirement(catalog).map(describeLiteralHanFields);
}

/** Project only the argument shape. The complete frozen schema owns execution validation. */
function argumentShape(schema: Record<string, unknown>): Record<string, unknown> {
  const shape: Record<string, unknown> = {};
  for (const key of ['type', 'enum', 'required']) if (key in schema) shape[key] = schema[key];
  if (schema.properties && typeof schema.properties === 'object') {
    const fields = schema.properties as Record<string, Record<string, unknown>>;
    shape.properties = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, argumentShape(field)]));
  }
  if (schema.items && typeof schema.items === 'object') shape.items = argumentShape(schema.items as Record<string, unknown>);
  return shape;
}

export function compactNativeTool(spec: HostToolSpec): HostToolSpec {
  // The window's capability list already contains the purpose of every named tool.
  return { type: 'function', function: { name: spec.function.name, description: '', parameters: argumentShape(spec.function.parameters) } };
}

export function buildDirectTools(catalog: readonly HostToolSpec[], groups: Record<string, ToolGroup>): HostToolSpec[] {
  const [search, define] = buildDeferredTools();
  return [
    compactNativeTool(search!),
    compactNativeTool(define!),
    ...modelToolsAfterBindingRetirement(catalog).filter(spec => groups[spec.function.name] === 'C')
      .map(compactNativeTool),
  ];
}

export type WindowToolset = {
  protocol: ToolSchemaMode;
  tools: HostToolSpec[];
  catalog: HostToolSpec[];
  groups: Record<string, ToolGroup>;
  initialText: string | null;
  legacyGroups: boolean;
  onDemand: boolean;
  summaries: Record<string, string> | null;
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
  const row = db.prepare('SELECT protocol,wire_tools_json,catalog_json,groups_json,initial_text,activated_tools_json,tool_summaries_json FROM window_toolsets WHERE window_id=?').get(windowId) as {
    protocol: 'legacy' | 'deferred'; wire_tools_json: string; catalog_json: string; groups_json: string | null; initial_text: string | null; activated_tools_json: string | null; tool_summaries_json: string | null;
  } | undefined;
  if (!row) return null;
  const tools = JSON.parse(row.wire_tools_json) as HostToolSpec[];
  const catalog = JSON.parse(row.catalog_json) as HostToolSpec[];
  const protocol = snapshotProtocol(row.protocol, tools);
  if (protocol === 'direct' && !row.groups_json) throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
  const groups: Record<string, ToolGroup> = row.groups_json
    ? JSON.parse(row.groups_json) : recoverInitialGroups(db, windowId, catalog);
  const onDemand = protocol === 'direct' && row.activated_tools_json !== null;
  const summaries: Record<string,string> | null = onDemand && row.tool_summaries_json !== null ? JSON.parse(row.tool_summaries_json) : null;
  if (protocol === 'direct') {
    validateDirectSnapshotTools(tools);
    validateDirectSnapshotTools(catalog);
    if (!groups || catalog.some(spec => !['C', 'D', 'T'].includes(groups[spec.function.name]!))) {
      throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
    }
    if (summaries && catalog.some(tool => typeof summaries[tool.function.name] !== 'string')) throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
    const expected = catalog.filter(spec => onDemand ? groups[spec.function.name] === 'C' : groups[spec.function.name] !== 'T');
    const published = tools.filter(spec => !['tool_catalog', 'tool_define'].includes(spec.function.name));
    if (published.length !== expected.length || published.some((spec, index) => spec.function.name !== expected[index]!.function.name)) {
      throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
    }
  }
  if (onDemand) {
    const activated: unknown = JSON.parse(row.activated_tools_json!);
    if (!Array.isArray(activated) || new Set(activated).size !== activated.length) throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
    for (const name of activated) {
      const spec = catalog.find(tool => tool.function.name === name);
      if (!spec || groups[name] !== 'D') throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
      tools.push(summaries ? compactNativeTool(spec) : spec);
    }
  }
  return { protocol, tools, catalog, groups, onDemand, summaries, initialText: row.initial_text, legacyGroups: protocol !== 'direct' && row.initial_text === null };
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
  db.prepare('INSERT OR IGNORE INTO window_toolsets(window_id,protocol,wire_tools_json,catalog_json,created_at,groups_json,initial_text,activated_tools_json,tool_summaries_json) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(windowId, physical, JSON.stringify(tools), JSON.stringify(full), new Date().toISOString(), groups ? JSON.stringify(groups) : null, initialText, mode === 'direct' ? '[]' : null,
      mode === 'direct' ? JSON.stringify(Object.fromEntries(full.map(spec => [spec.function.name, toolAbility(spec)]))) : null);
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

/** 冷启动目录同步（她 2026-11-25 裁定：不换窗也要能用最新版工具）。
 *  Host 启动时对每个 **ACTIVE** direct 窗口把冻结目录同步到当前版本：
 *  - 同名工具：定义替换为当前目录版本（catalog 与 wire 的 C 组 compact 一并更新）；
 *  - 当前新增：追加进目录，组别按当前 resolveToolGroups（新工具=D，按需发现）；
 *  - 不删除旧条目（退休工具维持既有不可执行行为）、不动 groups/激活名单/initial_text
 *    ——窗口内已交付的常驻文本与激活状态保持自身历史；
 *  - CLOSED 窗口是"当时发请求用的目录"证据，一律不动；legacy/deferred 协议如实跳过。
 *  冷启动本就重建 SDK 会话与前缀缓存，此同步不产生额外缓存代价。 */
export function syncWindowToolsetsToCurrent(db: Db, catalog: readonly HostToolSpec[], declared: Record<string, ToolGroup> = {}): {
  windows: number; refreshed: number; skipped: string[]; replaced: string[]; added: string[];
} {
  const fresh = directCatalog(catalog);
  const freshByName = new Map(fresh.map(spec => [spec.function.name, spec]));
  const freshGroups = resolveToolGroups(db, fresh, declared);
  const rows = db.prepare(
    `SELECT t.window_id FROM window_toolsets t JOIN windows w ON w.id=t.window_id WHERE w.status='ACTIVE'`,
  ).all() as Array<{ window_id: string }>;
  const out = { windows: rows.length, refreshed: 0, skipped: [] as string[], replaced: [] as string[], added: [] as string[] };
  for (const { window_id } of rows) {
    let set: WindowToolset;
    try { set = storedToolset(db, window_id)!; } catch { out.skipped.push(window_id); continue; }
    if (!set || set.protocol !== 'direct') { out.skipped.push(window_id); continue; }
    const frozenCatalog = set.catalog;
    const groups = { ...set.groups };
    const merged = frozenCatalog.map(spec => {
      const replacement = freshByName.get(spec.function.name);
      return replacement && definitionId(replacement) !== definitionId(spec) ? replacement : spec;
    });
    for (const spec of fresh) {
      if (frozenCatalog.some(frozen => frozen.function.name === spec.function.name)) continue;
      merged.push(spec);
      groups[spec.function.name] = freshGroups[spec.function.name] ?? 'D';
    }
    const summaries = Object.fromEntries(merged.map(spec => [spec.function.name, toolAbility(spec)]));
    // wire 重建与 freeze 同构：discovery 两入口 + C 组 compact（按合并目录顺序）；
    // 激活名单不在 wire——装载时从 catalog 动态物化，catalog 已同步。
    const [search, define] = buildDeferredTools();
    const wire = [compactNativeTool(search!), compactNativeTool(define!),
      ...merged.filter(spec => groups[spec.function.name] === 'C').map(compactNativeTool)];
    const next = {
      catalog_json: JSON.stringify(merged),
      groups_json: JSON.stringify(groups),
      tool_summaries_json: JSON.stringify(summaries),
      wire_tools_json: JSON.stringify(wire),
    };
    const current = db.prepare('SELECT wire_tools_json, catalog_json, groups_json, tool_summaries_json FROM window_toolsets WHERE window_id=?').get(window_id) as Record<string, string>;
    if (Object.keys(next).every(key => current[key] === next[key as keyof typeof next])) continue;
    for (const frozen of frozenCatalog) {
      const replacement = freshByName.get(frozen.function.name);
      if (replacement && definitionId(replacement) !== definitionId(frozen)) out.replaced.push(frozen.function.name);
    }
    for (const spec of fresh) {
      if (!frozenCatalog.some(frozen => frozen.function.name === spec.function.name)) out.added.push(spec.function.name);
    }
    db.prepare('UPDATE window_toolsets SET wire_tools_json=?, catalog_json=?, groups_json=?, tool_summaries_json=? WHERE window_id=?')
      .run(next.wire_tools_json, next.catalog_json, next.groups_json, next.tool_summaries_json, window_id);
    // 写后校验：与生产同一条装载路径必须能读回（快照完整性 + published/expected 一致）。
    try { storedToolset(db, window_id)!; } catch (err) {
      throw new Error(`WINDOW_TOOLSET_SYNC_CORRUPTED:${window_id}:${(err as Error).message}`);
    }
    out.refreshed++;
  }
  return out;
}
