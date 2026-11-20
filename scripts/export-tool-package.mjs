// Full production composition, temporary state, no server/model start.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {TOOL_DATA_BOUNDARY_RULE} from '../apps/host/src/context/fixed-runtime.ts';
import {Host} from '../apps/host/src/app-context.ts';
import {buildConfig} from '../apps/host/src/config/schema.ts';
import {freezeWindowTools,storedToolset,definitionId,buildDeferredTools} from '../apps/host/src/runtime/tool-discovery.ts';
import {RESIDENT_TOOL_HEADING} from '../apps/host/src/runtime/tool-initial-visible.ts';
import {toolCatalogIntent} from '../apps/host/src/runtime/tool-catalog-search.ts';

const output=process.argv[2];
if(!output || output.startsWith('--'))throw Error('Pass an output directory');
fs.mkdirSync(output,{recursive:true});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'est-tool-package-'));
process.env.ESTOMAGO_TEST_MODE='1';process.env.ESTOMAGO_HOME=root;
const host=await Host.create({stateRoot:root,config:buildConfig({runtime:{provider:'mock',tool_schema_mode:'deferred'}}),logDir:null,bind:'127.0.0.1',port:0});
try{
 const registry=host.supervisor.toolCatalogSource();
 const tools=registry.currentCatalog();
 host.db.prepare("INSERT INTO windows(id,conversation_id,status,created_at,updated_at) VALUES('synthetic-package','primary','ACTIVE','now','now')").run();
 freezeWindowTools(host.db,'synthetic-package',tools,'deferred',registry.currentGroups());
 const snapshot=storedToolset(host.db,'synthetic-package');
 const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const matrix=registry.listByBaselineOrder().map(d=>({
   name:d.id,owner:d.owner,group:d.legacyOnly?'M':snapshot.groups[d.id],memory_only:d.memoryOnlyAllowed,
   intent:toolCatalogIntent(d.id),...(d.replacedBy?{replaced_by:d.replacedBy}:{}),definition_id:definitionId(d.definition()),
 }));
 const discovery=buildDeferredTools();
 const initialText=snapshot.initialText??'';
 const residentStart=initialText.indexOf(RESIDENT_TOOL_HEADING+'\n');
 const directoryText=residentStart<0?initialText:initialText.slice(0,residentStart);
 const residentText=residentStart<0?'':initialText.slice(residentStart);
 const bytes={all_definition_json:Buffer.byteLength(JSON.stringify(tools),'utf8'),
   initial_text:Buffer.byteLength(initialText,'utf8'),
   common_definitions_text:Buffer.byteLength(residentText,'utf8'),
   deferred_index_text:Buffer.byteLength(directoryText,'utf8'),
   discovery_json:Buffer.byteLength(JSON.stringify(discovery),'utf8'),stable_rule_increment:Buffer.byteLength(TOOL_DATA_BOUNDARY_RULE+'\n','utf8'),tokenizer:null};
 bytes.model_tool_package=bytes.initial_text+bytes.discovery_json+bytes.stable_rule_increment;
 const artifact={synthetic:true,source_commit:sourceCommit,assembly:'Host.create (not started)',matrix,bytes,stable_rules:[TOOL_DATA_BOUNDARY_RULE],snapshot};
 fs.writeFileSync(path.join(output,'tool-package.json'),JSON.stringify(artifact,null,2)+'\n');
 fs.writeFileSync(path.join(output,'initial-tools.txt'),initialText+'\n');
 fs.writeFileSync(path.join(output,'tool-matrix.md'),'| 工具 | 分组 | 通话 memory_only | 旧名去向 | 用途 |\n| --- | --- | --- | --- | --- |\n'+matrix.map(d=>`| ${d.name} | ${d.group} | ${d.memory_only} | ${d.replaced_by??''} | ${d.intent??''} |`).join('\n')+'\n');
 const baseline=JSON.parse(fs.readFileSync(new URL('../tests/fixtures/window-tools-before-autonomy.json',import.meta.url),'utf8'));
 const old=new Map(baseline.catalog.map(spec=>[spec.function.name,spec]));
 const descriptions=[],structures=[];
 function compare(a,b,key,tool){
   if(JSON.stringify(a)===JSON.stringify(b))return;
   if(key.endsWith('.description')){descriptions.push({tool,field:key,before:a??null,after:b??null});return;}
   if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){
     for(const k of new Set([...Object.keys(a),...Object.keys(b)]))compare(a[k],b[k],key+'.'+k,tool);
   }else structures.push({tool,field:key,before:a??null,after:b??null});
 }
 for(const spec of tools)if(old.has(spec.function.name))compare(old.get(spec.function.name).function,spec.function,'function',spec.function.name);
 fs.writeFileSync(path.join(output,'copy-and-schema-diff.json'),JSON.stringify({baseline_commit:baseline.source_commit,description_changes:descriptions,structure_changes:structures,
   added:tools.filter(s=>!old.has(s.function.name)).map(s=>s.function.name),legacy_aliases:matrix.filter(d=>d.group==='M')},null,2)+'\n');
 const review=['# 工具文案审阅','由 registry 与已核对旧窗快照生成。参数结构变化另列在 copy-and-schema-diff.json；文字更短不代表模型已经会用。'];
 for(const item of descriptions)review.push(`\n## ${item.tool} · ${item.field}\n\n原：${item.before??'无'}\n\n现：${item.after??'无'}`);
 fs.writeFileSync(path.join(output,'copy-review.md'),review.join('\n')+'\n');
 if(process.argv.includes('--update-golden')){
   const golden={baselineCommit:sourceCommit,order:tools.map(s=>s.function.name),deferredOrder:discovery.map(s=>s.function.name),definitionIds:Object.fromEntries(tools.map(s=>[s.function.name,definitionId(s)])),toolsSha256:crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex'),tools,deferred:discovery};
   fs.writeFileSync(new URL('../tests/golden/tool-catalog-baseline.json',import.meta.url),JSON.stringify(golden,null,2)+'\n');
 }
 console.log(JSON.stringify({groups:Object.fromEntries(['C','D','T'].map(group=>[group,matrix.filter(d=>d.group===group).length])),bytes}));
}finally{await host.stop();fs.rmSync(root,{recursive:true,force:true});}
