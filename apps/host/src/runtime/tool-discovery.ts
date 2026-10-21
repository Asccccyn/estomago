import type { Db } from '../db/connection.ts';
import { sha256Hex } from '../util/id.ts';
import type { HostToolSpec } from './host-tools.ts';
export const DISCOVERY_NAMES = ['tool_catalog','tool_define','tool_invoke'] as const;
export function buildDeferredTools(): HostToolSpec[] {
  return [
    {type:'function',function:{name:'tool_catalog',description:'列出可用工具的简短目录，不含参数定义。',parameters:{type:'object',properties:{},additionalProperties:false}}},
    {type:'function',function:{name:'tool_define',description:'需要使用某个工具时，按目录中的名称读取它的完整参数定义。',parameters:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}}},
    {type:'function',function:{name:'tool_invoke',description:'按已读取的定义调用工具；沿用返回的definition_id，不得猜参数。',parameters:{type:'object',properties:{name:{type:'string'},definition_id:{type:'string'},arguments:{type:'object',additionalProperties:true}},required:['name','definition_id','arguments'],additionalProperties:false}}},
  ];
}
export type WindowToolset = { protocol:'legacy'|'deferred'; tools:HostToolSpec[]; catalog:HostToolSpec[] };
export function storedToolset(db:Db,windowId:string):WindowToolset|null {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='window_toolsets'").get())return null;
  const row=db.prepare('SELECT protocol,wire_tools_json,catalog_json FROM window_toolsets WHERE window_id=?').get(windowId) as {protocol:'legacy'|'deferred';wire_tools_json:string;catalog_json:string}|undefined;
  return row?{protocol:row.protocol,tools:JSON.parse(row.wire_tools_json),catalog:JSON.parse(row.catalog_json)}:null;
}
export function freezeWindowTools(db:Db,windowId:string,catalog:HostToolSpec[],mode:'legacy'|'deferred'):HostToolSpec[] {
  const stored=storedToolset(db,windowId);if(stored)return stored.tools;
  // Recover the exact previously sent host tools before considering new code.
  // Old windows, including explicit empty toolsets, never silently adopt v2.
  const request=db.prepare('SELECT payload_json,payload_wire_json FROM provider_requests WHERE window_id=? AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1').get(windowId) as {payload_json:string;payload_wire_json:string|null}|undefined;
  let tools:HostToolSpec[];let protocol=mode;
  if(request){
    let recovered:unknown;
    try{recovered=JSON.parse(request.payload_json).tools}catch{}
    if(!Array.isArray(recovered))throw Error('WINDOW_TOOL_SNAPSHOT_UNAVAILABLE');
    tools=recovered;protocol=tools.some(t=>t.function?.name==='tool_invoke')?'deferred':'legacy';
  }else tools=mode==='deferred'?buildDeferredTools():catalog;
  const full=protocol==='legacy'?tools:catalog;
  db.prepare('INSERT OR IGNORE INTO window_toolsets(window_id,protocol,wire_tools_json,catalog_json,created_at) VALUES(?,?,?,?,?)').run(windowId,protocol,JSON.stringify(tools),JSON.stringify(full),new Date().toISOString());
  return storedToolset(db,windowId)!.tools;
}
export function definitionId(spec:HostToolSpec):string {return 'td_'+sha256Hex(JSON.stringify(spec)).slice(0,24)}
/** A definition is usable only after its real tool result was in this exact
 * sent request. Calling define and invoke in the same batch is not enough. */
export function definitionWasSeen(db:Db,scope:{roomId:string;windowId:string;requestId:string},spec:HostToolSpec):boolean {
  const row=db.prepare(`SELECT p.payload_json,p.payload_wire_json FROM provider_requests p JOIN turns t ON t.id=p.turn_id
    WHERE p.id=? AND p.window_id=? AND t.conversation_id=? AND p.sent_at IS NOT NULL`).get(scope.requestId,scope.windowId,scope.roomId) as {payload_json:string;payload_wire_json:string|null}|undefined;
  if(!row)return false;
  try {
    const messages=JSON.parse(row.payload_wire_json??row.payload_json).messages as any[];
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
export function effectiveToolName(name:string,raw:unknown):string {
  if(name!=='tool_invoke')return name;
  try{const a=typeof raw==='string'?JSON.parse(raw):raw;return typeof a?.name==='string'?a.name:name}catch{return name}
}
