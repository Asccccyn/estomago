"""Regression for REVIEW_76c8117 #1 (native SDK cold replay).

Use the original joint Host/query fixture in a disposable home. Keep the
independent audit's historical observation script intact. Each child is a
separate SDK/Host process: crash after the real business COMMIT, startup and
shutdown without a model call, then another startup and one natural chat.
"""
from pathlib import Path
import sys
import tempfile
from run_batches import repo, run

here = Path(__file__).resolve().parent
code = (here / 'joint.mjs').read_text()


def replace(before, after):
    global code
    assert code.count(before) == 1, ('Fixture changed; review the observation point', before[:150])
    code = code.replace(before, after, 1)


replace("await content.start();writeApprovedIdentity(root);",
        "await content.start();if(ending==='crash')writeApprovedIdentity(root);")
replace("let phase = 'chat', batch = 0, host, uid = 0;",
        r"""let phase = 'chat', batch = 0, host, uid = 0;
const evidencePath=path.join(root,'sdk-cold-evidence.json');
const writesPath=path.join(root,'sdk-cold-source-writes.jsonl');
const sourceWrite=(kind,id)=>fs.appendFileSync(writesPath,JSON.stringify({kind,id})+'\n');
const sourceWrites=()=>fs.existsSync(writesPath)
  ?fs.readFileSync(writesPath,'utf8').trim().split('\n').map(l=>JSON.parse(l)):[];
const sdkCardReceipts=[];
let nativeReplay=null;""")
# A later source revision must not reconstruct the original model-visible card.
replace("content:'合成卡面，供本次审计'",
        "content:ending==='crash'?'合成卡面，供本次审计':'合成重启后源已修订'")
replace("    metrics.starReplies.push({match:body.text===synthetic,starId,receiptId:receipt.id,key});",
        """    sourceWrite('reply',key);
    metrics.starReplies.push({match:body.text===synthetic,starId,receiptId:receipt.id,key});""")
replace("    metrics.starWrites.push({match:body.content===synthetic,fullBytes:bytes(receipt)});",
        """    sourceWrite('star',new Headers(options.headers).get('Idempotency-Key'));
    metrics.starWrites.push({match:body.content===synthetic,fullBytes:bytes(receipt)});""")
replace("      metrics.memoryWrites.push({match:data.text===synthetic});",
        """      sourceWrite('hold',data.operation_id);
      metrics.memoryWrites.push({match:data.text===synthetic});""")
replace("yield* scriptedSdkInput(input,session,()=>{})",
        """yield* scriptedSdkInput(input,session,(_frame,history)=>{
        if(ending==='cold')nativeReplay=history.flatMap(frame=>frame.message.content);
      })""")
replace("          observeCard(receipt.content);",
        """          observeCard(receipt.content);
          const text=receipt.content?.find?.(b=>b.type==='text')?.text;
          if(typeof text==='string'){
            let body;try{body=JSON.parse(text);}catch{}
            if(body?.heartbeat_card)sdkCardReceipts.push({id:c.id,body});
          }""")
# Install the fake memory transport before startup recovery can run.
replace("  await host.start();\n  const db=host.db, settings=new BackgroundSettingsService(db,config);",
        "  const db=host.db, settings=new BackgroundSettingsService(db,config);")

probe = r"""
  await host.start();
  const parseText=content=>{
    const text=typeof content==='string'?content:content?.find?.(part=>part.type==='text')?.text;
    return JSON.parse(text);
  };
  const messagesOf=packet=>JSON.parse(packet.payload_json).messages;
  function pairs(messages,id) {
    return {
      calls:messages.flatMap(m=>m.tool_calls??[]).filter(c=>c.id===id),
      results:messages.filter(m=>m.role==='tool'&&m.tool_call_id===id).map(m=>parseText(m.content)),
    };
  }
  function nativePairs(blocks,id){
    return {
      calls:blocks.filter(b=>b.type==='tool_use'&&b.id===id),
      results:blocks.filter(b=>b.type==='tool_result'&&b.tool_use_id===id).map(b=>parseText(b.content))
    };
  }
  const one=(pair,label)=>{
    assert.equal(pair.calls.length,1,label+' call count');
    assert.equal(pair.results.length,1,label+' result count');
  };
  const countRequests=()=>db.prepare('select count(*) n from provider_requests').get().n;
  const countRuns=()=>db.prepare("select count(*) n from background_runs where kind='keepwarm'").get().n;
  const consumption=()=>db.prepare("select run_id,operation_id,card_number,state,source_identity,provider_request_id,delivered_at from heartbeat_draw_operations order by rowid").all().map(row=>({...row}));
  const effect=()=>db.prepare("select id,turn_id,window_id,state,verified,operation_id,tool_call_id,memory_id from tool_side_effects where kind='hold'").all().map(row=>({...row}));
  const action=()=>db.prepare("select run_id,call_id,action_json from heartbeat_actions where json_extract(action_json,'$.kind')='memory_hold'").all().map(row=>({...row}));
  function compareDraw(messages,facts,label){
    const pair=pairs(messages,facts.drawId);one(pair,label);
    assert.deepEqual(pair.calls[0],facts.drawCall,label+' original call');
    assert.deepEqual(pair.results[0],facts.card,label+' original card (not revised source)');
  }
  function checkHold(pair,facts,label){
    one(pair,label);const result=pair.results[0];
    assert.equal(result.saved,true,label+' hold success retained');
    assert.equal(result.memory_id,facts.memoryId,label+' hold same memory');
    assert.equal(result.version,1,label+' hold same receipt revision');
    assert.equal(result.source_status,'unbound',label+' full pending receipt');
  }
  if(ending!=='crash'){
    const facts=JSON.parse(fs.readFileSync(evidencePath,'utf8'));
    assert.equal(host.windows.activeWindow('primary')?.id,facts.windowId);
    await host.supervisor.waitIdle();
    assert.equal(metrics.sessions.length,0,'startup zero SDK query');
    assert.equal(countRequests(),facts.requestCount,'startup zero model requests');
    assert.equal(countRuns(),facts.runCount,'no new heartbeat run');
    assert.deepEqual(sourceWrites(),facts.writes,'startup never rewrites any source');
    assert.deepEqual(consumption(),facts.drawRows,'startup never consumes another card');
    assert.deepEqual(effect(),facts.effects,'original committed memory effect only');
    assert.deepEqual(action(),facts.actions,'original committed memory action only');
    const stored=db.prepare('select messages_json from window_trajectories where window_id=?').get(facts.windowId);
    assert.ok(stored);
    const canonical=JSON.parse(stored.messages_json);
    compareDraw(canonical,facts,'canonical '+ending);
    const held=pairs(canonical,facts.holdId);checkHold(held,facts,'canonical '+ending);
    const canonicalHash=hash(stored.messages_json);
    if(ending==='recover'){
      fs.writeFileSync(path.join(root,'sdk-cold-recovered-hash'),canonicalHash);
      console.log('COLD_RECOVERY '+JSON.stringify({stage:ending,drawCalls:1,drawResults:1,holdCalls:1,holdResults:1,requestCount:countRequests(),newQueries:0,canonicalHash}));
    } else {
      assert.equal(canonicalHash,fs.readFileSync(path.join(root,'sdk-cold-recovered-hash'),'utf8'),'second restart did not append/modify canonical history');
      const message=host.messages.submitUserMessageWithTurn({conversationId:'primary',content:'合成重启后自然消息',clientMessageId:randomUUID()});
      host.supervisor.enqueue(message.turnId);await host.supervisor.waitIdle();
      assert.equal(db.prepare('select state from turns where id=?').get(message.turnId).state,'completed');
      const packets=db.prepare('select window_id,payload_json from provider_requests where turn_id=? and sent_at is not null order by rowid').all(message.turnId);
      assert.equal(packets.length,1,'only one natural request');
      const actual=packets[0];assert.equal(actual.window_id,facts.windowId);
      compareDraw(messagesOf(actual),facts,'natural request projection');
      checkHold(pairs(messagesOf(actual),facts.holdId),facts,'natural request projection');
      assert.ok(nativeReplay,'actual SDK received its replay stream');
      const nativeDraw=nativePairs(nativeReplay,facts.drawId);one(nativeDraw,'native cold replay');
      assert.deepEqual(nativeDraw.calls[0].input,JSON.parse(facts.drawCall.function.arguments));
      assert.equal(nativeDraw.calls[0].name,'mcp__est__'+(facts.drawCall.function.name.replace(/^mcp__est__/,'')));
      assert.deepEqual(nativeDraw.results[0],facts.card,'native cold replay preserved exact card');
      const nativeHold=nativePairs(nativeReplay,facts.holdId);checkHold(nativeHold,facts,'native cold replay');
      assert.deepEqual(nativeHold.calls[0].input,JSON.parse(held.calls[0].function.arguments));
      assert.equal(metrics.sessions.length,1);assert.equal(metrics.sessions[0].resume,false,'a real cold SDK session');
      assert.equal(countRequests(),facts.requestCount+1);
      assert.equal(countRuns(),facts.runCount);
      assert.deepEqual(sourceWrites(),facts.writes,'natural chat never rewrites source');
      assert.deepEqual(consumption(),facts.drawRows,'no duplicate consumption');
      assert.deepEqual(effect(),facts.effects);
      assert.deepEqual(action(),facts.actions);
      console.log('COLD_RECOVERY '+JSON.stringify({stage:ending,drawCalls:1,drawResults:1,holdCalls:1,holdResults:1,nativeCalls:1,nativeResults:1,nativeHoldResults:1,requestCount:countRequests(),newQueries:metrics.sessions.length,resume:metrics.sessions[0].resume,canonicalHash}));
    }
  } else {
    const execute=db.exec.bind(db);
    db.exec=sql=>{
      execute(sql);
      if(sql==='COMMIT'&&phase==='heart'&&action().some(r=>JSON.parse(r.action_json).status==='committed')){
        const actions=action(),effects=effect(),drawRows=consumption();
        assert.equal(actions.length,1);assert.equal(effects.length,1);
        assert.equal(effects[0].state,'committed');assert.equal(effects[0].verified,1);
        assert.equal(effects[0].tool_call_id,actions[0].call_id);
        assert.equal(effects[0].memory_id,'synthetic-memory');
        assert.equal(drawRows.length,1);assert.equal(drawRows[0].state,'delivered');
        const packet=db.prepare("select window_id,turn_id,id,payload_json from provider_requests where background_run_id=? and sent_at is not null order by rowid desc limit 1").get(actions[0].run_id);
        assert.ok(packet);assert.equal(packet.id,drawRows[0].provider_request_id);
        assert.equal(sdkCardReceipts.length,1,'SDK already received exactly one original card');
        const observed=sdkCardReceipts[0],drawPair=pairs(messagesOf(packet),observed.id);
        one(drawPair,'last confirmed provider input');
        assert.deepEqual(drawPair.results[0],observed.body);
        const holdId=actions[0].call_id;
        assert.deepEqual(pairs(messagesOf(packet),holdId),{calls:[],results:[]},'hold has not been sent back yet');
        const writes=sourceWrites();
        assert.equal(writes.filter(r=>r.kind==='hold').length,1);
        assert.equal(writes.find(r=>r.kind==='hold').id,effects[0].operation_id);
        fs.writeFileSync(evidencePath,JSON.stringify({windowId:packet.window_id,drawId:observed.id,drawCall:drawPair.calls[0],card:observed.body,holdId,memoryId:effects[0].memory_id,requestCount:countRequests(),runCount:countRuns(),drawRows,effects,actions,writes}));
        process.kill(process.pid,'SIGKILL');
      }
    };
"""
replace("  const rt=new RuntimeSettingsService(db);", probe+"  const rt=new RuntimeSettingsService(db);")
replace("}catch(e){metrics.exceptions.push(String(e.stack));",
        "  }\n}catch(e){metrics.exceptions.push(String(e.stack));")

protocols = sys.argv[1:] or ['direct']
if any(p not in ('direct', 'deferred') for p in protocols):
    raise SystemExit('Usage: sdk_cold_recovery.py [direct] [deferred]')
for protocol in protocols:
    with tempfile.TemporaryDirectory(prefix='est-sdk-cold-regression-') as work:
        root = Path(work)
        (root / 'host').mkdir()
        (root / 'tmp').mkdir()
        fixture = root / 'sdk-cold.mjs'
        fixture.write_text(code)
        env = dict(HOME=work, ESTOMAGO_HOME=str(root/'host'), TMPDIR=str(root/'tmp'),
                   ESTOMAGO_TEST_MODE='1', PATH='/opt/homebrew/bin:/usr/bin:/bin',
                   NODE_OPTIONS='--require='+str(here/'local-only.cjs'))
        guard, guard_log = run(['node', 'scripts/test-guard.mjs'], env, 10)
        assert guard == 0, guard_log[-1000:]
        for stage in ['crash', 'recover', 'cold']:
            rc, out = run(['node', str(fixture), 'sdk', protocol, stage], env, 40)
            if stage == 'crash':
                assert rc == -9 and (root/'host'/'sdk-cold-evidence.json').is_file(), (stage, rc, out[-2500:])
                print(protocol, stage, 'actual_commit_then_SIGKILL', 'group_empty', flush=True)
            else:
                lines = [line for line in out.splitlines() if line.startswith('COLD_RECOVERY ')]
                assert rc == 0 and len(lines) == 1, (stage, rc, out[-3500:])
                print(protocol, lines[0], 'group_empty', flush=True)
