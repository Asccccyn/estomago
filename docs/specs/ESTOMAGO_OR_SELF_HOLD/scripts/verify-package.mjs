import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const list=(dir)=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(d=>{
 const p=path.join(dir,d.name);assert(!d.isSymbolicLink(),'No symlinks allowed');
 return d.isDirectory()?list(p):[p];
});
const files=list(root);let jsonCount=0;
for(const f of files) if(f.endsWith('.json')) {JSON.parse(fs.readFileSync(f,'utf8'));jsonCount++;}
const accepted=JSON.parse(fs.readFileSync(path.join(root,'ACCEPTANCE.json'),'utf8'));
assert(new Set(accepted.cases.map(c=>c.id)).size===accepted.cases.length,'Duplicate acceptance IDs');
assert(accepted.cases.every(c=>c.status==='NOT_EXECUTED'),'Package must not pre-fill app PASS');
const config=JSON.parse(fs.readFileSync(path.join(root,'config/implementation-target.json'),'utf8'));
assert.equal(config.openrouter.cache_control.ttl,'1h');
assert.equal(config.memory.helper_model,false);assert.equal(config.memory.full_coverage_backfill,false);
assert.equal(config.memory.allow_no_new_hold,true);assert.equal(config.context.rolling_summary,false);
assert.equal(config.keepalive.enabled,false);assert.equal(config.real_model_smoke.enabled,false);
const lines=fs.readFileSync(path.join(root,'SHA256SUMS'),'utf8').trim().split('\n');
const listed=new Set();
for(const line of lines){
 const match=/^([0-9a-f]{64})  (.+)$/.exec(line);assert(match,'Invalid checksum line');
 const [,expected,rel]=match;
 assert(!path.isAbsolute(rel)&&!rel.split('/').includes('..'),'Unsafe checksum path');
 assert(!listed.has(rel),'Duplicate checksum path');listed.add(rel);
 const target=path.join(root,rel);const actual=createHash('sha256').update(fs.readFileSync(target)).digest('hex');
 assert.equal(actual,expected,`Hash mismatch: ${rel}`);
}
const expectedFiles=files.filter(f=>path.basename(f)!=='SHA256SUMS').map(f=>path.relative(root,f).split(path.sep).join('/'));
assert(expectedFiles.every(f=>listed.has(f))&&expectedFiles.length===listed.size,'Unlisted file');
console.log(JSON.stringify({package_integrity:'PASS',files:files.length,json_files:jsonCount,
 application_acceptance:accepted.cases.length,application_status:'NOT_EXECUTED',network_requests:0},null,2));
