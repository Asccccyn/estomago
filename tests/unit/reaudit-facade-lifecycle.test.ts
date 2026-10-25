import {OidoAdapter} from '../../apps/host/src/integrations/oido/adapter.ts';
import { wireOidoCapabilitiesForTest } from '../helpers.ts';
// R5（2026-10-23）：oído 六工具 façade 补齐——capabilities/view/find/compare（会话绑定同门）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../apps/host/src/db/connection.ts';
import { migrate } from '../../apps/host/src/db/migrations.ts';
import { sha256Hex } from '../../apps/host/src/util/id.ts';
import { buildConfig } from '../../apps/host/src/config/schema.ts';
import { MediaService } from '../../apps/host/src/media/assets.ts';
import { MessageService } from '../../apps/host/src/messages/service.ts';
import { HostToolExecutor, type ToolExecContext } from '../../apps/host/src/runtime/host-tools.ts';
import { RotationReviewService } from '../../apps/host/src/context/rotation-review.ts';
import { HoldCheckpointService } from '../../apps/host/src/memory/hold-checkpoint.ts';

assert.equal(process.env.ESTOMAGO_TEST_MODE, '1');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-facade-'));
  const db = openDatabase(root); migrate(db, sha256Hex);
  const media = new MediaService(db, path.join(root, 'media'), buildConfig({}));
  const messages = new MessageService(db); messages.ensureConversation('a'); messages.ensureConversation('b');
  const calls: Record<string, unknown>[] = [];
  const adapter = {
    configured: true,
    capabilities: async () => ({ ok: true, providers: [{ name: 'local' }], status: 'ok' }),
    getView: async (id: string) => { calls.push({ view: id }); return { mime: 'image/png', pngBase64: Buffer.from('89504e47').toString('base64'), metadata: { analysis_id: id } }; },
    find: async (a: Record<string, unknown>) => { calls.push({ find: a }); return { state: 'candidates', items: [{ range_ms: [0, 500], match: '嗯' }] }; },
    compare: async (a: Record<string, unknown>) => { calls.push({ compare: a }); return { metrics: [], limits: [], baseline_comparison: { state: 'unavailable' } }; },
  };
  // P03：analyze 已迁 modules/oido（service 持 adapter 引用）——运行期换桩改经转发器，
  // 机制适配；断言与场景不变。
  const oidoTarget: { current: unknown } = { current: adapter };
  const oidoForwarder = new Proxy({} as Record<string | symbol, unknown>, {
    get: (_t, k) => { const t = oidoTarget.current as Record<string, unknown> | null; const v = t?.[k as string]; return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v; },
  });
  const tools = new HostToolExecutor({ db, media, messages, mariposa: null, reviews: new RotationReviewService(db), checkpoint: new HoldCheckpointService(db)});
  wireOidoCapabilitiesForTest(tools, { oido: oidoForwarder });
  const ctx = (roomId = 'a'): ToolExecContext => ({ roomId, windowId: 'w', turnId: null, purpose: 'chat', activeReviewId: null, seenSequence: 1, seenMessages: [], requestId: 'r5' });
  const create = async () => {
    const asset = await media.saveBuffer({ bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x00]), purpose: 'chat_voice', operationId: `op-${Math.random().toString(36).slice(2, 8)}`, createdBy: 'q', origin: 'upload' });
    messages.publishAssistantMessage({ conversationId: 'a', turnId: 't', content: '', kind: 'voice', clientMessageId: `m-${Math.random()}`, attachments: [{ asset_id: asset.id, presentation: 'voice' }] });
    return asset;
  };
  return { db, media, messages, tools, ctx, create, calls, adapter, oidoTarget, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}


const PNG_PATH='/Users/owner/Documents/Codex/2026-10-23/md/work/evidence/oido/final/oido_view.png';
test('REV-E06 measured PNG must not become a base64 text tool result',async()=>{const f=fixture();try{const a=await f.create();const sha=(f.db.prepare('SELECT content_sha256 FROM media_assets WHERE id=?').get(a.id) as any).content_sha256;f.db.prepare('INSERT INTO oido_source_bindings VALUES (?,?,?,?)').run('real-image','a',a.id,sha);f.adapter.getView=async(id:string)=>({mime:'image/png',pngBase64:fs.readFileSync(PNG_PATH).toString('base64'),metadata:{analysis_id:id}});const r=await f.tools.execute('oido_view',{analysis_id:'real-image'},f.ctx());console.log('MEASURED_PNG_MODEL_OUTPUT',JSON.stringify({ok:r.ok,bytes:Buffer.byteLength(JSON.stringify(r.output)),image_field:typeof r.output.image_base64,keys:Object.keys(r.output)}));assert.ok(!('image_base64' in r.output),'PNG was serialized as ordinary model JSON');}finally{f.close();}});
for(const name of ['oido_find','oido_compare'])test('REV-E07 '+name+' must recheck source after async read',async()=>{const f=fixture();try{const a=await f.create();const drop=()=>f.db.prepare("UPDATE media_assets SET state='missing' WHERE id=?").run(a.id);f.adapter.find=async()=>{drop();return {state:'candidates',items:[{range_ms:[0,500],match:'合成撤权后证据'}]}};f.adapter.compare=async()=>{drop();return {metrics:[{kind:'pitch',value:1}],limits:[],baseline_comparison:{state:'unavailable'}}};const ref=`est:${a.id}`;const r=await f.tools.execute(name,name==='oido_find'?{audio_ref:ref,query:'合成'}:{left:{audio_ref:ref},right:{audio_ref:ref}},f.ctx());console.log('LATE_SOURCE',name,r.ok);assert.equal(r.ok,false);}finally{f.close();}});
test('REV-E08 different tool calls in one model request need distinct analysis idempotency keys',async()=>{const f=fixture();try{const a=await f.create(),b=await f.create();const keys:string[]=[];f.oidoTarget.current={ingestVoice:async(x:any)=>({audioId:'aud_'+x.assetId,deduplicated:false}),analyze:async(x:any)=>{keys.push(x.idempotencyKey);return {analysis_id:'an_'+x.assetId,state:'queued'};}};for(const [i,asset] of [a,b].entries()){const r=await f.tools.execute('oido_analyze',{audio_ref:`est:${asset.id}`,toolCallId:'tc-'+i},{...f.ctx(),turnId:'same-turn',requestId:'same-request',toolCallId:'tc-'+i});assert.equal(r.ok,true);}console.log('TWO_TOOL_CALL_KEYS',JSON.stringify(keys));assert.equal(new Set(keys).size,2);}finally{f.close();}});
test('REV-E09 deletion during import must retain a remote deletion intent',async()=>{const f=fixture();try{const a=await f.create();f.oidoTarget.current={ingestVoice:async()=>{f.media.markAssetMissing(a.id);return {audioId:'aud-late',deduplicated:false}},analyze:async()=>{throw Error('must not analyze deleted source')}};const r=await f.tools.execute('oido_analyze',{audio_ref:`est:${a.id}`},f.ctx());const rows=f.db.prepare('SELECT est_asset_id,oido_audio_id FROM oido_delete_intents').all();console.log('LATE_IMPORT',JSON.stringify({ok:r.ok,receipt:f.db.prepare('SELECT est_asset_id,oido_audio_id FROM oido_ingest_receipts').all(),intents:rows}));assert.equal(r.ok,false);assert.equal(rows.length,1,'remote import exists but no deletion recovery intent');}finally{f.close();}});
test('REV-E10 pending remote deletion response must not be treated as physical cleanup complete',async(t)=>{const previous=process.env.AUDIT_OIDO_CREDENTIAL;process.env.AUDIT_OIDO_CREDENTIAL='fixture-token';const adapter=new OidoAdapter({base_url:'http://127.0.0.1:1',credential_ref:'AUDIT_OIDO_CREDENTIAL'});t.mock.method(globalThis,'fetch',async()=>Response.json({audio_id:'synthetic-pending',lifecycle:'deletion_requested_pending_cleanup'},{status:200}));try{const outcome=await adapter.deleteAudio({audioId:'synthetic-pending'}).catch(()=>({deleted:false}));assert.equal(outcome.deleted,false,'200 pending_cleanup must retain retry intent');}finally{if(previous===undefined)delete process.env.AUDIT_OIDO_CREDENTIAL;else process.env.AUDIT_OIDO_CREDENTIAL=previous;}});
