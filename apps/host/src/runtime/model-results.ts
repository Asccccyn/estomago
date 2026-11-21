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
  // invalid_ids/fix（2026-11-08 林石见裁定）：PLAN_NOT_FOUND 携带无效 id 清单
  // 与一句话修复动作——失败投影放行，其余码不带这两个键不受影响。
  // asset_id/creation_id（审计 2026-11-15 P1-d）：已保存对象的真实引用不得在失败
  // 投影里丢失（发布失败回执需给模型可操作的资产引用）。
  // boundary/candidates/conflicts（包2 DBG-04 11-16 版）：锚点定位失败的最小消歧
  // 候选与版本冲突事实——没有它们模型无法按规格完成消歧/重定位。
  return select(value,['error_code','error','message','detail','saved','retryable','retry_cursor','commit_status','idempotency_key','field','missing_fields',
    'invalid_ids','fix','remaining_numbers','retry_allowed','album_entry_id','heartbeat_draw_receipt',
    'boundary','candidates','conflicts',
    'result_set_id','memory_id','episode_id','word_id','recollection_id','mark_id','relation_id',
    'asset_id','creation_id','saved_asset_id','saved_creation_id']);
}
