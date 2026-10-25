import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tempRoot, writeApprovedIdentity, readyRuntimePatch } from '../helpers.ts';
import { Host } from '../../apps/host/src/app-context.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { freezeWindowTools } from '../../apps/host/src/runtime/tool-discovery.ts';

// Actual HTTP management service; model dispatch is not part of this read/control contract.
test('后台管理HTTP：严验设置、同键重放、任务与运行完整分页、按冻结目录报告能力', async t => {
  const root=tempRoot('audit-bg-management-');writeApprovedIdentity(root);
  const host=await Host.create({stateRoot:root,config:buildConfig({...readyRuntimePatch(),runtime:{...readyRuntimePatch().runtime as object,provider:'mock'},deployment:{port:0}}),logDir:null,bind:'127.0.0.1',port:0});
  await host.start();
  t.after(async()=>{await host.stop();fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${host.port}`;
  const token=fs.readFileSync(path.join(root,'config/auth.token'),'utf8').trim();
  const request=async(url:string,method='GET',body?:unknown,key='op',revision=0)=>{
    const r=await fetch(base+'/api/v1'+url,{method,headers:{Authorization:`Bearer ${token}`,Origin:base,'Content-Type':'application/json','Idempotency-Key':key,'If-Match':`"${revision}"`},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,body:await r.json() as any};
  };
  assert.equal((await request('/background/settings','PUT',{autonomous:{enabled:'true',daily_cost_cap_usd:2}},'invalid')).status,422);
  assert.equal((await request('/background/settings')).body.revision,0);
  assert.equal((await request('/background/settings','PUT',{autonomous:{enabled:true,daily_cost_cap_usd:2}},'enable')).status,200);
  const replay=await request('/background/settings','PUT',{autonomous:{enabled:true,daily_cost_cap_usd:2}},'enable');
  assert.equal(replay.status,200);assert.equal(replay.body.duplicate,true);assert.equal(replay.body.revision,1);
  assert.equal((await request('/background/settings','PUT',{autonomous:{enabled:false}},'enable')).status,409);
  const ids:string[]=[];
  for(let i=0;i<23;i++){const r=await request('/background/tasks','POST',{note:`合成预约${i}`,delay_seconds:3600+i},`create-${i}`);assert.equal(r.status,201);ids.push(r.body.task_id);}
  const first=(await request('/background/tasks')).body;assert.equal(first.tasks.length,20);assert.ok(first.next_cursor);
  const second=(await request('/background/tasks?cursor='+encodeURIComponent(first.next_cursor))).body;
  assert.equal(second.tasks.length,3);assert.equal(second.next_cursor,null);assert.equal(new Set([...first.tasks,...second.tasks].map((r:any)=>r.task_id)).size,23);
  const stamp=new Date().toISOString();
  for(let i=0;i<23;i++)host.db.prepare("INSERT INTO background_runs(id,task_id,conversation_id,actor_id,kind,task_revision,occurrence_key,scheduled_for,state,settings_revision,created_at,updated_at) VALUES (?,?,'primary','jiaming','autonomous',1,?,?,'completed',1,?,?)").run(`run-${String(i).padStart(2,'0')}`,ids[i],`occ-${i}`,stamp,stamp,stamp);
  const runs1=(await request('/background/runs')).body;assert.equal(runs1.runs.length,20);assert.ok(runs1.next_cursor);
  const runs2=(await request('/background/runs?cursor='+encodeURIComponent(runs1.next_cursor))).body;
  assert.equal(runs2.runs.length,3);assert.equal(runs2.next_cursor,null);assert.equal(new Set([...runs1.runs,...runs2.runs].map((r:any)=>r.id)).size,23);
  assert.equal((await request('/background/runs?cursor=broken')).status,400);
  assert.equal((await request('/background/settings')).body.current_window.wake_manage_available,null);
  host.db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES ('old-window','primary','ACTIVE',?,?)").run(stamp,stamp);
  host.db.prepare("UPDATE conversations SET active_window_id='old-window' WHERE id='primary'").run();
  freezeWindowTools(host.db,'old-window',[],'deferred');
  const before=host.db.prepare("SELECT * FROM window_toolsets WHERE window_id='old-window'").get();
  const status=(await request('/background/settings')).body.current_window;
  assert.equal(status.wake_manage_available,false);assert.equal(status.requires_normal_rotation,true);
  assert.deepEqual(host.db.prepare("SELECT * FROM window_toolsets WHERE window_id='old-window'").get(),before);
  assert.equal((host.db.prepare('SELECT count(*) n FROM provider_requests').get() as {n:number}).n,0);
});
