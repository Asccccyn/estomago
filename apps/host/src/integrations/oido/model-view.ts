// Generated contract snapshot has a single owner (oído); sync script preserves its hash.
// Used only for new tool receipts. Stored window definitions/trajectory are never rewritten.
import contract from './contracts/model-projection.json' with { type: 'json' };
type Value = Record<string, unknown>;
type Schema = { $ref?: string; type?: string | string[]; properties?: Record<string, Schema>; items?: Schema | boolean; prefixItems?: Schema[]; required?: string[]; enum?: unknown[]; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; minimum?: number; maximum?: number };
function project(raw: unknown, spec: Schema): unknown {
  if(spec.$ref) spec=(contract.schema.$defs as Record<string,Schema>)[spec.$ref.split('/').at(-1)!];
  if(typeof raw==='number' && !Number.isFinite(raw))throw new Error('OIDO_RESULT_INVALID');
  const types=Array.isArray(spec.type)?spec.type:[spec.type];
  const type=raw===null?'null':Array.isArray(raw)?'array':typeof raw;
  if(spec.type && !types.includes(type) && !(types.includes('integer') && typeof raw==='number' && Number.isInteger(raw))) throw new Error('OIDO_RESULT_INVALID');
  if(spec.enum && !spec.enum.includes(raw))throw new Error('OIDO_RESULT_INVALID');
  if(raw!==null && typeof raw==='object' && !Array.isArray(raw)) {
    const v=raw as Value,out:Value={};
    for(const key of spec.required??[])if(v[key]===undefined)throw new Error('OIDO_RESULT_INVALID');
    for(const [key,s] of Object.entries(spec.properties??{}))if(v[key]!==undefined)out[key]=project(v[key],s);
    return out;
  }
  if(Array.isArray(raw)) {
    if(raw.length<(spec.minItems??0)||raw.length>(spec.maxItems??Infinity))throw new Error('OIDO_RESULT_INVALID');
    return raw.map((v,i)=>project(v,spec.prefixItems?.[i]??(typeof spec.items==='object'?spec.items:{})));
  }
  if(typeof raw==='string' && ([...raw].length<(spec.minLength??0)||[...raw].length>(spec.maxLength??Infinity)))throw new Error('OIDO_RESULT_INVALID');
  if(typeof raw==='number' && (raw<(spec.minimum??-Infinity)||raw>(spec.maximum??Infinity)))throw new Error('OIDO_RESULT_INVALID');
  return raw;
}
export function oidoModelView(value: Value, page=false): Value {
  const kind=page?'prosody_page':(value.state==='queued'||value.state==='running')?'analysis_ticket':'evidence_overview';
  const out=project(value,(contract.schema.$defs as Record<string,Schema>)[kind]) as Value;
  if(Buffer.byteLength(JSON.stringify(out),'utf8')>contract.budgets[kind])throw new Error('OIDO_RESULT_BUDGET_EXCEEDED');
  return out;
}
