import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {tempRoot } from '../helpers.ts';

test('实际Host/HTTP/SSE/前端client：模型预约管理→自然15秒调度→正式发言→重连→下一轮', { timeout: 45000 }, async t => {
  const out=tempRoot('audit-product-evidence-');t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
  const child=spawn(process.execPath,['scripts/audit/background-product.ts','--scenario=idle'],{cwd:path.resolve(import.meta.dirname,'../..'),env:{...process.env,AUDIT_FRONTEND_OUT:out},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',data=>{log+=String(data)});child.stderr.on('data',data=>{log+=String(data)});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM')});
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  assert.equal(code,0,log);
  const summary=JSON.parse(fs.readFileSync(path.join(out,'product-summary.json'),'utf8'));
  assert.equal(summary.results.length,1);assert.equal(summary.results[0].passed,true);
  assert.equal(summary.max_concurrent_model_requests,1);
  assert.equal(summary.results[0].run.state,'completed');
  assert.equal(summary.results[0].published.length,1);
  assert.ok(summary.results[0].latency_ms.scheduler_claim>=0);
  assert.equal(summary.results[0].static.status,200);
  assert.equal(summary.results[0].static.versioned_js,true);
});

test('实际Host心跳：拒抽无补话，十张真实交付后下一心跳的 1 经 SSE 可见', () => {
  const out=tempRoot('audit-heartbeat-evidence-');
  try {
    const result=spawnSync(process.execPath,['scripts/audit/background-product.ts','--heartbeat'],{cwd:path.resolve(import.meta.dirname,'../..'),env:{...process.env,AUDIT_FRONTEND_OUT:out},encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stdout+result.stderr);
    const evidence=JSON.parse(fs.readFileSync(path.join(out,'heartbeat.json'),'utf8'));
    assert.equal(evidence.passed,true);assert.equal(evidence.virtual_clock,true);
    assert.deepEqual(evidence.cases.map((c:any)=>c.mode),['declined',...Array(10).fill('drawn'),'exhausted']);
    assert.deepEqual(evidence.cases.map((c:any)=>c.request_count),[1,...Array(10).fill(2),1]);
    assert.deepEqual(evidence.cases.map((c:any)=>c.messages_after-c.messages_before),[2,3,...Array(9).fill(2),2]);
    assert.ok(evidence.cases.every((c:any)=>c.run.retention==='retained'));
  } finally { fs.rmSync(out,{recursive:true,force:true}); }
});
