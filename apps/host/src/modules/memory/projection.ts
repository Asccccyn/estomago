// modules/memory/projection.ts（P04.2-4）：memory/plan/episode 域的模型投影（owner 拥有）。
// 从 runtime/model-results.ts 逐字搬迁：共享选择器与各分支；键序/白名单/逐字正文语义不变（D19/D34）。
// runtime/model-results.ts 退役后只保留通用 modelFailure（capabilities/executor 使用）。
// 包4 §6.2：宿主生成的说话人/作者标签按身份配置投影为双方真实姓名
// （宿主用户/char）；正文、引语与第三方署名逐字保留，labels 缺席=原值直通。
import { speakerLabelFor, type SpeakerLabels } from '../../identity/speaker-labels.ts';
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
function word(v: Obj, labels?: SpeakerLabels): Obj { const out = select(v,['word_id','speaker','text','source_ref','source_binding_version']); if(labels && typeof out.speaker === 'string') out.speaker = speakerLabelFor(out.speaker, labels); return out; }
function recollection(v: Obj, labels?: SpeakerLabels): Obj { const out = select(v,['recollection_id','author','text','supersedes']); if(labels && typeof out.author === 'string') out.author = speakerLabelFor(out.author, labels); return out; }
function keep(v: Obj, labels?: SpeakerLabels): Obj {
  const out = select(v,['mark_id','owner','recollection_id']);
  if(labels && typeof out.owner === 'string') out.owner = speakerLabelFor(out.owner, labels);
  if (v.revoked_at) out.revoked = true;
  return out;
}
function episode(v: Obj): Obj {
  const out=select(v,['episode_id','label','state','revision','current_revision','current_state','last_reason_code']);
  const ref=(x:Obj)=>select(x,['source_message_id','content_hash','char_offset']);
  if(Array.isArray(v.source_selections))out.source_selections=v.source_selections.map((x:Obj)=>({
    ...select(x,['conversation_id','start_char_offset','end_char_offset']),
    members:list(x.members).map(ref),
  }));
  if(v.terminal_source_ref)out.terminal_source_ref=ref(v.terminal_source_ref);
  if(list(v.decision_source_refs).length)out.decision_source_refs=v.decision_source_refs.map(ref);
  return out;
}

function plan(v: Obj, detail=false): Obj {
  const out = select(v,['plan_id','version','title','content','state','starts_at','due_at','date_start','date_end','timezone','all_day','weight','link_memory_ids']);
  if (detail && v.content !== undefined) out.content=v.content;
  if (Array.isArray(v.links)) out.links = v.links.map((x: Obj) => select(x, ['link_id','plan_id','memory_id','relation_type']));
  if (!out.plan_id && v.id) out.plan_id=v.id;
  if (out.version === undefined && v.current_version_no !== undefined) out.version=v.current_version_no;
  return out;
}
function identity(v: Obj, history=false): Obj {
  const out=select(v,['item_id','revision','current_revision','content','change_reason','informed_by_revision','restored_from_revision','is_current']);
  if (history) Object.assign(out,select(v,['authored_by','created_at','change_type','based_on_revision','version_no']));
  if (Array.isArray(v.relations)) out.relations=v.relations.map(relation);
  return out;
}
// 2026-11-26 裁定（修正 A2）：recall 候选正文先行，操作句柄跟在对应正文之后；
// 内部对账包装（evidence_kind/field/structured_value/重复编号）不再进入模型上下文。
// 正文只出现一次：卡片 text、首条文本类 evidence snippet、excerpt 三者取其一，
// 不再把同一段正文同时放进 excerpt 与 evidence。structured_fact 证据（分类/
// legacy 缺口等程序对账）整体不投递；原话与回忆摘要的区分保留为 kind + speaker
// + unverified/paraphrased 标记，不丢业务语义。
export function candidates(v: any[], labels?: SpeakerLabels): Obj[] {
  return v.map(raw=>{
    if(!raw || typeof raw!=='object' || Array.isArray(raw))return raw;
    const c=obj(raw), out: Obj={};
    const evidence=list(c.evidence).map(obj);
    const textual=evidence.filter(e=>typeof e.snippet==='string' && e.evidence_kind!=='structured_fact');
    let text=typeof c.text==='string' && c.text!=='' ? c.text : '';
    if(!text && textual.length) text=textual[0].snippet as string;
    if(!text && typeof c.excerpt==='string') text=c.excerpt;
    if(text) out.text=text;
    // 摘录窗口与正文不同文时是独立内容（P2 4-A 行为断言），跟在正文后保留；
    // 同文时不再重复出现（旧形状 excerpt+evidence 双载同一段正文的问题）。
    if(typeof c.excerpt==='string' && c.excerpt!==text) out.excerpt=c.excerpt;
    // 首条之外的文本类证据是配套原话（word_*），附在正文后；保留其覆盖标记。
    if(textual.length>1){
      out.quotes=textual.slice(1).map(e=>{
        const q:Obj={text:e.snippet};
        if(e.evidence_kind==='word_unverified')q.unverified=true;
        if(e.evidence_kind==='word_paraphrase')q.paraphrased=true;
        Object.assign(q,select(e,['unread_parts','already_in_window','included_in_this_request']));
        return q;
      });
    }
    // 正文自身的限定标记（原话未核实/转述）与文本载体来源。
    if(textual[0]?.evidence_kind==='word_unverified')out.unverified=true;
    if(textual[0]?.evidence_kind==='word_paraphrase')out.paraphrased=true;
    // 首条文本证据的覆盖标记提升到候选级（coverage 删正文后标记留在证据条上，
    // 与旧形状 evidence 白名单同语义，避免部分覆盖信息丢失）。
    Object.assign(out,select(textual[0] ?? {},['unread_parts','already_in_window','included_in_this_request']));
    if(c.channel)out.kind=c.channel;
    const ctx=select(c,['memory_date','speaker','title','original_title','mood','judgement']);
    if (ctx.original_title) { if (!ctx.title) ctx.title=ctx.original_title; delete ctx.original_title; }
    Object.assign(out,ctx);
    if(labels && typeof out.speaker === 'string') out.speaker = speakerLabelFor(out.speaker, labels);
    if(out.mood){out.mood=select(out.mood,['text','tags','author']);if(labels && typeof out.mood.author === 'string') out.mood.author = speakerLabelFor(out.mood.author, labels);}
    // SOL_R31：already_in_window 短回执标记随候选出站（正文已在本窗实际送达的
    // 普通主动结果；引用/身份/版本字段仍保留）。
    Object.assign(out,select(c,['unread_parts','already_in_window','included_in_this_request']));
    // 操作句柄区：memory_id/version/memory_ref 供 memory_read_full 深读与
    // memory_update CAS；resource_ref 是 M 候选卡出站的唯一否定续查句柄
    // （F-05，跨仓预审 2026-10-25：reject_candidate_ref 按工具声明原样回传）。
    Object.assign(out,select(c,['memory_id','word_id','plan_id']));
    if (c.channel === 'event' && typeof c.memory_id === 'string' && c.memory_id.length > 0
        && c.resource_ref === `memory:${c.memory_id}`
        && typeof c.content_version === 'string' && /^[1-9][0-9]*$/.test(c.content_version)) {
      const version = Number(c.content_version);
      if (Number.isSafeInteger(version)) out.version = version;
    }
    if(c.memory_ref)out.memory_ref=c.memory_ref;
    if(c.resource_ref)out.resource_ref=c.resource_ref;
    if(c.content_complete !== undefined)out.content_complete=c.content_complete;
    Object.assign(out,select(c,['start_char','end_char']));
    if(c.fragment)out.fragment=select(c.fragment,['start_char','end_char','total_chars','text','content_complete','unread_parts','already_in_window','included_in_this_request']);
    if(c.truncated===true || (Array.isArray(c.budget_flags) && c.budget_flags.length))out.truncated=true;
    if(c.judge && c.judge.evaluation_status!=='evaluated')out.judgement='unconfirmed';
    return out;
  });
}
// 2026-11-26 裁定：非 FOUND 状态按 M 侧真实分支语义给一句人话（AMBIGUOUS 的
// 服务端定义就是“交付了多条候选”，文案如实陈述多条相关，不虚构“无法确定”；
// 未收录的枚举值原样透出，不猜测含义）。
const RECALL_STATUS_NOTES: Record<string,string> = {
  AMBIGUOUS: '有多条记忆都相关，已一起返回',
  CONFLICT: '检索条件互相冲突，需要换一种问法',
  NO_MATCH_OBSERVED: '没有找到符合的记忆',
  DEGRADED: '检索部分降级，结果可能不全',
  BUDGET_EXHAUSTED: '检索预算用尽，结果可能不全',
  STALE_RETRY_REQUIRED: '这次检索会话已过期，需要重新发起',
  UNAVAILABLE: '检索通道暂不可用',
};
function recall(v: Obj, labels?: SpeakerLabels): Obj {
  const out: Obj={candidates:candidates(list(v.candidates),labels)};
  if(v.search_status && v.search_status!=='FOUND')out.note=RECALL_STATUS_NOTES[v.search_status] ?? v.search_status;
  if(list(v.missing).length)out.missing=v.missing;
  if(v.judge_mode==='off')out.judgement='unjudged';
  else if(v.judgement_status && !['evaluated','complete'].includes(v.judgement_status))out.judgement=v.judgement_status;
  const coverage=obj(v.retrieval_coverage);
  if(coverage.truncated===true || coverage.retrieval_scope_exhaustive===false)out.coverage='incomplete';
  if(list(v.invalidated).length)out.invalidated=true;
  if(v.budget_truncated===true)out.truncated=true;
  // 续查信息压到最后：会话锚点与可直接使用的 next 参数（P10：next 不自动执行）。
  if(v.recall_session_id)out.recall_session_id=v.recall_session_id;
  if(v.continuation_note)out.continuation_note=v.continuation_note;
  const p=obj(v.pagination);
  // R1′（2026-10-23）：块内恒带 has_more:true——旧冻结描述（读 pagination.has_more）与
  // 新描述（读块存在性）同一形状都成立；块不存在=本次固定结果集已尽（非全库穷尽）。
  if(p.has_more===true){out.pagination=select(p,['result_set_id','next_cursor']);out.pagination.has_more=true;if(!out.pagination.result_set_id&&v.result_set_id)out.pagination.result_set_id=v.result_set_id;}
  if(v.next)out.next=structuredClone(v.next);
  return out;
}

/** memory_read_full 深读投影：M detail 页保持自身独立合同（字段原样），
 * 仅把宿主生成的双方说话人/作者标签换成身份配置的真实姓名（包4 §6.2）。
 * source[].normalized_sender 是第三方/协议通道标签，不在映射域。 */
function readFull(v: Obj, labels?: SpeakerLabels): Obj {
  if (!labels) return v;
  const out: Obj = { ...v };
  const labelSpeaker = (row: Obj): Obj => typeof row.speaker === 'string' ? { ...row, speaker: speakerLabelFor(row.speaker, labels) } : row;
  const labelAuthor = (row: Obj): Obj => typeof row.author === 'string' ? { ...row, author: speakerLabelFor(row.author, labels) } : row;
  if (Array.isArray(out.our_words)) out.our_words = (out.our_words as Obj[]).map(labelSpeaker);
  if (Array.isArray(out.source)) out.source = (out.source as Obj[]).map(labelSpeaker);
  if (Array.isArray(out.mood)) out.mood = (out.mood as Obj[]).map(labelAuthor);
  else if (out.mood && typeof out.mood === 'object' && !Array.isArray(out.mood)) out.mood = labelAuthor(out.mood as Obj);
  if (Array.isArray(out.recollections)) out.recollections = (out.recollections as Obj[]).map(labelAuthor);
  if (Array.isArray(out.keeps)) out.keeps = (out.keeps as Obj[]).map((k: Obj) => {
    const next = { ...k };
    if (Array.isArray(next.marks)) next.marks = (next.marks as Obj[]).map((m: Obj) => typeof m.owner === 'string' ? { ...m, owner: speakerLabelFor(m.owner, labels) } : m);
    if (Array.isArray(next.by)) next.by = (next.by as unknown[]).map(o => speakerLabelFor(o, labels));
    return next;
  });
  return out;
}

/** memory/plan/episode 域工具投影（原 modelResult 逐字；conversation_read 分支已归 conversation 域）。
 *  Called after host validation and side-effect accounting, before trajectory serialization. */
export function projectMemoryToolResult(name: string, args: Obj, value: Obj, labels?: SpeakerLabels): Obj {
  const v=obj(value);
  if(name==='memory_recall'||name==='memory_recall_next')return recall(v,labels);
  if(name==='memory_read_full')return readFull(v,labels);
  if(name==='episode_get'||name==='episode_apply')return episode(v);
  if(name==='episode_list'){
    const out:Obj={episodes:list(v.episodes).map(episode)};
    if(v.next_cursor)out.next_cursor=structuredClone(v.next_cursor);
    return out;
  }
  if(name==='plans_read')return Array.isArray(v.plans)?{plans:v.plans.map((p:Obj)=>plan(p))}:plan(v,true);
  if(name==='plans_write')return select(v,['plan_id','version','state']);
  if(name==='memory_i_write')return select(v,['item_id','revision']);
  if(name==='memory_i_read'){
    if(args.what==='emotion')return select(v,['vocabulary','mood_tag_counts','mood_text_memories','retrieval_enabled']);
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
      case 'recollections': return {recollections:list(v.recollections).map((x:Obj)=>recollection(x,labels))};
      case 'keeps': return {marks:list(v.marks).map((x:Obj)=>keep(x,labels))};
      case 'unkeep': return select(v,['mark_id','status','revoked']);
      default: {const out=select(v,['memory_id','recollection_id','supersedes']);if(v.keep)out.keep=keep(v.keep);return out;}
    }
  }
  if(name==='memory_correct'){
    if(args.action==='trace')return select(v,['memory_id','earlier','later','visited','truncated','max_depth']);
    if(args.action==='plan_link')return {...select(v,['action','removed_link_id','correction_id']),replacement_link_id:v.replacement_link_id ?? null};
    if(args.action==='relations')return {relations:list(v.relations).map(relation)};
    // Explicit history is a distinct contract, including the human correction reason.
    if(args.action==='corrections')return {corrections:list(v.corrections).map(x=>{const r=select(x,['correction_id','domain','original_instance_id','endpoint_a','endpoint_b','replacement_instance_id','original_created_by','original_created_at','corrected_by','corrected_at','reason_code','note']);if(x.original_meta)r.original_meta=select(x.original_meta,['relation_type','custom_label','reverse_label','source_ref','conversation_id','start_message_id','end_message_id','start_char_offset','end_char_offset','bind_confidence']);return r;})};
    const out=select(v,['memory_id','word_id','word_ids','relation_id','from','to','relation_type','action','removed_relation_id','replacement_relation_id','source_ref','new_source_ref','removed_source_ref','source_binding_version','version','updated','saved']);
    if(Array.isArray(v.words))out.words=v.words.map((x:Obj)=>word(x,labels));
    return out;
  }
  return value; // Other tools have independent contracts; never guess their business shape.
}
