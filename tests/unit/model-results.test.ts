import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelResult,candidates} from '../../apps/host/src/runtime/model-results.ts';
import {projectSurfacedMemory} from '../../apps/host/src/memory-surfacing/contracts.ts';
test('episode read retains observed CAS revision and anchors, not audit fields',()=>{
 const before={episode_id:'ep',revision:3,state:'OPEN',label:'完整标签',scope_id:'room',created_at:'now',source_selections:[{members:[{source_message_id:'s',content_hash:'h'}]}]};
 const after=modelResult('episode_get',{},before);
 assert.equal(after.revision,3);assert.deepEqual(after.source_selections,before.source_selections);
 assert.equal(after.created_at,undefined);assert.equal(after.scope_id,undefined);assert.equal(before.created_at,'now');
});
test('pagination retains exact cursor, including required timestamp inside opaque cursor',()=>{
 const cursor={updated_before:'2026-10-21',episode_id_before:'e'};
 assert.deepEqual(modelResult('episode_list',{}, {episodes:[],count:0,has_more:true,next_cursor:cursor}),{episodes:[],next_cursor:cursor});
});
test('records remain addressable for revision and revoke; punctuation is content',()=>{
 assert.deepEqual(modelResult('memory_open',{action:'recollections'},{recollections:[{recollection_id:'r',author:'jiaming',text:'！！ ',written_at:'now'}]}),{recollections:[{recollection_id:'r',author:'jiaming',text:'！！ '}]});
 assert.deepEqual(modelResult('memory_open',{action:'keeps'},{marks:[{mark_id:'k',owner:'jiaming',revoked_at:'then'}]}),{marks:[{mark_id:'k',owner:'jiaming',revoked:true}]});
});
test('recall preserves distinct evidence, zero results and uncertainty without diagnostics',()=>{
 const source={memory_id:'m',scores:{x:1},rrf_score:1,excerpt:'甲',evidence:[{snippet:'乙',field:'event_text',source_version:'9'}],judge:{evaluation_status:'partial',model_id:'secret'}};
 const result=candidates([source])[0];assert.equal(result.excerpt,'甲');assert.equal(result.evidence[0].snippet,'乙');assert.equal(result.judgement,'unconfirmed');assert.equal(result.scores,undefined);
 assert.deepEqual(modelResult('memory_recall',{}, {candidates:[],search_status:'NOT_FOUND',judge_mode:'off',retrieval_coverage:{truncated:true}}),{candidates:[],judgement:'unjudged',coverage:'incomplete',status:'NOT_FOUND'});
});
test('actual event date survives unknown confidence, event body unchanged',()=>{
 const item:any={memory_date:'2026-07-09',date_confidence:'unknown',event_text:'完整正文\n！！'};
 assert.deepEqual(projectSurfacedMemory(item),{date:'2026-07-09',text:item.event_text});
});
