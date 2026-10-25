/** Model-only result contracts. Never use these objects as write receipts or CAS state.
 * IDs locate a writable object; revisions/receipts/cursors are next-call arguments.
 * Business text is copied verbatim. False and zero are not globally suppressed.
 */
type Obj = Record<string, any>;
const obj = (v: any): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
export function select(v: any, keys: string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (obj(v)[k] !== undefined && v[k] !== null && v[k] !== '') out[k] = structuredClone(v[k]);
  return out;
}
/** Failure is never rewritten as success. References with no model status tool stay internal. */
export function modelFailure(value: Obj): Obj {
  return select(value,['error_code','error','message','detail','saved','retryable','field','missing_fields',
    'result_set_id','memory_id','episode_id','word_id','recollection_id','mark_id','relation_id']);
}
