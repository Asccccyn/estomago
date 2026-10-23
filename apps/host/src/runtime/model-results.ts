/** Model-only result contracts. Never use these objects as write receipts or CAS state.
 * IDs locate a writable object; revisions/receipts/cursors are next-call arguments.
 * Business text is copied verbatim. False and zero are not globally suppressed.
 */
type Obj = Record<string, any>;
const obj = (v: any): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const list = (v: any): any[] => Array.isArray(v) ? v : [];
export function select(v: any, keys: string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (obj(v)[k] !== undefined && v[k] !== null && v[k] !== '') out[k] = structuredClone(v[k]);
  return out;
}
function relation(v: Obj): Obj {
  const out = select(v, ['relation_id','from_memory','to_memory','memory_id','plan_id','relation_type','custom_label','reverse_label','reversed','direction','domain']);
  if (v.confidence && !['exact','human','confirmed'].includes(v.confidence)) out.uncertain = true;
  if(v.other) {
    const t=obj(v.other), target:Obj={};
    for(const key of ['memory_id','plan_id','item_id','word_id','id'])if(t[key]){target[key]=t[key];break;}
    if(t.item_id && t.revision!==undefined)target.revision=t.revision;
    const title=t.title??t.original_title??t.name;if(title)target.title=title;
    out.target=target;
  }
  return out;
}
function word(v: Obj): Obj { return select(v,['word_id','speaker','text','source_ref','source_binding_version']); }
function recollection(v: Obj): Obj { return select(v,['recollection_id','author','text','supersedes']); }
function keep(v: Obj): Obj {
  const out = select(v,['mark_id','owner','recollection_id']);
  if (v.revoked_at) out.revoked = true;
  return out;
}
function episode(v: Obj): Obj {
  const out=select(v,['episode_id','label','state','revision','current_revision','current_state','last_reason_code']);
  const ref=(x:Obj)=>select(x,['source_message_id','content_hash','char_offset']);
  if(list(v.source_selections).length)out.source_selections=v.source_selections.map((x:Obj)=>({
    ...select(x,['conversation_id','start_char_offset','end_char_offset']),
    members:list(x.members).map(ref),
  }));
  if(v.terminal_source_ref)out.terminal_source_ref=ref(v.terminal_source_ref);
  if(list(v.decision_source_refs).length)out.decision_source_refs=v.decision_source_refs.map(ref);
  return out;
}

function plan(v: Obj): Obj {
  const out = select(v,['plan_id','version','title','content','state','starts_at','due_at','date_start','date_end','timezone','all_day','weight','link_memory_ids']);
  if (!out.plan_id && v.id) out.plan_id=v.id;
  if (out.version === undefined && v.current_version_no !== undefined) out.version=v.current_version_no;
  return out;
}
function identity(v: Obj, history=false): Obj {
  const out=select(v,['item_id','revision','current_revision','content','change_reason','informed_by_revision','restored_from_revision','is_current']);
  if (history) Object.assign(out,select(v,['authored_by','created_at','change_type','based_on_revision','version_no']));
  if (list(v.relations).length) out.relations=v.relations.map(relation);
  return out;
}
export function candidates(v: any[]): Obj[] {
  return v.map(raw=>{
    if(!raw || typeof raw!=='object' || Array.isArray(raw))return raw;
    const c=obj(raw), out=select(c,['memory_id','word_id','plan_id','memory_date','speaker','text','title','original_title','categories','mood','excerpt','judgement','source_ref','source_binding_version']);
    if(out.mood)out.mood=select(out.mood,['text','tags','author']);
    if (!out.memory_id && !out.word_id && !out.plan_id && c.resource_ref) out.resource_ref=c.resource_ref;
    if (out.original_title) { if (!out.title) out.title=out.original_title; delete out.original_title; }
    const evidence=list(c.evidence).map(e=>{
      const x=select(e,['field','snippet','source_ref']);
      if(e.structured_value)x.structured_value=select(e.structured_value,['categories','legacy_content_gap','source_ref_state','source_binding_version']);
      if(e.evidence_kind==='word_unverified')x.unverified=true;
      if(e.truncated===true)x.truncated=true;
      return x;
    });
    if(evidence.length)out.evidence=evidence;
    if(out.excerpt && evidence[0]?.snippet===out.excerpt)delete out.excerpt;
    if(c.truncated===true)out.truncated=true;
    if(c.judge && c.judge.evaluation_status!=='evaluated')out.judgement='unconfirmed';
    return out;
  });
}
function recall(v: Obj): Obj {
  const out: Obj={candidates:candidates(list(v.candidates))};
  // Existing argument contracts require session plus continuation reference/channel.
  Object.assign(out,select(v,['recall_session_id','continuation_note','missing']));
  if(v.judge_mode==='off')out.judgement='unjudged';
  else if(v.judgement_status && !['evaluated','complete'].includes(v.judgement_status))out.judgement=v.judgement_status;
  const coverage=obj(v.retrieval_coverage);
  if(coverage.truncated===true || coverage.retrieval_scope_exhaustive===false)out.coverage='incomplete';
  if(list(v.invalidated).length)out.invalidated=true;
  const p=obj(v.pagination);
  // R1′（2026-10-23）：块内恒带 has_more:true——旧冻结描述（读 pagination.has_more）与
  // 新描述（读块存在性）同一形状都成立；块不存在=本次固定结果集已尽（非全库穷尽）。
  if(p.has_more===true){out.pagination=select(p,['result_set_id','next_cursor']);out.pagination.has_more=true;if(!out.pagination.result_set_id&&v.result_set_id)out.pagination.result_set_id=v.result_set_id;}
  if(v.search_status && v.search_status!=='FOUND')out.status=v.search_status;
  return out;
}
/** Called after host validation and side-effect accounting, before trajectory serialization. */
export function modelResult(name: string, args: Obj, value: Obj): Obj {
  const v=obj(value);
  if(name==='conversation_read') {
    const out:Obj={entries:list(v.entries).map(x=>select(x,['seq','speaker','at','text','fragment']))};
    for(const k of ['next_cursor','older_cursor','newer_cursor'])if(v[k])out[k]=structuredClone(v[k]);
    return out;
  }
  if(name==='memory_recall'||name==='memory_recall_next')return recall(v);
  if(name==='episode_get'||name==='episode_apply')return episode(v);
  if(name==='episode_list'){
    const out:Obj={episodes:list(v.episodes).map(episode)};
    if(v.next_cursor)out.next_cursor=structuredClone(v.next_cursor);
    return out;
  }
  if(name==='plans_read')return Array.isArray(v.plans)?{plans:v.plans.map(plan)}:plan(v);
  if(name==='plans_write')return select(v,['plan_id','version','state']);
  if(name==='memory_i_write')return select(v,['item_id','revision']);
  if(name==='memory_i_read'){
    const history=['item_history','doc_history'].includes(args.what);
    if(Array.isArray(v.items) && v.items.length) {
      const out:Obj={items:v.items.map((x:Obj)=>identity(x))};
      if(v.item_id)out.item_id=v.item_id;
      return out;
    }
    if(Array.isArray(v.items) && !v.content)return {items:[]};
    if(Array.isArray(v.revisions))return {item_id:v.item_id,current_revision:v.current_revision,revisions:v.revisions.map((x:Obj)=>identity(x,true))};
    if(Array.isArray(v.versions))return {versions:v.versions.map((x:Obj)=>identity(x,true))};
    return identity(v,history);
  }
  if(name==='deletion_review'){
    const one=(x:Obj)=>select(x,['request_id','memory_id','human_reason','status','rejection_reason']);
    if(Array.isArray(v.requests))return {requests:v.requests.map(one)};
    return one(v);
  }
  if(name==='memory_open'){
    switch(args.action){
      case 'open': return select(v,['memory_id','date','date_unknown','title','text','categories','mood','view_receipt','content_gap']);
      case 'confirm': return {confirmed:true,...select(v,['memory_id','receipt_id'])};
      case 'recollections': return {recollections:list(v.recollections).map(recollection)};
      case 'keeps': return {marks:list(v.marks).map(keep)};
      case 'unkeep': return select(v,['mark_id','status','revoked']);
      default: {const out=select(v,['memory_id','recollection_id','supersedes']);if(v.keep)out.keep=keep(v.keep);return out;}
    }
  }
  if(name==='memory_correct'){
    if(args.action==='relations')return {relations:list(v.relations).map(relation)};
    // Explicit history is a distinct contract, including the human correction reason.
    if(args.action==='corrections')return {corrections:list(v.corrections).map(x=>{const r=select(x,['correction_id','domain','original_instance_id','endpoint_a','endpoint_b','replacement_instance_id','original_created_by','original_created_at','corrected_by','corrected_at','reason_code','note']);if(x.original_meta)r.original_meta=select(x.original_meta,['relation_type','custom_label','reverse_label','source_ref','conversation_id','start_message_id','end_message_id','start_char_offset','end_char_offset','bind_confidence']);return r;})};
    const out=select(v,['memory_id','word_id','word_ids','relation_id','from','to','relation_type','action','removed_relation_id','replacement_relation_id','source_ref','new_source_ref','removed_source_ref','source_binding_version','version','updated','saved']);
    if(Array.isArray(v.words))out.words=v.words.map(word);
    return out;
  }
  return value; // Other tools have independent contracts; never guess their business shape.
}

/** Failure is never rewritten as success. References with no model status tool stay internal. */
export function modelFailure(value: Obj): Obj {
  return select(value,['error_code','error','message','detail','saved','retryable','field','missing_fields',
    'result_set_id','memory_id','episode_id','word_id','recollection_id','mark_id','relation_id']);
}
