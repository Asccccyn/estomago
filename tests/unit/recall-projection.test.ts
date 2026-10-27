// P2 模型出口层一阶段（她 2026-10-20 批 4-A）+ F-05（跨仓预审 2026-10-25）：
// recall 卡最小投影——检索诊断字段内部化、matched_by+matched_fields 合并、保留面不丢。
// R-04（复审 2026-10-26）：resource_ref 是 M 候选卡出站的唯一操作句柄（否定续查
// reject_candidate_ref 按工具声明原样回传），从"删除"清单移入"保留"清单。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectCandidatesForModel } from '../../apps/host/src/modules/memory/projection.ts';

const FULL = {
  resource_ref: 'memory:00051@3', channel: 'event', content_version: '3',
  memory_id: '00051', word_id: 'w1', ordinal: 2, speaker: 'jiaming',
  source_ref: 'sib_x', source_binding_version: '5', memory_date: '2026-07-09',
  matched_by: 'lexical', matched_fields: ['event_text', 'title'],
  excerpt: '原文摘录', truncated: false,
  evidence: [{ kind: 'authored_event' }], version_receipt: 'vr_1',
  evidence_requirement_met: true, judge: 'on',
};

test('candidate whitelist preserves content and operation references, omits retrieval diagnostics',()=>{
 const [c]=projectCandidatesForModel([FULL]) as any[];
 for(const k of ['content_version','version_receipt','evidence_requirement_met','matched_by','matched_fields','matched','rrf_score']) assert.equal(k in c,false);
 for(const k of ['memory_id','word_id','speaker','memory_date','excerpt','source_ref','source_binding_version','resource_ref']) assert.deepEqual(c[k],(FULL as any)[k]);
});
test('new unexpected technical fields cannot leak through candidates',()=>{
 const [c]=projectCandidatesForModel([{memory_id:'m',text:'完整正文',new_debug_hash:'hidden',scores:{x:1}}]) as any[];
 assert.deepEqual(c,{memory_id:'m',text:'完整正文'});
});
test('invalid scalar entries are not silently rewritten as valid empty records',()=>{
 assert.deepEqual(projectCandidatesForModel(['x',null,3]),['x',null,3]);
});
test('F-05: cards without ids keep operable resource_ref (all M channels)',()=>{
 // words/round2 卡（our_word:/source_msg:）只有 resource_ref 身份时同样保留
 const [w]=projectCandidatesForModel([{resource_ref:'our_word:w9',word_id:'w9',excerpt:'我们的话'}]) as any[];
 assert.equal(w.resource_ref,'our_word:w9');
 const [r]=projectCandidatesForModel([{resource_ref:'source_msg:sm1',excerpt:'原文'}]) as any[];
 assert.equal(r.resource_ref,'source_msg:sm1');
});
