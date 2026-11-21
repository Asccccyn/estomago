import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const {chromium}=await import(process.env.EST_AUDIT_PLAYWRIGHT);
const mod=p=>import(path.resolve(p));
const {Host}=await mod('apps/host/src/app-context.ts'), {buildConfig}=await mod('apps/host/src/config/schema.ts');
const {ContentServer}=await mod('apps/content/src/service.ts'), {writeApprovedIdentity,readyRuntimePatch}=await mod('tests/helpers.ts');
const root=process.env.ESTOMAGO_HOME;
assert.ok(root.startsWith(process.env.HOME+'/') && process.env.ESTOMAGO_TEST_MODE==='1');
const content=new ContentServer({stateRoot:path.join(root,'content'),port:0});let host,browser;
const facts={status:[],uploads:0};
try{
 await content.start();writeApprovedIdentity(root);const ready=readyRuntimePatch();
 const config=buildConfig({...ready,runtime:{...ready.runtime,provider:'mock'},content:{enabled:true,port:content.port}});
 host=await Host.create({stateRoot:root,config,logDir:null,bind:'127.0.0.1',port:0});
 host.heartbeat.media.mStore={uploadBytes:async b=>{facts.uploads++;return {content_hash:createHash('sha256').update(b).digest('hex')};}};
 await host.start();const origin='http://127.0.0.1:'+host.port;
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking','--disable-component-update','--no-first-run','--proxy-server=http://127.0.0.1:1','--proxy-bypass-list=127.0.0.1']});
 const context=await browser.newContext({viewport:{width:1600,height:950},serviceWorkers:'block'});
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(4500);
 await page.goto(origin+'/login');
 await page.evaluate(async token=>{const r=await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});if(!r.ok)throw Error('login failed');},fs.readFileSync(path.join(root,'config/auth.token'),'utf8').trim());
 await page.goto(origin+'/');
 await page.getByRole('button',{name:'相册',exact:true}).click();
 await page.waitForURL('**/home/album');facts.status.push('home-click-to-album');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYTUAAAAASUVORK5CYII=','base64');
 const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
 const upload=async (label,file)=>{
 await page.getByRole('button',{name:label,exact:true}).waitFor();
 await page.locator('input[type=file]').setInputFiles(file);
 };
 let denyFirst=true;const relationKeys=[];
 await page.route('**/api/v1/content/albums/important_photos/entries',async r=>{
   if(r.request().method()==='POST'){relationKeys.push(r.request().headers()['idempotency-key']);if(denyFirst){denyFirst=false;return r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'synthetic_relation_offline'}})});}}
   return r.continue();
 });
 await upload('上传图片到此相册',{name:'synthetic.png',mimeType:'image/png',buffer:png});
 await page.getByText('synthetic_relation_offline',{exact:false}).waitFor();
 await page.reload();await page.getByRole('button',{name:'继续入库'}).click();
 await page.getByLabel('预览图片').first().waitFor();
 facts.retry={uploads:facts.uploads,requests:relationKeys.length,sameKey:relationKeys.length===2 && relationKeys[0]===relationKeys[1]};
 await page.reload();
 const preview=page.getByLabel('预览图片').first();await preview.waitFor();
 const src=await preview.getAttribute('href');
 const popup=context.waitForEvent('page');await preview.click();const img=await popup;await img.waitForLoadState();assert.equal(new URL(img.url()).pathname,new URL(src,origin).pathname);await img.close();
 facts.status.push('photo-saved-refreshed-preview');
 await page.getByRole('button',{name:'入表情',exact:true}).click();
 await page.waitForResponse(r=>r.url().includes('/albums/stickers/entries')&&r.request().method()==='POST',{timeout:800}).catch(()=>{});
 await page.getByRole('tab',{name:'表情包'}).click();await page.getByLabel('预览图片').first().waitFor();
 await upload('上传表情',{name:'synthetic.gif',mimeType:'image/gif',buffer:gif});
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label="预览图片"]').length===2);
 await page.reload();await page.getByRole('tab',{name:'表情包'}).click();await page.waitForFunction(()=>document.querySelectorAll('[aria-label="预览图片"]').length===2);
 facts.status.push('same-photo-two-collections-and-independent-gif');
 await page.getByRole('tab',{name:'我们的相册'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label="预览图片"]').length===1);page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'移除'}).click();
 await page.getByText('此相册还没有图片',{exact:true}).waitFor();
 await page.getByRole('tab',{name:'表情包'}).click();await page.waitForFunction(()=>document.querySelectorAll('[aria-label="预览图片"]').length===2);
 facts.status.push('removed-photo-preserved-sticker');
 await upload('上传表情',{name:'invalid.gif',mimeType:'image/gif',buffer:Buffer.from('invalid')});
 facts.errorDisplayed=(await page.getByRole('alert').innerText()).slice(0,180);
 await page.getByRole('button',{name:'结束此次操作'}).click();
 await page.getByRole('tab',{name:'作品'}).click();await page.getByText('还没有作品',{exact:false}).waitFor();
 facts.worksControls=await page.getByRole('dialog').getByRole('button').allTextContents();
 await upload('导入 HTML / SVG 代码作品',{name:'synthetic.html',mimeType:'text/html',buffer:Buffer.from('<!doctype html><html><body>synthetic work</body></html>')});
 await page.getByText('synthetic.html',{exact:false}).waitFor();
 await page.reload();await page.getByRole('tab',{name:'作品'}).click();
 const workPreview=page.getByRole('link',{name:'沙箱预览打开',exact:false});await workPreview.waitFor();
 const workPopup=context.waitForEvent('page');await workPreview.click();const work=await workPopup;await work.waitForLoadState();
 assert.ok(work.url().endsWith('/preview'));await work.close();
 await page.getByRole('button',{name:'移除作品',exact:true}).click();
 await page.getByText('还没有作品',{exact:false}).waitFor();
 facts.status.push('code-work-import-refresh-preview-remove');
 for(const section of ['heartbeat','moments']){
   await page.goto(origin+'/');
   if(section==='heartbeat')await page.locator('#home-heartbeat').click();
   else await page.locator('[data-action=moments]').first().click();
   await page.getByRole('button',{name:section==='heartbeat'?'新增留言':'发布帖子'}).click();
   await page.locator('textarea').fill('合成页面新增');await page.locator('button[type=submit]').click();
   await page.getByText('合成页面新增',{exact:true}).waitFor();
   await page.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('textarea').fill('合成页面修订');
   await page.locator('button[type=submit]').click();await page.getByText('合成页面修订',{exact:true}).waitFor();
   await page.reload();await page.getByText('合成页面修订',{exact:true}).waitFor();
   if(section==='heartbeat'){
     const noteId=await page.evaluate(async()=>{const list=await (await fetch('/api/v1/content/future-notes')).json();return list.items.find(row=>row.body==='合成页面修订')?.id;});
     assert.ok(noteId);await page.goto(origin+'/home/heartbeat?note='+encodeURIComponent(noteId));
     await page.getByText('从朋友圈定位的原留言',{exact:true}).waitFor();await page.getByText('合成页面修订',{exact:true}).waitFor();
     facts.status.push('heartbeat-source-id-navigation');
   }
   await page.getByRole('button',{name:'删除',exact:true}).click();await page.getByText('合成页面修订',{exact:true}).waitFor({state:'detached'});
   facts.status.push(section+'-create-edit-refresh-delete');
 }
 facts.providerRequests=host.db.prepare('select count(*) n from provider_requests').get().n;
 facts.turns=host.db.prepare('select count(*) n from turns').get().n;
 const isolatedToken=fs.readFileSync(path.join(root,'config/auth.token'),'utf8').trim();
 const statuses=[];for(const purpose of ['chat_image','chat_sticker']){
   const r=await fetch(origin+'/api/v1/assets?purpose='+purpose,{method:'POST',headers:{Authorization:'Bearer '+isolatedToken,Origin:origin,'Content-Type':'application/octet-stream','Idempotency-Key':'synthetic-comparison'},body:gif});
   const data=await r.json();statuses.push({status:r.status,id:data.asset_id});
 }
 facts.reusedPurpose={statuses:statuses.map(x=>x.status),sameId:statuses[0].id===statuses[1].id};
 assert.deepEqual(facts.reusedPurpose.statuses,[201,409]);
 const pngId=host.db.prepare("select id from media_assets where mime_type='image/png'").get().id;
 const response=await fetch(origin+'/api/v1/content/creations',{method:'POST',headers:{Authorization:'Bearer '+isolatedToken,Origin:origin,'Idempotency-Key':'fixture-raster-work','Content-Type':'application/json'},body:JSON.stringify({work_asset_id:pngId,icon_asset_id:pngId,work_kind:'image',title:'合成图片画作'})});
 const creation=await response.json();facts.oldCreation={status:response.status,error:creation.error?.code,kind:creation.work_kind};
 const visible=await fetch(origin+'/api/v1/content/creations?limit=50',{headers:{Authorization:'Bearer '+isolatedToken}});
 facts.oldCreation.listed=(await visible.json()).items?.some(x=>x.id===creation.id)??false;
 assert.equal(facts.oldCreation.status,422);assert.equal(facts.oldCreation.listed,false);
 facts.media=host.db.prepare("select mime_type,m_sync_state,count(*) n from media_assets group by 1,2").all();
} catch(e){facts.error=String(e.message);process.exitCode=1;}finally{await browser?.close();await host?.stop();await content.stop();console.log(JSON.stringify(facts));}
