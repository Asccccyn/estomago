// Generated domain rules come from M's existing export; host source selections stay here.
import contract from '../../integrations/mariposa/contracts/capabilities.v1.json' with {type:'json'};
const capabilities = new Map(contract.capabilities.map(cap => [cap.canonical_name, cap.input_schema]));
export const HOLD_INPUT = capabilities.get('memory.hold') as Record<string, any>;
export const MEMORY_UPDATE_INPUT = capabilities.get('memory.update') as Record<string, any>;
export const RECALL_PLAN = (capabilities.get('memory.recall.start') as Record<string, any>).properties.query_plan;
export const ROUND2_INPUT = capabilities.get('memory.recall.round2') as Record<string, any>;
export const RELATION_INPUT = capabilities.get('memory.relations.link') as Record<string, any>;
export const I_ITEM_INPUT = capabilities.get('i.item.create') as Record<string, any>;
export const TRACE_INPUT = capabilities.get('memory.relations.trace') as Record<string, any>;
export const HOLD_MOOD_RULE: string = HOLD_INPUT.properties.mood.description.replace(/\btags\b/g,'mood_tags').replace(/\btext\b/g,'mood_note');
/** 包4无seq整改（2026-11-18）：原话勾选从消息序号改为逐字引语锚点——引语须与本次请求
 *  实际装载视野（seenMessages 可见码点区间）逐字一致并由宿主解析说话人，不让模型重写原话、
 *  不再教模型提交 [N] 序号。旧 {seq,from,to} 形状仅旧冻结窗可用（其冻结 schema 仍锁旧形）。 */
export const QUOTE_SELECTION = {type:'object',additionalProperties:false,required:['quote'],properties:{
  quote:{type:'string',minLength:1,maxLength:300,description:'逐字原话引语（1-300 字，与已见原文完全一致；引语本身即所选句段内容）'},
  speaker:{type:'string',enum:['宿主用户','char'],description:'可选：说话人（引语在双方消息中都出现时用于消歧；省略=按唯一匹配解析）'},
},};
