"""Independent assertions at the existing Host crash seam and ordinary public entry points."""
from pathlib import Path
import re
import tempfile
from run_batches import run, repo

here=Path(__file__).resolve().parent

def run_one(label, original, replacements, args=()):
    # Keep application code intact. Extend a specific checked-in fixture in tmp.
    with tempfile.TemporaryDirectory(prefix='est-independent-') as work:
        root=Path(work)
        for name in ['host','tmp']: (root/name).mkdir()
        code=original.read_text()
        for before,after in replacements:
            assert code.count(before)==1,(label,'Fixture changed. Review the observation point before rerunning.',before[:100])
            code=code.replace(before,after,1)
        code=re.sub(r"from '([.][.]?/[^']+)'",lambda m:"from '"+str((original.parent/m[1]).resolve())+"'",code)
        test=root/('edge'+original.suffix)
        test.write_text(code)
        env=dict(PATH='/opt/homebrew/bin:/usr/bin:/bin',HOME=work,TMPDIR=str(root/'tmp'),ESTOMAGO_HOME=str(root/'host'),ESTOMAGO_TEST_MODE='1',NODE_OPTIONS='--require='+str(here/'local-only.cjs'))
        rc,log=run(['node',*args[:1],str(test),*args[1:]] if args and args[0].startswith('--') else ['node',str(test),*args],env,65)
        facts=[line for line in log.splitlines() if line.startswith('EDGE ')]
        print(label,'process_group_empty','exit',rc,'\n'.join(facts),flush=True)
        if rc or not facts:
            print(log[-1600:],flush=True)
            raise RuntimeError(label)

crash=repo/'tests/integration/heartbeat-v12-orchestration.test.ts'
hook="""    ctx.host.heartbeat!.recoverClosedRuns();
    assert.equal(ctx.projections().n, 1);
    assert.equal(ctx.wire.length, 0);"""
additional="""
    const packet = ctx.host.db.prepare("select window_id,payload_json from provider_requests where background_run_id=? and sent_at is not null order by rowid desc limit 1").get(run.id);
    const count = (ms:any[]) => ({
      cardResults:ms.filter(m=>m.role==='tool' && m.tool_call_id==='draw-1' && JSON.stringify(m.content).includes(REVEAL)).length,
      drawCalls:ms.flatMap(m=>m.tool_calls??[]).filter(c=>c.id==='draw-1').length
    });
    const before=count(JSON.parse(String(packet!.payload_json)).messages);
    const canonical=count(ctx.trajectory.forWindow(ctx.windowId())!.messages);
    await ctx.chat('恢复后正常聊天');
    console.log('EDGE '+JSON.stringify({before,canonical,next:count(ctx.wire.at(-1)!.messages),projectionActions:projection.actions.map((a:any)=>[a.kind,a.status]),sameWindow:ctx.host.windows.activeWindow('primary')?.id===packet!.window_id,newCalls:ctx.wire.length}));
"""
run_one('mid_turn_crash',crash,[(hook,hook+additional)],['--test-name-pattern=^heartbeat: a committed memory action is projected on restart without replaying the model$'])

source=repo/'tests/integration/heartbeat-source-adapters.test.ts'
hook="  const memoryRef = refs.find(ref=>ref.source.kind === 'memory')!;"
extra="""
  const livingCard=refs.find(ref=>ref.source.kind==='ext:living-room')!;
  target=livingCard.number;operation='edge-living-draw';await chatAndHeartbeat();
  const event=host.db.prepare("select run_id from heartbeat_draw_operations where operation_id=? and state='delivered'").get(operation)!;
  const display=()=>req('/background/heartbeat/cards/'+event.run_id);
  const before=(await display()).status;
  await req('/background/settings','PUT',{keepwarm:{include_living_room:false}},'edge-candidate-off',2);
  const after=(await display()).status;
  const live=await req('/content/moments-external/'+livingCard.source.id);
  console.log('EDGE '+JSON.stringify({before,after,sourceId:live.id??live.item?.id??null,originalId:livingCard.source.id,objectKeys:Object.keys(live)}));
  return;
"""
run_one('living_history',source,[(hook,extra+hook)])

joint=repo/'docs/reports/JOINT_AUDIT_20261121/probes/joint.mjs'
hook="  if (batch===3 && ending==='text')"
insert="""  if (batch===3 && ending==='edge-wake')return {calls:[call('wake_manage',{operation:'schedule',operation_id:'edge-future',delay_seconds:3600,note:'合成自约'})]};\n"""
setting="patch:{keepwarm_enabled:true,keepwarm_daily_cost_cap_usd:5}"
end="  phase='after';metrics.nextChat=await chat();"
extra="""
  if(ending==='edge-wake'){
    const stored=db.prepare("select id,origin,created_by_actor_id from background_tasks where origin='self_schedule'").all();
    const schema=metrics.results.find(x=>x.names)?.names??[];
    console.log('EDGE '+JSON.stringify({catalog:schema.includes('wake_manage'),tasks:stored.length,actor:stored[0]?.created_by_actor_id,receipts:metrics.results.filter(x=>x.keys.includes('task_id')).length,actions:projections[0]?.actions.map(x=>x.kind),feed:metrics.feed[0]?.blocks.map(x=>x.label)}));
  }
"""
run_one('self_schedule_projection',joint,[(hook,insert+hook),(setting,'patch:{keepwarm_enabled:true,keepwarm_daily_cost_cap_usd:5,autonomous_enabled:true,autonomous_daily_cost_cap_usd:5}'),(end,extra+end)],['api','direct','edge-wake'])

joint=repo/'docs/reports/JOINT_AUDIT_20261121/probes/joint.mjs'
changes=[
 ("ending==='album'?[]:shared","['album','pre-reveal'].includes(ending)?[]:shared"),
 ("  metrics.firstChat=await chat();","""  for(let i=0;i<10;i++){
    const resp=await fetch(fixtureBase+'/api/v1/content/future-notes',{method:'POST',headers:{...fixtureAuth,'Idempotency-Key':'edge-note-'+i,'Content-Type':'application/json'},body:JSON.stringify({body:'合成留言 '+i})});assert.equal(resp.status,201);
  }
  metrics.firstChat=await chat();"""),
 ("  if (batch===2) return", """  if(batch===2 && ending==='pre-reveal')return {calls:[call('chat_send_text',{text:'合成：我现在去抽牌',idempotency_key:'before-reveal'}),call('heartbeat_draw',{card_number:1})]};
  if(batch===3 && ending==='pre-reveal')return {calls:[call('background_complete',{outcome:'noop'})]};
  if (batch===2) return"""),
 ("  phase='after';metrics.nextChat=await chat();","""  const fromPool=await host.heartbeat.sources.choose('primary',s=>host.heartbeat.cards.isSourceEligible(s),AbortSignal.timeout(3000));
  const replay=fromPool.find(s=>s.replay==='first_reserved_response');
  const replayPayload=replay?await host.heartbeat.sources.resolve(replay,'primary',AbortSignal.timeout(3000)):null;
  console.log('EDGE '+JSON.stringify({order:metrics.publishedOrder,delivered:metrics.draw,state:projections[0]?.state,terminal:projections[0]?.terminal,kind:projections[0]?.card?.source.kind,sourceQualified:!!replay,usesPreDrawMessage:replayPayload?.text?.includes('合成：我现在去抽牌')??false}));
  phase='after';metrics.nextChat=await chat();""")]
run_one('reserved_note_reply_boundary',joint,changes,['api','direct','pre-reveal'])

# A real cold SDK session, with the external query boundary still synthetic.
code=joint.read_text()
def replace(before, after):
 global code
 assert code.count(before)==1
 code=code.replace(before,after)
replace("await content.start();writeApprovedIdentity(root);","await content.start();if(ending!=='cold')writeApprovedIdentity(root);")
replace("yield* scriptedSdkInput(input,session,()=>{})","yield* scriptedSdkInput(input,session,(_frame,history)=>{if(ending==='cold')metrics.sdkReplayedDraw=history.some(m=>JSON.stringify(m).includes('heartbeat_card'));})")
hook="  const remote=host.heartbeat.sources.external.memory;"
replace(hook,"""  if(ending==='cold'){
    const db=host.db;
    const record=db.prepare("select window_id,turn_id,payload_json from provider_requests where background_run_id is not null and sent_at is not null order by rowid desc limit 1").get();
    const seen=JSON.parse(record.payload_json).messages;
    const hasDraw=ms=>ms.some(m=>m.role==='tool'&&JSON.stringify(m.content).includes('heartbeat_card'));
    const recovered=JSON.parse(db.prepare('select messages_json from window_trajectories where window_id=?').get(record.window_id).messages_json);
    const message=host.messages.submitUserMessageWithTurn({conversationId:'primary',content:'合成重启后自然消息',clientMessageId:randomUUID()});
    host.supervisor.enqueue(message.turnId);await host.supervisor.waitIdle();
    const actual=db.prepare('select window_id,payload_json from provider_requests where turn_id=? and sent_at is not null order by rowid desc limit 1').get(message.turnId);
    console.log('EDGE '+JSON.stringify({before:hasDraw(seen),canonical:hasDraw(recovered),next:hasDraw(JSON.parse(actual.payload_json).messages),replayedInSdkHistory:metrics.sdkReplayedDraw,sameWindow:record.window_id===actual.window_id,sessionResumed:metrics.sessions[0].resume,newQueries:metrics.sessions.length}));
  } else {
    const execute=db.exec.bind(db);
    db.exec=sql=>{
      execute(sql);
      if(sql==='COMMIT'&&phase==='heart'&&db.prepare("select 1 from heartbeat_actions where json_extract(action_json,'$.kind')='memory_hold' and json_extract(action_json,'$.status')='committed'").get())process.kill(process.pid,'SIGKILL');
    };
"""+hook)
replace("}catch(e){metrics.exceptions.push(String(e.stack));","  }\n}catch(e){metrics.exceptions.push(String(e.stack));")
with tempfile.TemporaryDirectory(prefix='est-cold-sdk-') as work:
 root=Path(work);(root/'host').mkdir();(root/'tmp').mkdir()
 script=root/'audit.mjs';script.write_text(code)
 env=dict(HOME=work,ESTOMAGO_HOME=str(root/'host'),TMPDIR=str(root/'tmp'),ESTOMAGO_TEST_MODE='1',PATH='/opt/homebrew/bin:/usr/bin:/bin',NODE_OPTIONS='--require='+str(here/'local-only.cjs'))
 for stage in ['crash','cold']:
  rc,out=run(['node',str(script),'sdk','direct',stage],env,35)
  if stage=='crash':assert rc==-9,(rc,out[-800:])
  else:
   lines=[l for l in out.splitlines() if l.startswith('EDGE ')]
   assert rc==0 and len(lines)==1,(rc,out[-1000:])
   print(lines[0],'group_empty',flush=True)
