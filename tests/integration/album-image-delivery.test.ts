import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeDb, assembleTestTools } from '../helpers.ts';
import { ContentServer } from '../../apps/content/src/service.ts';
import { contentForward } from '../../apps/host/src/integrations/content/client.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MediaToolsService } from '../../apps/host/src/modules/media/service.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { createEstSdkMcp } from '../../apps/host/src/runtime/sdk-mcp.ts';
import { SdkHistoryReplay } from '../../apps/host/src/runtime/sdk-history.ts';
import { buildDeferredTools, freezeWindowTools, storedToolset, definitionId, recordToolContext } from '../../apps/host/src/runtime/tool-discovery.ts';
import { materializeEnvelope, toolResultContent } from '../../apps/host/src/media/model-input.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII=', 'base64');

test('相册/朋友圈多页稳定倒序；真实图片进入 MCP、API 与历史回放，撤销后不可再读', async t => {
  const { db, root } = makeDb();
  const server = new ContentServer({stateRoot:path.join(root,'content'),port:0});
  await server.start();
  t.after(async () => { await server.stop(); db.close(); fs.rmSync(root,{recursive:true,force:true}); });
  const client = {baseUrl:`http://127.0.0.1:${server.port}`,token:server.token};
  const media = new MediaService(db,path.join(root,'media'),buildConfig());
  const svc = new MediaToolsService({db,media,contentClient:client});
  const messages = new MessageService(db); messages.ensureConversation('room');
  const call = (method:'GET'|'POST'|'DELETE',url:string,body?:Record<string,unknown>,key='test') =>
    contentForward(client,{method,path:'/api/v1/content'+url,actor:'jiaming',body,
      headers:{'Idempotency-Key':key,'If-Match':'"1"'}});
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-04T00:00:00Z')});
  const posts:any[] = [], entries:any[] = [], assets:string[] = [];
  for (let i=0;i<7;i++) {
    const asset = await media.saveBuffer({bytes:Buffer.concat([PNG,Buffer.from([i])]),purpose:'chat_image',operationId:`asset-${i}`,createdBy:'jiaming',origin:'upload'});
    assets.push(asset.id);
    const post = await call('POST','/posts',{body:`合成${i}`},`post-${i}`);
    const entry = await call('POST','/albums/important_photos/entries',{asset_id:asset.id,caption:`合成${i}`},`album-${i}`);
    assert.equal(post.status,201); assert.equal(entry.status,201);
    posts.push(post.body); entries.push(entry.body);
  }
  for (const [route, expected] of [['/posts',posts],['/albums/important_photos/entries',entries]] as const) {
    let page = await call('GET',route+'?limit=2');
    const seen = [...(page.body as any).items];
    const cursor = (page.body as any).next_cursor;
    t.mock.timers.setTime(Date.now()+1000);
    if (route==='/posts') await call('POST',route,{body:'新插入项'},'new-post');
    else await call('POST',route,{asset_id:'newer-synthetic-asset',caption:'新插入项'},'new-album');
    while ((page.body as any).next_cursor) {
      page = await call('GET',route+'?limit=2&cursor='+encodeURIComponent((page.body as any).next_cursor));
      assert.equal(page.status,200); seen.push(...(page.body as any).items);
      assert.ok(seen.length<=7,'pagination must progress');
    }
    assert.deepEqual(seen.map(x=>x.id),expected.map(x=>x.id).sort().reverse());
    assert.equal(new Set(seen.map(x=>x.id)).size,7);
    const other = route==='/posts' ? '/posts?presentation=letter' : '/albums/stickers/entries?';
    assert.equal((await call('GET',other+(other.endsWith('?')?'':'&')+'cursor='+encodeURIComponent(cursor))).status,400);
  }
  const image = assets[0]!;
  assert.deepEqual((await svc.readImage(image,'room')).bytes,Buffer.concat([PNG,Buffer.from([0])]));
  const draft = await media.saveBuffer({bytes:PNG,purpose:'chat_image',operationId:'draft',createdBy:'jiaming',origin:'upload'});
  await assert.rejects(svc.readImage(draft.id,'room'),(e:any)=>e.code==='ASSET_NOT_READABLE');
  messages.publishAssistantMessage({conversationId:'room',turnId:'synthetic-turn',content:'已发布合成图',kind:'text',clientMessageId:'published',attachments:[{asset_id:draft.id,presentation:'image'}]});
  assert.deepEqual((await svc.readImage(draft.id,'room')).bytes,PNG);
  await assert.rejects(svc.readImage(draft.id,'other-room'),(e:any)=>e.code==='ASSET_NOT_READABLE');

  const submitted=messages.submitUserMessageWithTurn({conversationId:'room',content:'合成看图',clientMessageId:'view-request'});
  db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES('image-window','room','ACTIVE','now','now')").run();
  const {tools,registry}=assembleTestTools({db,media,messages,contentClient:client});
  const spec=freezeWindowTools(db,'image-window',registry.currentCatalog(),'deferred',registry.currentGroups());
  const snapshot=storedToolset(db,'image-window')!;
  const requestMessages=[{role:'system',content:snapshot.initialText},{role:'user',content:'合成看图'}];
  db.prepare("INSERT INTO provider_requests(id,window_id,attempt_id,turn_id,purpose,seen_manifest_json,payload_json,sent_at,created_at) VALUES('image-request','image-window',?,?,'chat','[]',?,'now','now')").run(submitted.attemptId,submitted.turnId,JSON.stringify({tools:spec,messages:requestMessages}));
  recordToolContext(db,'image-request','image-window',requestMessages);
  const context={roomId:'room',windowId:'image-window',requestId:'image-request',turnId:submitted.turnId,purpose:'chat' as const,seenMessages:[],seenSequence:0,activeReviewId:null};
  const defineId=(name:string)=>definitionId(snapshot.catalog.find(s=>s.function.name===name)!);
  const album=await tools.execute('tool_invoke',{name:'content_albums_read',definition_id:defineId('content_albums_read'),arguments:{album:'important_photos'}},context);
  assert.equal(album.ok,true,JSON.stringify(album));
  const readable=(album.output.items as any[]).find(entry=>entry.asset_ref===`est:${image}`);
  assert.ok(readable);
  let stored:any;
  const mcp = createEstSdkMcp(spec,async (name,args) => {
    const result = await tools.execute(name,args,context);
    return {...result,recordDelivery:(delivered:any)=>{stored=toolResultContent(delivered);}};
  }, id => svc.readImage(id,'room'));
  const [a,b] = InMemoryTransport.createLinkedPair();
  const sdk = new Client({name:'synthetic',version:'1'});
  await mcp.instance.connect(b); await sdk.connect(a);
  const result = await sdk.callTool({name:'tool_invoke',arguments:{name:'media_view',definition_id:defineId('media_view'),arguments:{asset_ref:readable.asset_ref}}});
  assert.equal(result.isError,false);
  assert.ok((result.content as any[]).some(c=>c.type==='image'&&c.mimeType==='image/png'&&Buffer.from(c.data,'base64').equals(Buffer.concat([PNG,Buffer.from([0])]))));
  await sdk.close();
  assert.ok(JSON.stringify(stored).includes('asset_image'));
  assert.ok(!JSON.stringify(stored).includes(PNG.toString('base64').slice(0,30)));
  const history:any[] = [{role:'assistant',content:'',tool_calls:[{id:'image-call',function:{name:'tool_invoke',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'image-call',content:stored}];
  const envelope = await materializeEnvelope({messages:history},media,id=>svc.readImage(id,'room'));
  assert.equal(envelope.messages[1].content[1].type,'image');
  const replay = new SdkHistoryReplay(history,new AbortController().signal,id=>svc.readImage(id,'room'));
  const frames = replay.input(); await frames.next();
  const frame:any = (await frames.next()).value;
  assert.equal(frame.message.content[0].type,'tool_result');
  assert.equal(frame.message.content[0].content[1].type,'image');
  console.log(JSON.stringify({evidence:'A14 fake MCP / API / SDK replay',mcp:(result.content as any[]).map(c=>({type:c.type,...(c.type==='image'?{mimeType:c.mimeType,bytes:Buffer.from(c.data,'base64').length}:{})})),api:envelope.messages[1].content.map((c:any)=>c.type),sdk_replay:frame.message.content[0].content.map((c:any)=>c.type),persistent_history_has_base64:false}));
  replay.consume({type:'result',subtype:'success',is_error:false} as any);
  await frames.next(); replay.close();
  await call('DELETE',`/album-entries/${entries[0].id}`,{},'remove-entry');
  await assert.rejects(materializeEnvelope({messages:history},media,id=>svc.readImage(id,'room')),(e:any)=>e.code==='ASSET_NOT_READABLE');
  const revoked = new SdkHistoryReplay(history,new AbortController().signal,id=>svc.readImage(id,'room'));
  const denied = revoked.input(); await denied.next();
  await assert.rejects(denied.next(),(e:any)=>e.code==='ASSET_NOT_READABLE'); revoked.close();
});

test('SDK 缺图片物化能力时回真实错误，不能记录成功看图', async () => {
  let recorded:any;
  const mcp=createEstSdkMcp(buildDeferredTools(),async()=>({ok:true,output:{asset_ref:'est:synthetic'},imageRefs:['synthetic'],recordDelivery:r=>{recorded=r;}}));
  const [a,b]=InMemoryTransport.createLinkedPair(); const client=new Client({name:'synthetic',version:'1'});
  await mcp.instance.connect(b); await client.connect(a);
  try {
    const result=await client.callTool({name:'tool_invoke',arguments:{}});
    assert.equal(result.isError,true); assert.equal(recorded.ok,false);
    assert.equal(recorded.output.error_code,'SDK_MEDIA_TRANSPORT_UNVERIFIED');
    assert.ok(!(result.content as any[]).some(b=>b.type==='image'));
  } finally {await client.close();}
});
