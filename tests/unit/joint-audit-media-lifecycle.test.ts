import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDatabase} from '../../apps/host/src/db/connection.ts';
import {migrate} from '../../apps/host/src/db/migrations.ts';
import {sha256Hex} from '../../apps/host/src/util/id.ts';
import {buildConfig} from '../../apps/host/src/config/schema.ts';
import {MediaService} from '../../apps/host/src/media/assets.ts';
import {MessageService} from '../../apps/host/src/messages/service.ts';
import {MediaIndexService, MediaEmbedWorkerClient} from '../../apps/host/src/media/index/service.ts';
import {EstomagoClient} from '../../apps/web/react/src/chat-client.ts';

for(const mutation of ['delete','revision','cancel'] as const) test(`index result cannot resurrect after ${mutation}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'joint-index-'));const db=openDatabase(root);migrate(db,sha256Hex);
  const media=new MediaService(db,path.join(root,'media'),buildConfig({}));
  const asset=await media.saveBuffer({bytes:Buffer.from([0x89,0x50,0x4e,0x47,0,0,0,0]),purpose:'chat_image',operationId:'test-image',createdBy:'synthetic-owner',origin:'upload'});
  let release!:(v:any)=>void;const pending=new Promise<any>(resolve=>{release=resolve;});
  const worker={embed:()=>pending} as unknown as MediaEmbedWorkerClient;
  const index=new MediaIndexService(db,media,worker);const controller=new AbortController();
  try {
    const job=index.indexImage(asset.id,controller.signal);
    if(mutation==='delete')db.prepare("UPDATE media_assets SET state='missing' WHERE id=?").run(asset.id);
    else if(mutation==='revision')db.prepare("UPDATE media_assets SET content_sha256='changed' WHERE id=?").run(asset.id);
    else controller.abort();
    const vec=new Float32Array(768);vec[0]=1;release({fingerprint:'synthetic-test',vectors:new Map([[asset.id,vec]])});
    if(mutation==='cancel')await assert.rejects(job,{name:'AbortError'});
    else assert.equal((await job).indexed,false);
    assert.equal((db.prepare('SELECT count(*) AS n FROM media_embedding_index').get() as {n:number}).n,0);
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('removed upload cannot dispatch later ASR',async()=>{
  let release!:(r:Response)=>void;const calls:string[]=[];
  const client=new EstomagoClient({fetch:(async(url:any)=>{calls.push(String(url));if(String(url).includes('/assets?'))return await new Promise<Response>(resolve=>{release=resolve;});return Response.json({});}) as typeof fetch});
  const job=client.queue(new Blob(['synthetic']),'synthetic','voice');
  client.removeAttachment(client.snapshot.attachments[0].id);
  release(Response.json({asset_id:'asset-synthetic'}));await job;
  assert.equal(calls.filter(x=>x.endsWith('/transcribe')).length,0);
  assert.equal(client.snapshot.attachments.length,0);client.stop();
});

for(const mutation of ['message-revision','asset-revision'] as const)test(`image search excludes stale ${mutation}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'joint-index-read-'));const db=openDatabase(root);migrate(db,sha256Hex);
  const media=new MediaService(db,path.join(root,'media'),buildConfig({}));
  const messages=new MessageService(db);messages.ensureConversation('primary');
  const asset=await media.saveBuffer({bytes:Buffer.from([0x89,0x50,0x4e,0x47,0,0,0,0]),purpose:'chat_image',operationId:'test-image',createdBy:'synthetic-owner',origin:'upload'});
  const message=messages.publishAssistantMessage({conversationId:'primary',turnId:'test-turn',content:'',kind:'text',clientMessageId:'test-msg',attachments:[{asset_id:asset.id,presentation:'image'}]});
  const vector=new Float32Array(768);vector[0]=1;
  const worker={embed:async(items:any[])=>({fingerprint:'synthetic-test',vectors:new Map(items.map(i=>[i.id,vector]))})} as unknown as MediaEmbedWorkerClient;
  const index=new MediaIndexService(db,media,worker);
  try{
    await index.indexImage(asset.id);assert.equal((await index.searchImagesByRoom('synthetic','primary')).state,'candidates');
    if(mutation==='message-revision')db.prepare('UPDATE messages SET current_revision=2 WHERE id=?').run(message.id);
    else db.prepare("UPDATE media_assets SET content_sha256='new-revision' WHERE id=?").run(asset.id);
    assert.equal((await index.searchImagesByRoom('synthetic','primary')).state,'no_match');
    assert.deepEqual(index.unindexedImagesInRoom('primary','synthetic-test'),mutation==='asset-revision'?[asset.id]:[]);
  }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('worker redirect cannot forward media bytes to another route',async()=>{
  const {createServer}=await import('node:http');let leaked=0;
  const server=createServer((req,res)=>{req.resume();if(req.url==='/v1/embed'){res.writeHead(307,{Location:'/capture'});res.end();}else{leaked++;res.writeHead(503);res.end();}});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{const address=server.address() as {port:number};const client=new MediaEmbedWorkerClient({base_url:`http://127.0.0.1:${address.port}`});await assert.rejects(client.embed([{id:'synthetic',modality:'text',bytes:Buffer.from('合成隐私边界夹具')} ]));assert.equal(leaked,0);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
