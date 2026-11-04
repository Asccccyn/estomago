// Generated domain rules come from M's existing export; host source selections stay here.
import contract from '../../integrations/mariposa/contracts/capabilities.v1.json' with {type:'json'};
const capabilities = new Map(contract.capabilities.map(cap => [cap.canonical_name, cap.input_schema]));
export const HOLD_INPUT = capabilities.get('memory.hold') as Record<string, any>;
export const RECALL_PLAN = (capabilities.get('memory.recall.start') as Record<string, any>).properties.query_plan;
export const ROUND2_INPUT = capabilities.get('memory.recall.round2') as Record<string, any>;
export const RELATION_INPUT = capabilities.get('memory.relations.link') as Record<string, any>;
export const I_ITEM_INPUT = capabilities.get('i.item.create') as Record<string, any>;
export const TRACE_INPUT = capabilities.get('memory.relations.trace') as Record<string, any>;
export const HOLD_MOOD_RULE: string = HOLD_INPUT.properties.mood.description.replace(/\btags\b/g,'mood_tags').replace(/\btext\b/g,'mood_note');
export const QUOTE_SELECTION = {type:'object',additionalProperties:false,required:['seq'],properties:{
  seq:{type:'integer',minimum:1,description:'已读消息的 [N] 序号'},
  from:{type:'integer',minimum:1,description:'起始句，1 起算'},
  to:{type:'integer',minimum:1,description:'结束句（含）；与 from 成对'},
},dependencies:{from:['to'],to:['from']}};
