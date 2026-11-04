import type { Db } from '../db/connection.ts';
import { definitionId, renderDefinition } from '../capabilities/definition.ts';
export { definitionId } from '../capabilities/definition.ts';
import type { ToolGroup } from '../capabilities/registry.ts';
import { recoverInitialGroups, resolveToolGroups, renderToolContext } from './tool-initial-visible.ts';
// P01.4/P01.1：只依赖叶类型（capabilities/contracts），不再从 host-tools 导入。
import type { HostToolSpec } from '../capabilities/contracts.ts';
export const DISCOVERY_NAMES = ['tool_catalog','tool_define','tool_invoke'] as const;
export function buildDeferredTools(): HostToolSpec[] {
  return [
    {type:'function',function:{name:'tool_catalog',description:'列出可用工具的简短目录，不含参数定义。',parameters:{type:'object',properties:{},additionalProperties:false}}},
    {type:'function',function:{name:'tool_define',description:'需要使用某个工具时，按目录中的名称读取它的完整参数定义。',parameters:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}}},
    {type:'function',function:{name:'tool_invoke',description:'按已读取的定义调用工具；沿用返回的definition_id，不得猜参数。',parameters:{type:'object',properties:{name:{type:'string'},definition_id:{type:'string'},arguments:{type:'object',additionalProperties:true}},required:['name','definition_id','arguments'],additionalProperties:false}}},
  ];
}
export type WindowToolset = { protocol:'legacy'|'deferred'; tools:HostToolSpec[]; catalog:HostToolSpec[]; groups:Record<string,ToolGroup>; initialText:string|null; legacyGroups:boolean };
export function storedToolset(db:Db,windowId:string):WindowToolset|null {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_toolsets'").get())return null;
  const row=db.prepare('SELECT protocol,wire_tools_json,catalog_json,groups_json,initial_text FROM window_toolsets WHERE window_id=?').get(windowId) as {protocol:'legacy'|'deferred';wire_tools_json:string;catalog_json:string;groups_json:string|null;initial_text:string|null}|undefined;
  if (!row) return null;
  const catalog: HostToolSpec[] = JSON.parse(row.catalog_json);
  const groups: Record<string,ToolGroup> = row.groups_json ? JSON.parse(row.groups_json)
    : recoverInitialGroups(db,windowId,catalog);
  return {protocol:row.protocol,tools:JSON.parse(row.wire_tools_json),catalog,groups,initialText:row.initial_text,legacyGroups:row.initial_text===null};

}
export function freezeWindowTools(db:Db,windowId:string,catalog:HostToolSpec[],mode:'legacy'|'deferred',declared:Record<string,ToolGroup>={}):HostToolSpec[] {
  const stored=storedToolset(db,windowId);
  if(stored){
    // Upgrade only grouping metadata reconstructed from sent facts, never history.
    if(stored.legacyGroups)db.prepare('UPDATE window_toolsets SET groups_json=? WHERE window_id=? AND groups_json IS NULL').run(JSON.stringify(stored.groups),windowId);
    return stored.tools;
  }
  // Recover the exact previously sent host tools before considering new code.
  // Old windows, including explicit empty toolsets, never silently adopt v2.
  const request=db.prepare('SELECT payload_json,payload_wire_json FROM provider_requests WHERE window_id=? AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1').get(windowId) as {payload_json:string;payload_wire_json:string|null}|undefined;
  let tools:HostToolSpec[];let protocol=mode;
  if(request){
    let recovered:unknown;
    try{recovered=JSON.parse(request.payload_json).tools}catch{}
    if(!Array.isArray(recovered))throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
    tools=recovered;protocol=tools.some(t=>t.function?.name==='tool_invoke')?'deferred':'legacy';
    if (protocol==='deferred') throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
  }else tools=mode==='deferred'?buildDeferredTools():catalog;
  const full=protocol==='legacy'?tools:catalog;
  const groups = request ? null : resolveToolGroups(db,full,declared);
  const initialText = groups && protocol === 'deferred' ? renderToolContext(full,groups) : null;
  db.prepare('INSERT OR IGNORE INTO window_toolsets(window_id,protocol,wire_tools_json,catalog_json,created_at,groups_json,initial_text) VALUES(?,?,?,?,?,?,?)').run(windowId,protocol,JSON.stringify(tools),JSON.stringify(full),new Date().toISOString(),groups ? JSON.stringify(groups) : null,initialText);
  return storedToolset(db,windowId)!.tools;
}
/** A definition is usable only after its real tool result was in this exact
 * sent request. Calling define and invoke in the same batch is not enough. */
export function definitionWasSeen(db:Db,scope:{roomId:string;windowId:string;requestId:string},spec:HostToolSpec):boolean {
  const row=db.prepare(`SELECT p.payload_json,p.payload_wire_json,p.tool_context_json FROM provider_requests p JOIN turns t ON t.id=p.turn_id
    WHERE p.id=? AND p.window_id=? AND t.conversation_id=? AND p.sent_at IS NOT NULL`).get(scope.requestId,scope.windowId,scope.roomId) as {payload_json:string;payload_wire_json:string|null;tool_context_json:string|null}|undefined;
  if(!row)return false;
  try {
    const proofs=JSON.parse(row.tool_context_json??'[]');
    if(proofs.some((proof:any)=>proof.name===spec.function.name && proof.definition_id===definitionId(spec)))return true;
    const messages=JSON.parse(row.payload_wire_json??row.payload_json).messages as any[];
    const set = storedToolset(db,scope.windowId);
    const canonical = JSON.parse(row.payload_json).messages as any[];
    if (set?.groups[spec.function.name] === 'C' && canonical.some(m => m.role === 'system' &&
        (typeof m.content === 'string' ? [m.content] : (m.content ?? []).filter((b:any)=>b.type==='text').map((b:any)=>b.text))
          .some((text:string)=>text.includes('[tools/initial') && text.includes(renderDefinition(spec))))) return true;
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
  if (set.protocol !== 'deferred') return null;
  const spec = set.catalog.find(s => s.function.name === name);
  if (!spec || (!set.legacyGroups && set.groups[name] !== 'T')) return null;
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
    if (set.groups[spec.function.name] === 'C' && systems.some(text => text.includes('[tools/initial') && text.includes(renderDefinition(spec)))) {
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
