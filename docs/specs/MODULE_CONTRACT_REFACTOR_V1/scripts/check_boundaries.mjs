#!/usr/bin/env node
/** AST只读结构检查：不加载业务模块，不联网。运行时回调/SQL所有权仍需人工复核。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const argv=process.argv.slice(2);
function option(name, fallback){const i=argv.indexOf(name);return i>=0?argv[i+1]:fallback;}
const repoArg=option('--repo',null);
const mode=option('--mode','report');
if(!repoArg||!['report','final'].includes(mode)){
  console.error('Usage: node check_boundaries.mjs --repo /absolute/worktree --mode report|final');process.exit(2);
}
const root=path.resolve(repoArg);
const rel=p=>path.relative(root,p).split(path.sep).join('/');
let ts;
try{ts=createRequire(path.join(root,'package.json'))('typescript');}
catch{console.error('Use the repository existing TypeScript dependency; do not install or upgrade from this script.');process.exit(2);}
const roots=['apps/host/src','packages/contracts/src'];
const files=[];
function walk(p){if(!fs.existsSync(p))return;for(const ent of fs.readdirSync(p,{withFileTypes:true})){
  const next=path.join(p,ent.name);if(ent.isDirectory())walk(next);else if(/\.(ts|tsx)$/.test(ent.name)&&!ent.name.endsWith('.d.ts'))files.push(next);
}}
for(const r of roots)walk(path.join(root,r));
const options={moduleResolution:ts.ModuleResolutionKind.NodeNext,module:ts.ModuleKind.NodeNext,allowImportingTsExtensions:true};
const configPath=ts.findConfigFile(root,ts.sys.fileExists,'tsconfig.json');
if(configPath){const c=ts.readConfigFile(configPath,ts.sys.readFile);if(!c.error){Object.assign(options,ts.parseJsonConfigFileContent(c.config,ts.sys,path.dirname(configPath)).options);}}
const all=new Set(files.map(p=>path.resolve(p)));const edges=[];const dynamic=[];const violations=[];
const moduleOwner=s=>/^apps\/host\/src\/modules\/([^/]+)\//.exec(s)?.[1];
const parseKinds=new Map();
function add(from,spec,value,node,source){
  const resolved=ts.resolveModuleName(spec,from,options,ts.sys).resolvedModule?.resolvedFileName;
  if(!resolved)return;
  const to=path.resolve(resolved); if(!all.has(to))return;
  const a=rel(from),b=rel(to);edges.push({from:a,to:b,value,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1});
  const plainCore=/^apps\/host\/src\/capabilities\/(contracts|registry|executor|validation)\.ts$/.test(a);
  if(plainCore && /^apps\/host\/src\/(modules|integrations|server)\//.test(b))violations.push({rule:'generic-capability-core-must-not-import-business',from:a,to:b});
  if(plainCore && /apps\/host\/src\/(app-context|runtime\/supervisor)\.ts$/.test(b))violations.push({rule:'generic-core-must-not-import-host',from:a,to:b});
  const ao=moduleOwner(a),bo=moduleOwner(b);
  if(ao && bo && ao!==bo && !/\/(public|contracts)\.ts$/.test(b))violations.push({rule:'no-sibling-module-internals',from:a,to:b});
  if(a==='apps/host/src/runtime/supervisor.ts' && /^apps\/host\/src\/(modules|integrations|memory-surfacing)\//.test(b))violations.push({rule:'supervisor-consumes-ports-not-business-clients',from:a,to:b});
  if(a==='apps/host/src/messages/service.ts' && /^apps\/host\/src\/(modules|integrations|memory-surfacing)\//.test(b))violations.push({rule:'message-core-consumes-lifecycle-contract',from:a,to:b});
  if(a==='apps/host/src/runtime/tool-initial-visible.ts' && b==='apps/host/src/runtime/host-tools.ts')violations.push({rule:'initial-visible-no-reverse-host-tools-import',from:a,to:b});
}
for(const file of files){
  const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  parseKinds.set(rel(file),source.statements.map(n=>ts.SyntaxKind[n.kind]));
  function visit(n){
    if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)){
      const c=n.importClause;let value=!c?.isTypeOnly;
      if(c && !c.name && c.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.length && c.namedBindings.elements.every(x=>x.isTypeOnly))value=false;
      add(file,n.moduleSpecifier.text,value,n,source);
    }else if(ts.isExportDeclaration(n)&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier)){
      const e=n.exportClause;const allType=e&&ts.isNamedExports(e)&&e.elements.length&&e.elements.every(x=>x.isTypeOnly);
      add(file,n.moduleSpecifier.text,!n.isTypeOnly&&!allType,n,source);
    }else if(ts.isImportTypeNode(n)&&ts.isLiteralTypeNode(n.argument)&&ts.isStringLiteral(n.argument.literal)){
      add(file,n.argument.literal.text,false,n,source);
    }else if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(n.expression)&&n.expression.text==='require'))){
      const arg=n.arguments[0];if(arg&&ts.isStringLiteralLike(arg))add(file,arg.text,true,n,source);
      else dynamic.push({file:rel(file),line:source.getLineAndCharacterOfPosition(n.getStart(source)).line+1});
    }
    ts.forEachChild(n,visit);
  }visit(source);
}
// Tarjan: type-only边不参与运行时循环判定。
const graph=new Map([...all].map(p=>[rel(p),[]]));for(const e of edges)if(e.value)graph.get(e.from).push(e.to);
let next=0;const index=new Map(),low=new Map(),stack=[],active=new Set(),cycles=[];
function strong(v){index.set(v,next);low.set(v,next++);stack.push(v);active.add(v);
 for(const w of graph.get(v)??[]){if(!index.has(w)){strong(w);low.set(v,Math.min(low.get(v),low.get(w)));}else if(active.has(w))low.set(v,Math.min(low.get(v),index.get(w)));}
 if(low.get(v)===index.get(v)){const c=[];let w;do{w=stack.pop();active.delete(w);c.push(w);}while(w!==v);if(c.length>1||(graph.get(v)??[]).includes(v))cycles.push(c);}}
for(const v of graph.keys())if(!index.has(v))strong(v);
if(mode==='final'){
 for(const f of ['contracts','registry','executor','model-bridge'])if(!fs.existsSync(path.join(root,'apps/host/src/capabilities',f+'.ts')))violations.push({rule:'required-capability-seam-missing',file:f+'.ts'});
 const kinds=parseKinds.get('apps/host/src/runtime/host-tools.ts');
 if(kinds && kinds.some(k=>!['ImportDeclaration','ExportDeclaration','InterfaceDeclaration','TypeAliasDeclaration','EmptyStatement'].includes(k)))violations.push({rule:'old-host-tools-not-a-pure-reexport',file:'apps/host/src/runtime/host-tools.ts'});
}
const output={mode,filesScanned:files.length,internalImportEdges:edges.length,violations,runtimeImportCycles:cycles,
 nonLiteralDynamicImportsRequiringManualReview:dynamic,
 limitations:['Does not prove callback graph is acyclic.','Does not prove SQL ownership, permissions or live wiring.','Types/AST passing is not product acceptance.']};
console.log(JSON.stringify(output,null,2));
process.exit(mode==='final'&&(violations.length||cycles.length)?1:0);
