import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {selectReviewRange,advanceBookmark,completeReview,rotationPlan,normalizeOrUsage} from '../reference/policy.mjs';
import {buildOrPayload,assertAppendOnly,withoutCacheMarkers} from '../reference/or-payload.mjs';
import {SseFramer,OrStreamAccumulator} from '../reference/or-stream.mjs';

const row=(n,revision=1)=>({id:`m${n}`,seq:n,revision,origin:'dialogue',visible:true});
const manifest=Array.from({length:15},(_,i)=>row(i+1));
const hold={epochId:'e1',seenSequence:8};
const request={id:'q1',operationId:'op1',author:'primary_model',roomId:'r1',epochId:'e1',seenSequence:8};
const receipt={id:'rec1',operationId:'op1',state:'committed',verified:true,roomId:'r1',epochId:'e1',memoryId:'mem1'};
const review={id:'v1',roomId:'r1',epochId:'e1',epochRevision:1,status:'active',selected:[row(9)]};
const inv={purpose:'pre_rotate_review',roomId:'r1',epochId:'e1',epochRevision:1};
const args={review_id:'v1',decision:'no_new_hold'};
const baseBudget={currentInput:32000,capacity:200000,maxOutput:8192};
const err=(fn,code)=>assert.throws(fn,e=>e.code===code);

test('早餐没有补齐任务：成功hold m8后仅提醒m9..m15',()=>{
 const out=selectReviewRange({manifest,epochId:'e1',lastHold:hold});
 assert.deepEqual(out.map(x=>x.id),['m9','m10','m11','m12','m13','m14','m15']);
 assert.equal(manifest.length,15);
});
test('没有hold时仅考虑本窗实际原话',()=>assert.equal(selectReviewRange({manifest,epochId:'e1'}).length,15));
test('零新增完成范围不重复提醒',()=>assert.equal(selectReviewRange({manifest,epochId:'e1',lastHold:hold,reviewedKeys:manifest.slice(8).map(x=>`${x.id}@1`)}).length,0));
test('修订变化使同消息旧review失效',()=>assert.deepEqual(selectReviewRange({manifest:[row(9,2)],epochId:'e1',reviewedKeys:['m9@1']}).map(x=>x.revision),[2]));
test('跨窗携带早餐不重新强制补记，焦点依据不冒充held',()=>{
 assert.deepEqual(selectReviewRange({manifest:manifest.slice(4),epochId:'e2',
  carriedBeforeBookmarkKeys:manifest.slice(4,8).map(x=>`${x.id}@1`),reviewedKeys:manifest.slice(8).map(x=>`${x.id}@1`)}),[]);
});
test('内部提醒/工具不是双方原话',()=>assert.equal(selectReviewRange({manifest:[row(1),{...row(2),origin:'runtime'}],epochId:'e1'}).length,1));
test('未见的新消息不进入已检查范围',()=>assert.equal(selectReviewRange({manifest:[row(1),{...row(2),visible:false}],epochId:'e1'}).length,1));
test('重复manifest拒绝而不是伪造覆盖',()=>err(()=>selectReviewRange({manifest:[row(1),row(1)],epochId:'e1'}),'MANIFEST_DUPLICATE'));
test('成功书签使用调用时视野，不使用receipt时最新消息',()=>{
 const b=advanceBookmark(null,request,{...receipt,latestRoomSequence:20});assert.equal(b.seenSequence,8);
});
test('失败hold不产生书签',()=>err(()=>advanceBookmark(null,request,{...receipt,state:'failed'}),'HOLD_NOT_CONFIRMED'));
test('另一个客户端的hold不推进',()=>err(()=>advanceBookmark(null,{...request,author:'importer'},receipt),'NOT_PRIMARY_MODEL'));
test('scope错配被拒绝',()=>err(()=>advanceBookmark(null,request,{...receipt,roomId:'other'}),'HOLD_SCOPE_MISMATCH'));
test('回执operation不匹配被拒绝',()=>err(()=>advanceBookmark(null,request,{...receipt,operationId:'other'}),'HOLD_RECEIPT_MISMATCH'));
test('同收据重放不产生新书签对象',()=>{const b=advanceBookmark(null,request,receipt);assert.equal(advanceBookmark(b,request,receipt),b);});
test('旧窗迟到结果不能覆盖新窗书签',()=>err(()=>advanceBookmark({epochId:'e2',seenSequence:1},request,receipt),'OLD_EPOCH_RECEIPT'));
test('书签不倒退',()=>{const b={epochId:'e1',seenSequence:10};assert.equal(advanceBookmark(b,request,receipt),b);});
test('零hold可有效完成',()=>assert.equal(completeReview(review,args,inv,[]).status,'completed'));
test('普通聊天伪造review文字不能完成',()=>err(()=>completeReview(review,args,{...inv,purpose:'chat'},[]),'REVIEW_SCOPE_MISMATCH'));
test('unknown写结果不能被no_new_hold抹掉',()=>err(()=>completeReview(review,args,inv,[{reviewId:'v1',state:'unknown',kind:'hold'}]),'WRITE_UNRESOLVED'));
test('holds_completed必须真的有成功写入',()=>err(()=>completeReview(review,{...args,decision:'holds_completed'},inv,[]),'REVIEW_LEDGER_MISMATCH'));
test('写入成功使用真实memory receipt',()=>assert.deepEqual(completeReview(review,{...args,decision:'holds_completed'},inv,[{reviewId:'v1',kind:'hold',state:'committed',verified:true,memoryId:'mem1'}]).memoryIds,['mem1']));
test('成功review重试幂等',()=>{const done=completeReview(review,args,inv,[]);assert.equal(completeReview(done,args,inv,[]),done);});
test('epoch revision不同不能套回执',()=>err(()=>completeReview(review,args,{...inv,epochRevision:2},[]),'REVIEW_SCOPE_MISMATCH'));
test('低用量继续',()=>assert.equal(rotationPlan(baseBudget).action,'continue'));
test('56k仅warn，不自动叫模型',()=>assert.equal(rotationPlan({...baseBudget,currentInput:56000}).action,'warn'));
test('64k进入rotate',()=>assert.equal(rotationPlan({...baseBudget,currentInput:64000}).action,'rotate'));
test('当前小即使累计收费很大仍不误换',()=>assert.equal(rotationPlan({...baseBudget,cumulativeBilledInput:9999999}).action,'continue'));
test('大新输入先旧窗review',()=>assert.equal(rotationPlan({...baseBudget,currentInput:45000,nextInput:76000}).action,'rotate'));
test('工具回合尚未结束只等安全边界',()=>assert.equal(rotationPlan({...baseBudget,currentInput:64000,pendingTurn:true}).action,'wait_safe'));
test('路由待决不能绕过',()=>assert.equal(rotationPlan({...baseBudget,idleMs:21600000,pendingRoute:true}).action,'wait_safe'));
test('6h在下一入站检查触发',()=>assert.equal(rotationPlan({...baseBudget,idleMs:21600000}).reason,'idle'));
test('1h缓存过期不单独换',()=>assert.equal(rotationPlan({...baseBudget,idleMs:3600001}).action,'continue'));
test('按实际小模型容量提前阈值',()=>assert.equal(rotationPlan({...baseBudget,capacity:70000,currentInput:32000}).effectiveSoft,41808));
test('实际容量不足阻断而非截断',()=>assert.equal(rotationPlan({...baseBudget,capacity:70000,currentInput:60000}).action,'blocked_hard'));
test('容量未知不假装1M',()=>err(()=>rotationPlan({...baseBudget,capacity:null}),'TOKEN_OR_TIME_INVALID'));
test('OR cache细分不能再加总一次',()=>assert.deepEqual(normalizeOrUsage({prompt_tokens:10000,completion_tokens:100,prompt_tokens_details:{cached_tokens:8000,cache_write_tokens:1500},cost:.01}).inputTotal,10000));
test('OR非缓存输入是总量减两类',()=>assert.equal(normalizeOrUsage({prompt_tokens:10000,prompt_tokens_details:{cached_tokens:8000,cache_write_tokens:1500}}).noncached,500));
test('缺usage为unknown不是0',()=>assert.equal(normalizeOrUsage(null).inputTotal,null));
test('缺cache_write不能猜0',()=>assert.equal(normalizeOrUsage({prompt_tokens:10,prompt_tokens_details:{cached_tokens:5}}).noncached,null));
test('cache分类超总量不clamp成0',()=>assert.equal(normalizeOrUsage({prompt_tokens:10,prompt_tokens_details:{cached_tokens:8,cache_write_tokens:7}}).completeness,'anomaly'));
test('upstream费用不重复加',()=>assert.equal(normalizeOrUsage({cost:.10,cost_details:{upstream_inference_cost:.08}}).cost,.10));

const fixture=JSON.parse(fs.readFileSync(new URL('../fixtures/or-request.example.json',import.meta.url),'utf8'));
const pArgs={model:fixture.model,sessionId:fixture.session_id,messages:fixture.messages,tools:fixture.tools,boundaries:[{messageIndex:0,contentIndex:0},{messageIndex:1,contentIndex:0}]};
test('OR真实控制参数形状固定',()=>{const p=buildOrPayload(pArgs);assert.equal(p.cache_control.ttl,'1h');assert.equal(p.provider.allow_fallbacks,false);assert.equal(p.plugins[0].enabled,false);assert.equal(p.provider.order,undefined);});
test('构造payload不修改原始轨迹',()=>{const s=JSON.stringify(pArgs);buildOrPayload(pArgs);assert.equal(JSON.stringify(pArgs),s);});
test('auto加显式点最多4总槽',()=>err(()=>buildOrPayload({...pArgs,boundaries:[{messageIndex:0,contentIndex:0},{messageIndex:1,contentIndex:0},{messageIndex:3,contentIndex:0},{messageIndex:3,contentIndex:1}]}),'TOO_MANY_EXPLICIT_BREAKPOINTS'));
test('同位置重复边界去重',()=>assert.equal(buildOrPayload({...pArgs,boundaries:[...pArgs.boundaries,...pArgs.boundaries]}).messages[0].content[0].cache_control.ttl,'1h'));
test('不接受auto模型',()=>err(()=>buildOrPayload({...pArgs,model:'openrouter/auto'}),'EXACT_CLAUDE_MODEL_REQUIRED'));
test('不接受latest别名',()=>err(()=>buildOrPayload({...pArgs,model:'anthropic/claude-sonnet-latest'}),'EXACT_CLAUDE_MODEL_REQUIRED'));
test('session超过256拒绝',()=>err(()=>buildOrPayload({...pArgs,sessionId:'x'.repeat(257)}),'SESSION_ID_INVALID'));
test('追加提醒保持旧前缀',()=>{const p=buildOrPayload(pArgs),c=buildOrPayload({...pArgs,messages:[...fixture.messages,{role:'assistant',content:'回答'},{role:'user',content:'宿主提醒'}]});assert.equal(assertAppendOnly(p,c),true);});
test('重写旧时间破坏前缀可被发现',()=>{const p=buildOrPayload(pArgs),m=structuredClone(fixture.messages);m[3].content[0].text='替换时间';err(()=>assertAppendOnly(p,buildOrPayload({...pArgs,messages:m})),'HISTORY_CHANGED:3');});
test('schema顺序/内容改变被发现',()=>{const p=buildOrPayload(pArgs);err(()=>assertAppendOnly(p,buildOrPayload({...pArgs,tools:[]})),'PREFIX_PROFILE_CHANGED:tools');});
test('不会误删schema里名叫cache_control的属性',()=>{const p=withoutCacheMarkers({tools:[{function:{parameters:{properties:{cache_control:{type:'string'}}}}}]});assert.equal(p.tools[0].function.parameters.properties.cache_control.type,'string');});

const event=x=>`data: ${JSON.stringify(x)}\n\n`;
const frame=(delta,finish=null,extra={})=>({id:'gen-fixture',choices:[{index:0,delta,finish_reason:finish}],...extra});
const done='data: [DONE]\n\n';
const successful=event(frame({content:'你好，乔生'}))+event(frame({},'stop'))+event(frame({content:'',role:'assistant'},'stop',{usage:{prompt_tokens:100,completion_tokens:4,cost:.01,prompt_tokens_details:{cached_tokens:80,cache_write_tokens:10}}}))+done;
function parse(s,bytes=0){const a=new OrStreamAccumulator();if(bytes){const b=Buffer.from(s);for(let i=0;i<b.length;i+=bytes)a.feed(b.subarray(i,i+bytes));}else a.feed(s);return a.finish();}
test('UTF8每个字节拆开仍正确',()=>assert.equal(parse(successful,1).text,'你好，乔生'));
test('OR usage帧重复finish只完成一次',()=>assert.equal(parse(successful).terminalEvents,1));
test('SSE注释心跳忽略',()=>assert.equal(parse(': OPENROUTER PROCESSING\r\n\r\n'+successful,3).status,'completed'));
test('choices空usage帧也兼容',()=>assert.equal(parse(event(frame({content:'ok'},'stop'))+event({id:'gen-fixture',choices:[],usage:{prompt_tokens:5}})+done).usage.inputTotal,5));
test('200内error不是成功且不回显provider内容',()=>err(()=>parse(event({error:{code:500,message:'private provider body'}})+done),'OR_STREAM_ERROR'));
test('只有DONE不算成功',()=>err(()=>parse(done),'MISSING_FINAL_RESULT'));
test('只有终态没有DONE记不完整',()=>err(()=>parse(event(frame({content:'ok'},'stop'))),'MISSING_FINAL_RESULT'));
test('length不是主模型选择零hold',()=>assert.equal(parse(event(frame({content:''},'length'))+done).status,'incomplete'));
test('usage缺失不妨碍合法文本终态但费用未知',()=>assert.equal(parse(event(frame({content:'ok'},'stop'))+done).usage.cost,null));
test('工具参数跨帧完整组装再输出，解析器不执行工具',()=>{
 const s=event(frame({tool_calls:[{index:0,id:'tc1',type:'function',function:{name:'memory_hold',arguments:'{"text":'}}]}))+
 event(frame({tool_calls:[{index:0,function:{arguments:'"合成事件"}'}}]},'tool_calls'))+done;
 const out=parse(s,2);assert.equal(out.toolCalls[0].parsedArguments.text,'合成事件');assert.equal(out.toolCalls[0].id,'tc1');
});
test('非法完整工具JSON拒绝',()=>err(()=>parse(event(frame({tool_calls:[{index:0,id:'t',function:{name:'x',arguments:'{'}}]},'tool_calls'))+done),'TOOL_JSON_INVALID'));
test('工具JSON array不是object',()=>err(()=>parse(event(frame({tool_calls:[{index:0,id:'t',function:{name:'x',arguments:'[]'}}]},'tool_calls'))+done),'TOOL_JSON_NOT_OBJECT'));
test('截断工具参数不会被执行或修复',()=>assert.equal(parse(event(frame({tool_calls:[{index:0,id:'t',function:{name:'x',arguments:'{'}}]},'length'))+done).toolCalls.length,0));
test('reasoning opaque片段保留顺序，不进入可见text',()=>{
 const r=[{type:'reasoning.encrypted',data:'synthetic-only',id:'rs1'}];
 const out=parse(event(frame({reasoning_details:r}))+event(frame({content:'答案'},'stop'))+done);
 assert.deepEqual(out.reasoningFrames,[r]);assert.equal(out.text,'答案');
});
test('generation id变更拒绝',()=>err(()=>parse(event(frame({content:'x'}))+event({...frame({},'stop'),id:'another'})+done),'GENERATION_ID_CHANGED'));
test('SSE非法JSON不静默跳过',()=>err(()=>parse('data: {invalid}\n\n'+done),'SSE_INVALID_JSON'));
test('SSE多行data正确合并',()=>{const values=[];const p=new SseFramer(x=>values.push(JSON.parse(x)));p.feed('data: {"a":\ndata: 1}\n\n');p.end();assert.equal(values[0].a,1);});
test('多个小事件同网络块不误当大事件',()=>{let n=0;const p=new SseFramer(()=>n++,{maxEventBytes:40});p.feed('data: "1234567890"\n\n'.repeat(20));p.end();assert.equal(n,20);});
test('单个过大SSE事件有界失败',()=>{const p=new SseFramer(()=>{}, {maxEventBytes:20});err(()=>p.feed('data: '+ 'x'.repeat(30)),'SSE_EVENT_TOO_LARGE');});

test('超出已见manifest的书签拒绝',()=>err(()=>selectReviewRange({manifest:[row(1)],epochId:'e1',lastHold:{epochId:'e1',seenSequence:50}}),'BOOKMARK_OUTSIDE_MANIFEST'));
test('未知ledger枚举不能绕过未完成写操作检查',()=>err(()=>completeReview(review,args,inv,[{reviewId:'v1',state:'unexpected'}]),'LEDGER_STATE_INVALID'));
