import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapCall, completeBootstrapPages, BootstrapPagingError } from '../../apps/host/src/integrations/mariposa/bootstrap-pages.ts';
import { MariposaClient, type MariposaCallResult, type MariposaTransport } from '../../apps/host/src/integrations/mariposa/client.ts';
import { TurnSupervisor } from '../../apps/host/src/runtime/supervisor.ts';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1', 'Use the isolated npm test runner');
const metadata = { snapshot_id: 'snap_synthetic', profile: 'estomago', content_role: 'bootstrap_memory_package', instruction_authority: 'none' };
const moodCursor = (offset: number, memoryId = 'mem_synthetic') => ({ memory_id: memoryId, field: 'mood_text', offset });
const moodPacket = () => ({ ...metadata, memory_days: { items: [{ memory_id: 'mem_synthetic', original_title:'合成桶', mood_text: '甲😀', mood_text_truncated: true, mood_text_total_chars: 4, mood_text_next: moodCursor(2) }] }, i:{content:'PRIVATE_I_KEEP'}, plans:{items:[{title:'PRIVATE_PLAN_KEEP'}]} });
const moodPage = (overrides = {}) => ({ ...metadata, section: 'memory_item', memory_id: 'mem_synthetic', field: 'mood_text', content: '乙\n', offset: 2, total_chars: 4, next_cursor: null, ...overrides });
const success = (result: Record<string, unknown>): MariposaCallResult => ({ ok: true, result });
const failure = (code: string, httpStatus: number): MariposaCallResult => ({ok:false,code,httpStatus});
const validSnapshot = (snapshotId = metadata.snapshot_id) => success({unchanged:true,snapshot_id:snapshotId,profile:'estomago'});
const clientFor = (getPage: (payload: Record<string, unknown>, signal?: AbortSignal) => MariposaCallResult | Promise<MariposaCallResult>) => new MariposaClient({ transport: async (capability, payload, signal) => {
  assert.equal(capability, 'bootstrap.next'); return getPage(payload, signal);
} });
const rejectsCode = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof BootstrapPagingError && error.code === code);
const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));
const itemsOf = (data: Record<string, unknown>) => (data.memory_days as {items:Record<string,unknown>[]}).items;
function noMood(item: Record<string, unknown>) {
  for(const key of ['mood_text','mood_text_next','mood_text_truncated','mood_text_total_chars']) assert.equal(Object.hasOwn(item,key),false,`Remove incomplete ${key}`);
}

const callBootstrap = (TurnSupervisor.prototype as unknown as { windowBootstrap: (id: string, signal?: AbortSignal) => Promise<string | null> }).windowBootstrap;
function hostFor(transport: MariposaTransport) {
  const warnings: unknown[] = [], observed: Record<string,unknown>[] = [], resolved: unknown[][] = [];
  const client = new MariposaClient({ transport });
  const alerts = { observe: (input:Record<string,unknown>) => { observed.push(input); return 'synthetic_alert'; }, resolve: (...args:unknown[]) => { resolved.push(args); return true; } };
  return {host:{d:{tools:{mariposaClient:()=>client},events:{publish:(_kind:string,event:unknown)=>warnings.push(event)},alerts},bootstrapByWindow:new Map<string,string>()},warnings,observed,resolved};
}
function unavailable(text: string | null) {
  assert.equal(typeof text,'string');
  assert.match(text!,/Mariposa.*开窗资料未取得/);
  assert.match(text!,/不表示记忆不存在/);
  for(const privateText of ['PRIVATE_I_KEEP','PRIVATE_PLAN_KEEP','甲😀']) assert.equal(text!.includes(privateText),false);
}
function privateDiagnostics(warnings: unknown[], observed: unknown[]) {
  const diagnostics=JSON.stringify({warnings,observed});
  for(const privateText of ['PRIVATE_I_KEEP','PRIVATE_PLAN_KEEP','甲😀','PRIVATE_UPSTREAM_ERROR']) assert.equal(diagnostics.includes(privateText),false);
}

test('long mood completes with exact Unicode offsets and unchanged current sections', async () => {
  const full='甲😀\n\t乙🦋再见', chars=Array.from(full), parent=new AbortController();
  const packet={...moodPacket(),memory_days:{items:[{...moodPacket().memory_days.items[0],mood_text:chars.slice(0,2).join(''),mood_text_total_chars:chars.length,event_text:'事件保留',our_words:[{speaker:'jiaming',texts:['原话保留']}]}]}};
  const before=JSON.stringify(packet), offsets:number[]=[];
  const out=await completeBootstrapPages(clientFor((args,signal)=>{
    assert.ok(signal); assert.notEqual(signal,parent.signal); assert.equal(signal.aborted,false);
    assert.equal(args.snapshot_id,metadata.snapshot_id); assert.equal(args.section,'memory_item');
    const offset=(args.cursor as {offset:number}).offset; offsets.push(offset);
    const end=Math.min(offset+2,chars.length);
    return success(moodPage({content:chars.slice(offset,end).join(''),offset,total_chars:chars.length,next_cursor:end<chars.length?moodCursor(end):null}));
  }),packet,{signal:parent.signal});
  const item=itemsOf(out.data)[0]!;
  assert.equal(item.mood_text,full); assert.equal(item.mood_text_next,null); assert.equal(item.mood_text_truncated,false);
  assert.deepEqual(out.gaps,[]); assert.deepEqual(offsets,[2,4,6]);
  assert.equal(out.data.i,packet.i); assert.equal(out.data.plans,packet.plans);
  assert.deepEqual(item.our_words,packet.memory_days.items[0].our_words);
  assert.equal(JSON.stringify(packet),before);
});

test('legacy absent sections and empty/null moods require no continuation and no gaps',async()=>{
  const client=clientFor(()=>{throw new Error('Unexpected page');});
  for(const packet of [{},{memory_days:null},{memory_days:{}},{memory_days:{items:[{mood_text:null},{},{mood_text:''},{mood_text:'短心情😀'}]}}]) {
    const before=JSON.stringify(packet); const out=await completeBootstrapPages(client,packet);
    assert.deepEqual(out.gaps,[]); assert.equal(JSON.stringify(packet),before);
  }
});

test('malformed section structure remains global, while malformed mood values are local',async t=>{
  for(const memory_days of ['bad section',[],{items:{}},{items:1},{items:null},{items:[null]}]) await t.test(JSON.stringify(memory_days),async()=>{
    await rejectsCode(completeBootstrapPages(clientFor(()=>{throw new Error('No page expected');}),{...metadata,memory_days}),'BOOTSTRAP_SHAPE_INVALID');
  });
  for(const field of [...[{},42,false,[]].map(mood_text=>({mood_text})),...['true',1,{},null].map(mood_text_truncated=>({mood_text:'PRIVATE_UPSTREAM_ERROR',mood_text_truncated}))]) await t.test(JSON.stringify(field),async()=>{
    const packet={...moodPacket(),memory_days:{items:[{memory_id:'bad',...field},{memory_id:'healthy',mood_text:'其他心情保留'}]}};
    const before=JSON.stringify(packet);
    const out=await completeBootstrapPages(clientFor(()=>{throw new Error('No page expected');}),packet);
    assert.deepEqual(out.gaps,[{section:'mood_text',memoryId:'bad',code:'BOOTSTRAP_SHAPE_INVALID',retryable:false}]);
    noMood(itemsOf(out.data)[0]!); assert.equal(itemsOf(out.data)[1]!.mood_text,'其他心情保留');
    assert.equal(out.data.i,packet.i); assert.equal(out.data.plans,packet.plans); assert.equal(JSON.stringify(packet),before);
  });
});

test('resource identity, snapshot and authority failures are global',async t=>{
  const cases:[string,Record<string,unknown>][]=[
    ['BOOTSTRAP_SNAPSHOT_MISMATCH',{snapshot_id:'snap_other'}],
    ['BOOTSTRAP_RESOURCE_MISMATCH',{section:'i'}],
    ['BOOTSTRAP_RESOURCE_MISMATCH',{memory_id:'other'}],
    ['BOOTSTRAP_RESOURCE_MISMATCH',{field:'event_text'}],
    ['BOOTSTRAP_AUTHORITY_INVALID',{instruction_authority:'system'}],
  ];
  for(const [code,changes] of cases) await t.test(code+JSON.stringify(Object.keys(changes)),()=>rejectsCode(completeBootstrapPages(clientFor(()=>success(moodPage(changes))),moodPacket()),code));
  const missing={...moodPacket()} as Record<string,unknown>; delete missing.snapshot_id;
  await rejectsCode(completeBootstrapPages(clientFor(()=>{throw new Error('No page expected');}),missing),'BOOTSTRAP_SNAPSHOT_MISSING');
  await rejectsCode(completeBootstrapPages(clientFor(()=>failure('SNAPSHOT_STALE',409)),moodPacket()),'SNAPSHOT_STALE');
});

test('malformed/non-progressing mood pages discard only that entire mood, including its first fragment',async t=>{
  const cases:[string,Record<string,unknown>][]=[
    ['BOOTSTRAP_OFFSET_MISMATCH',{offset:3}],['BOOTSTRAP_TOTAL_MISMATCH',{total_chars:5}],
    ['BOOTSTRAP_NO_PROGRESS',{content:''}],['BOOTSTRAP_NO_PROGRESS',{content:{text:'bad'}}],
    ['BOOTSTRAP_INCOMPLETE',{content:'乙',next_cursor:null}],
    ['BOOTSTRAP_CURSOR_REPEATED',{next_cursor:moodCursor(2)}],
    ['BOOTSTRAP_OFFSET_MISMATCH',{next_cursor:moodCursor(5)}],
  ];
  for(const [code,changes] of cases) await t.test(code+JSON.stringify(Object.keys(changes)),async()=>{
    const packet=moodPacket(), before=JSON.stringify(packet);
    const out=await completeBootstrapPages(clientFor(()=>success(moodPage(changes))),packet);
    assert.equal(out.gaps[0]?.code,code); noMood(itemsOf(out.data)[0]!);
    assert.equal(out.data.i,packet.i); assert.equal(out.data.plans,packet.plans); assert.equal(JSON.stringify(packet),before);
  });
  const page:Record<string,unknown>=moodPage(); delete page.next_cursor;
  const out=await completeBootstrapPages(clientFor(()=>success(page)),moodPacket());
  assert.equal(out.gaps[0]?.code,'BOOTSTRAP_CURSOR_MISSING'); noMood(itemsOf(out.data)[0]!);
  const initial=await completeBootstrapPages(clientFor(()=>{throw new Error('No call expected');}),{...metadata,memory_days:{items:[{mood_text:'前片',mood_text_truncated:true}]}});
  assert.equal(initial.gaps[0]?.code,'BOOTSTRAP_CURSOR_MISSING'); noMood(itemsOf(initial.data)[0]!);
});

test('each transient page gets one retry at the identical cursor, independently for later pages',async()=>{
  const calls:number[]=[], attempts=new Map<number,number>();
  const out=await completeBootstrapPages(clientFor(args=>{
    const offset=(args.cursor as {offset:number}).offset; calls.push(offset);
    const attempt=(attempts.get(offset)??0)+1; attempts.set(offset,attempt);
    if(attempt===1) return failure('HTTP_503',503);
    return success(moodPage({content:offset===2?'乙':'\n',offset,next_cursor:offset===2?moodCursor(3):null}));
  }),moodPacket());
  assert.deepEqual(calls,[2,2,3,3]); assert.deepEqual(out.gaps,[]); assert.equal(itemsOf(out.data)[0]!.mood_text,'甲😀乙\n');
});

test('exhausted local retries do not stop another mood, I or plans; upstream messages stay private',async()=>{
  const packet=moodPacket(); packet.memory_days.items.push({...packet.memory_days.items[0],memory_id:'healthy',mood_text_next:moodCursor(2,'healthy')});
  let bad=0,good=0;
  const out=await completeBootstrapPages(clientFor(args=>{
    const id=(args.cursor as {memory_id:string}).memory_id;
    if(id==='mem_synthetic'){bad++;throw new Error('PRIVATE_UPSTREAM_ERROR');}
    good++;return success(moodPage({memory_id:'healthy'}));
  }),packet);
  assert.equal(bad,2);assert.equal(good,1); noMood(itemsOf(out.data)[0]!);
  assert.equal(itemsOf(out.data)[1]!.mood_text,'甲😀乙\n');
  assert.deepEqual(out.gaps,[{section:'mood_text',memoryId:'mem_synthetic',code:'BOOTSTRAP_PAGE_TRANSPORT',retryable:true}]);
  assert.equal(out.data.i,packet.i);assert.equal(out.data.plans,packet.plans);assert.equal(JSON.stringify(out.gaps).includes('PRIVATE_UPSTREAM_ERROR'),false);
});

test('401/403 remain global even with a nonstandard code and never receive a retry',async t=>{
  for(const status of [401,403]) await t.test(String(status),async()=>{
    let calls=0;await assert.rejects(completeBootstrapPages(clientFor(()=>{calls++;return failure('CUSTOM_DENIAL',status);}),moodPacket()),(error:unknown)=>error instanceof BootstrapPagingError&&error.httpStatus===status);
    assert.equal(calls,1);
  });
});

test('request timeout aborts child requests, leaves parent usable, and ignores late content',async()=>{
  const parent=new AbortController(), signals:AbortSignal[]=[], late:((value:MariposaCallResult)=>void)[]=[];
  const out=await completeBootstrapPages(clientFor((_args,signal)=>{signals.push(signal!);return new Promise(resolve=>late.push(resolve));}),moodPacket(),{signal:parent.signal,pageTimeoutMs:5});
  assert.equal(parent.signal.aborted,false);assert.equal(signals.length,2);assert.ok(signals.every(signal=>signal.aborted));
  assert.equal(out.gaps[0]?.code,'BOOTSTRAP_PAGE_TIMEOUT');assert.equal(out.gaps[0]?.retryable,true);noMood(itemsOf(out.data)[0]!);
  const before=JSON.stringify(out);late.forEach(resolve=>resolve(success(moodPage())));await nextTick();assert.equal(JSON.stringify(out),before);
  assert.deepEqual(await bootstrapCall(async()=>success({healthy:true}),{signal:parent.signal}),{healthy:true});
});

test('slow optional moods share a short deadline and cannot consume time reserved for I or validation',async()=>{
  const parent=new AbortController(), packet=moodPacket();
  for(const id of ['slow_second','slow_third'])packet.memory_days.items.push({...packet.memory_days.items[0],memory_id:id,mood_text_next:moodCursor(2,id)});
  const started=performance.now(), calls:{id:string;at:number;signal:AbortSignal}[]=[], late:((value:MariposaCallResult)=>void)[]=[];
  const out=await completeBootstrapPages(clientFor((args,signal)=>{
    calls.push({id:(args.cursor as {memory_id:string}).memory_id,at:performance.now()-started,signal:signal!});
    return new Promise(resolve=>late.push(resolve));
  }),packet,{signal:parent.signal,maxDurationMs:20,pageTimeoutMs:100});
  assert.ok(performance.now()-started<200,'The optional 20ms budget must not become six 100ms waits');
  assert.ok(calls.length>=1&&calls.length<=2);assert.ok(calls.every(call=>call.id==='mem_synthetic'&&call.signal.aborted));
  assert.ok(calls.every(call=>call.at<50),'No new transport starts after the optional deadline');
  assert.equal(out.gaps.length,3);assert.ok(out.gaps.some(gap=>gap.code==='BOOTSTRAP_MOOD_TIME_LIMIT'));
  for(const item of itemsOf(out.data))noMood(item);
  assert.equal(out.data.i,packet.i);assert.equal(out.data.plans,packet.plans);assert.equal(parent.signal.aborted,false);
  assert.deepEqual(await bootstrapCall(async()=>validSnapshot(),{signal:parent.signal}),{unchanged:true,snapshot_id:metadata.snapshot_id,profile:'estomago'});
  const before=JSON.stringify(out);late.forEach(resolve=>resolve(success(moodPage())));await nextTick();assert.equal(JSON.stringify(out),before);
});

test('shared page and byte budgets downgrade only the affected moods',async()=>{
  const packet=moodPacket();packet.memory_days.items.push({...packet.memory_days.items[0],memory_id:'second',mood_text_next:moodCursor(2,'second')});
  let calls=0;const out=await completeBootstrapPages(clientFor(()=>{calls++;return success(moodPage());}),packet,{maxPages:1});
  assert.equal(calls,1);assert.equal(itemsOf(out.data)[0]!.mood_text,'甲😀乙\n');noMood(itemsOf(out.data)[1]!);
  assert.equal(out.gaps[0]?.code,'BOOTSTRAP_PAGE_LIMIT');
  const small=await completeBootstrapPages(clientFor(()=>{throw new Error('Initial byte limit prevents request');}),moodPacket(),{maxBytes:1});
  assert.equal(small.gaps[0]?.code,'BOOTSTRAP_BYTE_LIMIT');noMood(itemsOf(small.data)[0]!);assert.equal(small.data.i instanceof Object,true);
});

test('Stop rejects uncooperative requests; late completion never wins',async()=>{
  const controller=new AbortController();let finish!:(value:MariposaCallResult)=>void;let child!:AbortSignal;
  const pending=completeBootstrapPages(clientFor((_args,signal)=>{child=signal!;return new Promise(resolve=>{finish=resolve;});}),moodPacket(),{signal:controller.signal});
  await nextTick();controller.abort();await rejectsCode(pending,'BOOTSTRAP_CANCELLED');assert.equal(child.aborted,true);
  finish(success(moodPage()));await nextTick();
  await rejectsCode(completeBootstrapPages(clientFor(()=>{throw new Error('Already stopped');}),moodPacket(),{signal:controller.signal}),'BOOTSTRAP_CANCELLED');
});

test('Stop before request microtask prevents transport from starting; deadline is distinct from Stop',async()=>{
  const controller=new AbortController();let calls=0;
  const pending=completeBootstrapPages(clientFor(()=>{calls++;return success(moodPage());}),moodPacket(),{signal:controller.signal});
  controller.abort();await rejectsCode(pending,'BOOTSTRAP_CANCELLED');assert.equal(calls,0);
  await rejectsCode(completeBootstrapPages(clientFor(()=>new Promise(()=>{})),moodPacket(),{signal:AbortSignal.timeout(5),pageTimeoutMs:100}),'BOOTSTRAP_DEADLINE_EXCEEDED');
});

test('client reuses bootstrap.get with original profile and loaded snapshot for validation',async()=>{
  const calls:unknown[]=[];const controller=new AbortController();
  const client=new MariposaClient({transport:async(capability,args,signal)=>{calls.push({capability,args});assert.equal(signal,controller.signal);return validSnapshot();}});
  assert.deepEqual(await client.bootstrapValidate(metadata.snapshot_id,controller.signal),validSnapshot());
  assert.deepEqual(calls,[{capability:'bootstrap.get',args:{profile:'estomago',loaded_snapshot_id:metadata.snapshot_id}}]);
});

test('supervisor caches only complete success and does not change ordinary successful text',async()=>{
  let gets=0,pages=0;
  const {host,warnings}=hostFor(async(capability,args)=>{
    if(capability==='bootstrap.get'){if(args.loaded_snapshot_id)return validSnapshot(String(args.loaded_snapshot_id));gets++;return success(moodPacket());}
    pages++;return success(moodPage());
  });
  const first=await callBootstrap.call(host,'complete');assert.ok(first?.includes('甲😀乙\n'));assert.ok(first?.includes('PRIVATE_I_KEEP'));assert.ok(first?.includes('PRIVATE_PLAN_KEEP'));
  assert.equal(await callBootstrap.call(host,'complete'),first);assert.equal(gets,1);assert.equal(pages,1);
  await callBootstrap.call(host,'another');assert.equal(gets,2);assert.equal(pages,2);assert.deepEqual(warnings,[]);
});

test('supervisor validates a partial snapshot, keeps I/plans, omits failed mood, and retries next call without caching',async()=>{
  let failPage=true,gets=0,pages=0,validations=0;
  const {host,warnings,observed,resolved}=hostFor(async(capability,args)=>{
    if(capability==='bootstrap.get'){
      if(args.loaded_snapshot_id){validations++;assert.equal(args.loaded_snapshot_id,metadata.snapshot_id);assert.equal(args.profile,'estomago');return validSnapshot();}
      gets++;return success(moodPacket());
    }
    pages++;return failPage?failure('HTTP_503',503):success(moodPage());
  });
  const first=await callBootstrap.call(host,'partial');assert.ok(first?.includes('PRIVATE_I_KEEP'));assert.ok(first?.includes('PRIVATE_PLAN_KEEP'));assert.match(first!,/心情.*未完整取得|心情.*未全载|未全载.*心情/);
  assert.equal(first!.includes('甲😀'),false);assert.equal(host.bootstrapByWindow.has('partial'),false);assert.equal(validations,1);assert.equal(pages,2);
  assert.ok(observed.length>0);assert.equal(observed.at(-1)?.severity??'warning','warning');privateDiagnostics(warnings,observed);
  failPage=false;const recovered=await callBootstrap.call(host,'partial');assert.ok(recovered?.includes('甲😀乙\n'));assert.equal(gets,2);assert.equal(host.bootstrapByWindow.has('partial'),true);assert.ok(resolved.length>0);
});

test('invalid/failed snapshot validation cannot preserve other private sections',async t=>{
  const cases:[string,MariposaCallResult][]=[
    ['wrong id',success({unchanged:true,snapshot_id:'other',profile:'estomago'})],
    ['wrong profile',success({unchanged:true,snapshot_id:metadata.snapshot_id,profile:'cc'})],
    ['not unchanged',success({unchanged:false,snapshot_id:metadata.snapshot_id,profile:'estomago'})],
    ['missing receipt',success({})],['transport error',failure('HTTP_503',503)],['auth denied',failure('FORBIDDEN',403)],
  ];
  for(const [name,response] of cases)await t.test(name,async()=>{
    const {host,warnings,observed}=hostFor(async(capability,args)=>capability==='bootstrap.get'?(args.loaded_snapshot_id?response:success(moodPacket())):failure('HTTP_503',503));
    unavailable(await callBootstrap.call(host,'validation-failed'));assert.equal(host.bootstrapByWindow.has('validation-failed'),false);assert.equal(observed.at(-1)?.severity,'critical');privateDiagnostics(warnings,observed);
  });
});

test('explicit next authorization denial never becomes a local gap even if get validation could succeed',async t=>{
  for(const status of [401,403])await t.test(String(status),async()=>{
    let validations=0,pages=0;
    const {host,warnings,observed}=hostFor(async(capability,args)=>{
      if(capability==='bootstrap.get'){if(args.loaded_snapshot_id){validations++;return validSnapshot();}return success(moodPacket());}
      pages++;return failure('DENIED',status);
    });
    unavailable(await callBootstrap.call(host,'denied'));assert.equal(pages,1);assert.equal(validations,0);assert.equal(observed.at(-1)?.severity,'critical');privateDiagnostics(warnings,observed);
  });
});

test('a stale snapshot rebuilds the entire package once and never mixes old private content',async()=>{
  let gets=0,pages=0;
  const {host,warnings,observed}=hostFor(async(capability,args)=>{
    if(capability==='bootstrap.get'){
      if(args.loaded_snapshot_id)return validSnapshot(String(args.loaded_snapshot_id));gets++;
      return success({...moodPacket(),snapshot_id:`snap_${gets}`,i:{content:gets===1?'OLD_I_MUST_NOT_SURVIVE':'NEW_I'},plans:{items:[{title:gets===1?'OLD_PLAN_MUST_NOT_SURVIVE':'NEW_PLAN'}]}});
    }
    pages++;return args.snapshot_id==='snap_1'?failure('SNAPSHOT_STALE',409):success(moodPage({snapshot_id:'snap_2'}));
  });
  const text=await callBootstrap.call(host,'stale-then-good');assert.equal(gets,2);assert.equal(pages,2);assert.ok(text?.includes('NEW_I'));assert.ok(text?.includes('NEW_PLAN'));assert.equal(text?.includes('OLD_I_MUST_NOT_SURVIVE'),false);assert.equal(text?.includes('OLD_PLAN_MUST_NOT_SURVIVE'),false);assert.equal(host.bootstrapByWindow.has('stale-then-good'),true);privateDiagnostics(warnings,observed);
});

test('stale final validation rebuilds instead of retaining I/plans from the rejected snapshot',async()=>{
  let gets=0,validations=0;
  const {host}=hostFor(async(capability,args)=>{
    if(capability==='bootstrap.get'){
      if(args.loaded_snapshot_id){validations++;return args.loaded_snapshot_id==='verify_1'?failure('SNAPSHOT_STALE',409):validSnapshot(String(args.loaded_snapshot_id));}
      gets++;return success({...moodPacket(),snapshot_id:`verify_${gets}`,i:{content:gets===1?'OLD_VERIFY_I':'NEW_VERIFY_I'},plans:{items:[{title:gets===1?'OLD_VERIFY_PLAN':'NEW_VERIFY_PLAN'}]}});
    }
    return failure('HTTP_503',503);
  });
  const text=await callBootstrap.call(host,'validation-stale');assert.equal(gets,2);assert.equal(validations,2);assert.ok(text?.includes('NEW_VERIFY_I'));assert.ok(text?.includes('NEW_VERIFY_PLAN'));assert.equal(text?.includes('OLD_VERIFY_I'),false);assert.equal(text?.includes('OLD_VERIFY_PLAN'),false);assert.equal(host.bootstrapByWindow.has('validation-stale'),false);
});

test('persistent stale performs at most two get attempts then returns a critical unavailable marker',async()=>{
  let gets=0,pages=0;
  const {host,warnings,observed}=hostFor(async capability=>{if(capability==='bootstrap.get'){gets++;return success(moodPacket());}pages++;return failure('SNAPSHOT_STALE',409);});
  unavailable(await callBootstrap.call(host,'stale'));assert.equal(gets,2);assert.equal(pages,2);assert.equal(host.bootstrapByWindow.has('stale'),false);assert.equal(observed.at(-1)?.severity,'critical');privateDiagnostics(warnings,observed);
});

test('stale during I continuation also rebuilds the whole snapshot, not just the I suffix',async()=>{
  let gets=0;
  const {host}=hostFor(async(capability,args)=>{
    if(capability==='bootstrap.get'){
      if(args.loaded_snapshot_id)return validSnapshot(String(args.loaded_snapshot_id));gets++;
      return success({...metadata,snapshot_id:`i_snap_${gets}`,memory_days:{items:[]},plans:{items:[{title:gets===1?'OLD_I_PLAN':'NEW_I_PLAN'}]},i:{content:gets===1?'OLD_I_PREFIX':'NEW_I_PREFIX',truncated:true,total_chars:14,next_cursor:{i_offset:12}}});
    }
    assert.equal(args.section,'i');
    return args.snapshot_id==='i_snap_1'?failure('SNAPSHOT_STALE',409):success({...metadata,snapshot_id:'i_snap_2',section:'i',content:'尾段',offset:12,total_chars:14,next_cursor:null});
  });
  const text=await callBootstrap.call(host,'i-stale');assert.equal(gets,2);assert.ok(text?.includes('NEW_I_PREFIX尾段'));assert.ok(text?.includes('NEW_I_PLAN'));assert.equal(text?.includes('OLD_I_PREFIX'),false);assert.equal(text?.includes('OLD_I_PLAN'),false);
});

test('Stop during snapshot validation returns null without alert/cache, even when a response arrives late',async()=>{
  const controller=new AbortController();let complete!:(value:MariposaCallResult)=>void;let validationStarted!:()=>void;
  const started=new Promise<void>(resolve=>{validationStarted=resolve;});
  const {host,warnings,observed}=hostFor(async(capability,args)=>{
    if(capability==='bootstrap.get'){
      if(args.loaded_snapshot_id){validationStarted();return new Promise(resolve=>{complete=resolve;});}
      return success(moodPacket());
    }
    return failure('HTTP_503',503);
  });
  const pending=callBootstrap.call(host,'stop-validation',controller.signal);await started;controller.abort();assert.equal(await pending,null);
  complete(validSnapshot());await nextTick();assert.equal(host.bootstrapByWindow.has('stop-validation'),false);assert.deepEqual(warnings,[]);assert.deepEqual(observed,[]);
});

test('uncooperative initial get obeys parent Stop and a deadline produces an unavailable marker',async()=>{
  const controller=new AbortController();let finish!:(value:MariposaCallResult)=>void;
  const {host,warnings,observed}=hostFor(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=callBootstrap.call(host,'stop-initial',controller.signal);await nextTick();controller.abort();assert.equal(await pending,null);finish(success(moodPacket()));await nextTick();assert.deepEqual(warnings,[]);assert.deepEqual(observed,[]);assert.equal(host.bootstrapByWindow.size,0);
  const timed=hostFor(()=>new Promise(()=>{}));unavailable(await callBootstrap.call(timed.host,'deadline',AbortSignal.timeout(5)));assert.equal(timed.observed.at(-1)?.severity,'critical');
});

test('retired anniversary fields are ignored while the independent anniversary memory category remains',async()=>{
  const packet={...moodPacket(),anniversaries:{items:[{title:'LEGACY_ANNIV_CANARY'}],next_cursor:{anniversaries_offset:0}}};
  Object.assign(packet.memory_days.items[0],{categories:['anniversary'],original_title:'纪念分类事件保留'});
  const transport:MariposaTransport=async(capability,args)=>{
    if(capability==='bootstrap.get')return args.loaded_snapshot_id?validSnapshot():success(packet);
    assert.equal(args.section,'memory_item');return success(moodPage());
  };
  const out=await completeBootstrapPages(new MariposaClient({transport}),packet);assert.equal(Object.hasOwn(out.data,'anniversaries'),false);assert.deepEqual(itemsOf(out.data)[0]!.categories,['anniversary']);
  const {host,warnings}=hostFor(transport);const text=await callBootstrap.call(host,'retired');assert.ok(text?.includes('纪念分类事件保留'));assert.equal(text?.includes('LEGACY_ANNIV_CANARY'),false);assert.deepEqual(warnings,[]);
});

test('I, event and words continuations finish before optional moods while presentation order stays unchanged',async()=>{
  const packet=moodPacket();
  Object.assign(packet.memory_days.items[0],{
    event_text:'事😀',event_text_truncated:true,event_text_total_chars:4,
    event_text_next:{memory_id:'mem_synthetic',field:'event_text',offset:2},
    our_words:[{speaker:'jiaming',texts:['首条原话']}],our_words_truncated:true,our_words_total_items:2,
    our_words_next:{memory_id:'mem_synthetic',field:'our_words',item_offset:1,char_offset:0},
  });
  Object.assign(packet.i,{content:'我😀',truncated:true,total_chars:4,next_cursor:{i_offset:2}});
  const calls:string[]=[];
  const {host,warnings,observed}=hostFor(async(capability,args)=>{
    if(capability==='bootstrap.get')return args.loaded_snapshot_id?validSnapshot():success(packet);
    const cursor=args.cursor as Record<string,unknown>, field=args.section==='i'?'i':String(cursor.field);calls.push(field);
    if(field==='event_text')return success({...metadata,section:'memory_item',memory_id:'mem_synthetic',field,content:'经过',offset:2,total_chars:4,next_cursor:null});
    if(field==='our_words')return success({...metadata,section:'memory_item',memory_id:'mem_synthetic',field,items:[{speaker:'qiaosheng',texts:['后续原话']}],item_offset:1,char_offset:0,total_items:2,next_cursor:null});
    if(field==='i')return success({...metadata,section:'i',content:'当前',offset:2,total_chars:4,next_cursor:null});
    assert.equal(field,'mood_text');return success(moodPage());
  });
  const text=await callBootstrap.call(host,'ordered');
  assert.equal(calls.at(-1),'mood_text');assert.deepEqual(new Set(calls.slice(0,-1)),new Set(['i','event_text','our_words']));
  assert.ok(text?.includes('事😀经过'));assert.ok(text?.includes('我😀当前'));assert.ok(text?.includes('后续原话'));
  const moodAt=text!.indexOf('心情文字：甲😀乙\n'), eventAt=text!.indexOf('事件：事😀经过'), planAt=text!.indexOf('PRIVATE_PLAN_KEEP'), iAt=text!.indexOf('I（当前的话）：我😀当前');
  assert.ok(moodAt>=0&&moodAt<eventAt&&eventAt<planAt&&planAt<iAt,'Only acquisition order changes; normal output keeps its established order');
  assert.deepEqual(warnings,[]);assert.deepEqual(observed,[]);assert.equal(host.bootstrapByWindow.has('ordered'),true);
});

test('moods surrender the remaining preparation time so completed I and snapshot validation survive',async t=>{
  let clock=0;t.mock.method(performance,'now',()=>clock);
  const packet=moodPacket();Object.assign(packet.i,{content:'我😀',truncated:true,total_chars:4,next_cursor:{i_offset:2}});
  let moodCalls=0,validations=0;
  const {host,observed}=hostFor(async(capability,args)=>{
    if(capability==='bootstrap.get'){
      if(args.loaded_snapshot_id){validations++;return validSnapshot();}
      return success(packet);
    }
    if(args.section==='i'){
      clock=6500; // 1500ms remain; the host must reserve 1700ms and skip optional calls.
      return success({...metadata,section:'i',content:'当前',offset:2,total_chars:4,next_cursor:null});
    }
    moodCalls++;return success(moodPage());
  });
  const text=await callBootstrap.call(host,'remaining-budget');
  assert.equal(moodCalls,0);assert.equal(validations,1);assert.ok(text?.includes('我😀当前'));assert.ok(text?.includes('PRIVATE_PLAN_KEEP'));
  assert.equal(text?.includes('甲😀'),false);assert.equal(observed.at(-1)?.severity,'warning');assert.equal(host.bootstrapByWindow.has('remaining-budget'),false);
});

test('empty first I fragment follows offset zero and reconstructs Unicode content',async()=>{
  const packet={...metadata,memory_days:{items:[]},plans:{items:[]},i:{content:'',truncated:true,total_chars:4,next_cursor:{i_offset:0}}};
  let pages=0;
  const {host,warnings,observed}=hostFor(async(capability,args)=>{
    if(capability==='bootstrap.get')return args.loaded_snapshot_id?validSnapshot():success(packet);
    assert.equal(args.section,'i');assert.deepEqual(args.cursor,{i_offset:0});pages++;
    return success({...metadata,section:'i',content:'我😀当前',offset:0,total_chars:4,next_cursor:null});
  });
  const text=await callBootstrap.call(host,'empty-i');assert.equal(pages,1);assert.ok(text?.includes('I（当前的话）：我😀当前'));assert.equal(host.bootstrapByWindow.has('empty-i'),true);assert.deepEqual(warnings,[]);assert.deepEqual(observed,[]);
});

test('explicit malformed I values become critical local gaps after validating the other sections',async t=>{
  const cases:unknown[]=[0,false,'BAD_I_PRIVATE',[],{content:7},{content:null},{content:[]},{content:{text:'BAD_I_PRIVATE'}}];
  for(const [index,bad]of cases.entries())await t.test(String(index),async()=>{
    const packet={...metadata,memory_days:{items:[]},plans:{items:[{title:'PRIVATE_PLAN_KEEP'}]},i:bad};
    let validations=0,pages=0;
    const {host,warnings,observed}=hostFor(async(capability,args)=>{
      if(capability==='bootstrap.get'){if(args.loaded_snapshot_id){validations++;return validSnapshot();}return success(packet);}
      pages++;throw new Error('Malformed initial I must not start a continuation');
    });
    const text=await callBootstrap.call(host,'bad-i');assert.ok(text?.includes('PRIVATE_PLAN_KEEP'));assert.equal(text?.includes('BAD_I_PRIVATE'),false);assert.equal(text?.includes('Mariposa开窗资料未取得'),false);
    assert.equal(validations,1);assert.equal(pages,0);assert.equal(observed.at(-1)?.severity,'critical');assert.equal(host.bootstrapByWindow.has('bad-i'),false);privateDiagnostics(warnings,observed);
  });
});

test('empty I with a missing required continuation is not cached as a complete empty I',async()=>{
  let validations=0;
  const packet={...metadata,memory_days:{items:[]},plans:{items:[{title:'PRIVATE_PLAN_KEEP'}]},i:{content:'',truncated:true,total_chars:4}};
  const {host,observed}=hostFor(async(capability,args)=>{assert.equal(capability,'bootstrap.get');if(args.loaded_snapshot_id){validations++;return validSnapshot();}return success(packet);});
  const text=await callBootstrap.call(host,'i-missing-cursor');assert.ok(text?.includes('PRIVATE_PLAN_KEEP'));assert.match(text!,/I.*未全载/);assert.equal(validations,1);assert.equal(observed.at(-1)?.severity,'critical');assert.equal(host.bootstrapByWindow.has('i-missing-cursor'),false);
});

test('I and event reject wrong offsets, totals and cursor progression before appending any bad suffix',async t=>{
  const cases:[string,Record<string,unknown>][]=[
    ['offset is UTF-16 instead of code points',{offset:3}],
    ['total changes',{total_chars:5}],
    ['final page total missing',{total_chars:undefined}],
    ['final page underfills total',{content:'乙'}],
    ['total is wrong type',{total_chars:'4'}],
    ['total is negative',{total_chars:-1}],
    ['non-string suffix',{content:{text:'BAD_SUFFIX'}}],
    ['empty suffix',{content:''}],
    ['terminal cursor missing',{next_cursor:undefined}],
    ['cursor skips forward',{_nextOffset:5}],
    ['cursor repeats',{_nextOffset:2}],
  ];
  for(const section of ['i','event_text'] as const)for(const [name,change]of cases)await t.test(`${section}: ${name}`,async()=>{
    const packet:Record<string,unknown>={...metadata,memory_days:{items:[]},i:{content:'PRIVATE_I_KEEP'},plans:{items:[{title:'PRIVATE_PLAN_KEEP'}]}};
    const cursor=section==='i'?{i_offset:2}:{memory_id:'text_memory',field:'event_text',offset:2};
    if(section==='i')packet.i={content:'甲😀',truncated:true,total_chars:4,next_cursor:cursor};
    else packet.memory_days={items:[{memory_id:'text_memory',original_title:'事件标题',event_text:'甲😀',event_text_truncated:true,event_text_total_chars:4,event_text_next:cursor}]};
    const page:Record<string,unknown>={...metadata,section:section==='i'?'i':'memory_item',...(section==='event_text'?{memory_id:'text_memory',field:section}:{}),content:'乙🦋',offset:2,total_chars:4,next_cursor:null,...change};
    for(const key of ['total_chars','next_cursor'])if(page[key]===undefined)delete page[key];
    if('_nextOffset'in page){page.next_cursor=section==='i'?{i_offset:page._nextOffset}:{memory_id:'text_memory',field:section,offset:page._nextOffset};delete page._nextOffset;}
    let validations=0,pages=0;
    const {host,warnings,observed}=hostFor(async(capability,args)=>{
      if(capability==='bootstrap.get'){if(args.loaded_snapshot_id){validations++;return validSnapshot();}return success(packet);}
      assert.equal(args.section,section==='i'?'i':'memory_item');assert.deepEqual(args.cursor,cursor);pages++;return success(page);
    });
    const text=await callBootstrap.call(host,'bad-text-page');assert.ok(text?.includes('PRIVATE_PLAN_KEEP'));assert.equal(text?.includes('乙🦋'),false);assert.equal(text?.includes('BAD_SUFFIX'),false);assert.equal(text?.includes('甲😀乙'),false);
    assert.equal(pages,1);assert.equal(validations,1);assert.equal(host.bootstrapByWindow.has('bad-text-page'),false);assert.equal(observed.at(-1)?.severity,section==='i'?'critical':'warning');privateDiagnostics(warnings,observed);
    if(section==='event_text')assert.ok(text?.includes('PRIVATE_I_KEEP'));
  });
});

test('explicit malformed plan sections fail globally rather than becoming no plans or rendered scalar data',async t=>{
  const cases:unknown[]=[
    'PRIVATE_PLAN_BAD',0,false,[],
    {items:null},{items:'PRIVATE_PLAN_BAD'},{items:{}},{items:1},
    {items:[null]},{items:['PRIVATE_PLAN_BAD']},{items:[7]},{items:[false]},{items:[[]]},
  ];
  for(const [index,plans]of cases.entries())await t.test(String(index),async()=>{
    let gets=0,pages=0,validations=0;
    const {host,warnings,observed}=hostFor(async(capability,args)=>{
      if(capability==='bootstrap.get'){
        if(args.loaded_snapshot_id){validations++;return validSnapshot();}
        gets++;return success({...metadata,memory_days:{items:[]},i:{content:'PRIVATE_I_KEEP'},plans});
      }
      pages++;throw new Error('Malformed plans must fail before continuations');
    });
    const text=await callBootstrap.call(host,'malformed-plans');unavailable(text);
    assert.equal(text?.includes('PRIVATE_PLAN_BAD'),false);assert.equal(gets,1);assert.equal(pages,0);assert.equal(validations,0);
    assert.equal(observed.at(-1)?.severity,'critical');assert.match(JSON.stringify(warnings),/BOOTSTRAP_SHAPE_INVALID/);
    assert.equal(host.bootstrapByWindow.has('malformed-plans'),false);privateDiagnostics(warnings,observed);assert.equal(JSON.stringify({warnings,observed}).includes('PRIVATE_PLAN_BAD'),false);
  });
});

test('absent, null and legacy empty plans remain compatible and cache ordinary complete output',async()=>{
  for(const extra of [{},{plans:null},{plans:{}},{plans:{items:[]}}]){
    const {host,warnings,observed}=hostFor(async(capability,args)=>{
      assert.equal(capability,'bootstrap.get');assert.equal(args.loaded_snapshot_id,undefined);
      return success({...metadata,memory_days:{items:[]},i:{content:'PRIVATE_I_KEEP'},...extra});
    });
    const text=await callBootstrap.call(host,'legacy-plans');assert.ok(text?.includes('PRIVATE_I_KEEP'));assert.equal(text?.includes('Mariposa开窗资料未取得'),false);
    assert.deepEqual(warnings,[]);assert.deepEqual(observed,[]);assert.equal(host.bootstrapByWindow.has('legacy-plans'),true);
  }
});

test('npm test file selectors reject unknown, outside-group and missing paths without starting a suite', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  for (const args of [
    ['--file=tests/unit/not-a-real-test.test.ts'],
    ['--unit', '--file=tests/cross-project/bootstrap-pagination.test.ts'],
    ['--file=../../external.test.ts'],
    ['--file='], ['--file'],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', ...args], { cwd: root, env: process.env, timeout: 2000, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--file/);
    assert.doesNotMatch(result.stdout, /串行执行/);
  }
});
