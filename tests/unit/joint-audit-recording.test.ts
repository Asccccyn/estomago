import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the production hook with a deterministic hook scheduler and MediaRecorder.
// Synthetic lifecycle evidence only: no microphone, network, provider or real browser.
function harness(options: { secure?: boolean; microphoneError?: Error } = {}) {
  const values: any[] = [], effects: Array<() => void> = [], intervals = new Set<() => void>();
  let slot = 0, now = 0, hook: any;
  const queued: Blob[] = [], tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  class Recorder {
    static isTypeSupported() { return true; }
    static instances: Recorder[] = [];
    state = 'inactive'; mimeType = 'audio/mp4';
    ondataavailable?: (event: {data: Blob}) => void; onstop?: () => void; onerror?: () => void;
    constructor() { Recorder.instances.push(this); }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({data: new Blob(['synthetic audio'])}); this.onstop?.(); }
  }
  const notices: string[] = [];
  const client = { snapshot: {attachments: []}, subscribe() {}, getSnapshot() {}, start: async () => {}, stop() {}, notify(text: string) { notices.push(text); }, queue: async (blob: Blob) => {queued.push(blob);} };
  const react = {
    useMemo: (fn: () => any) => { const i = slot++; return values[i] ??= fn(); },
    useSyncExternalStore: () => {slot++;return client.snapshot;},
    useRef: (initial: any) => { const i=slot++;return values[i] ??= {current: initial}; },
    useState: (initial: any) => { const i=slot++;if(!(i in values))values[i]=initial;return [values[i],(v:any)=>{values[i]=v;}]; },
    useEffect: (fn: () => void, deps: any[]) => { const i=slot++;if(!values[i]||deps.some((x,j)=>x!==values[i][j])){values[i]=deps;effects.push(fn);} },
  };
  const output: any = {};
  const code = ts.transpileModule(fs.readFileSync(new URL('../../apps/web/react/src/useEstomago.ts', import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const microphone: any = {};
  const context = vm.createContext({exports:output,require:(id:string)=>id==='react'?react:id.endsWith('microphone-access.js')?microphone:{EstomagoClient:function(){return client;}},Blob,URL,isSecureContext:options.secure??true,Date:{now:()=>now},performance:{now:()=>now},navigator:{mediaDevices:{getUserMedia:async()=>{if(options.microphoneError)throw options.microphoneError;return {getTracks:()=>tracks};}}},MediaRecorder:Recorder,window:{location:{href:options.secure===false?'http://example.test/chat':'https://example.test/chat'},addEventListener(){},removeEventListener(){}},setInterval:(fn:()=>void)=>{intervals.add(fn);return fn;},clearInterval:(fn:()=>void)=>intervals.delete(fn)});
  const helperCode=ts.transpileModule(fs.readFileSync(new URL('../../apps/web/src/microphone-access.js',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  context.exports=microphone;vm.runInContext(helperCode,context);context.exports=output;
  vm.runInContext(code,context);
  const render=()=>{slot=0;hook=output.useEstomago();effects.splice(0).forEach(fn=>fn());return hook;};
  return {render, queued, tracks, Recorder, notices, microphone, advance(ms:number){now+=ms;intervals.forEach(fn=>fn());}};
}

test('paused recording finish retains final data and releases tracks', async () => {
  const h=harness();let ui=h.render();await ui.startRec();ui=h.render();ui.pauseRec();ui=h.render();ui.stopRec(true);ui=h.render();
  assert.equal(h.queued.length,1,'finishing paused recording must enqueue audio exactly once');
  assert.equal(ui.rec,null);assert.ok(h.tracks.every(t=>t.stopped));
});

test('paused recording cancel ends recorder without sending', async () => {
  const h=harness();let ui=h.render();await ui.startRec();ui=h.render();ui.pauseRec();ui=h.render();ui.stopRec(false);ui=h.render();
  assert.equal(h.Recorder.instances[0].state,'inactive');assert.equal(ui.rec,null);assert.equal(h.queued.length,0);
});

test('pause time is excluded from duration and two-minute recording cap', async () => {
  const h=harness();let ui=h.render();await ui.startRec();ui=h.render();h.advance(10_000);ui=h.render();ui.pauseRec();h.advance(180_000);ui=h.render();ui.pauseRec();h.advance(1_000);ui=h.render();
  assert.equal(ui.recSecs,11);assert.equal(h.queued.length,0,'long pause must not trigger immediate finish after resume');
});

test('HTTP recording explains the secure-context failure and offers the same-site HTTPS URL', async () => {
  const h=harness({secure:false});await h.render().startRec();
  assert.match(h.notices[0],/HTTPS/);assert.equal(h.microphone.secureMicrophoneUrl(),'https://example.test/chat');
  assert.equal(h.Recorder.instances.length,0);assert.equal(h.queued.length,0);
});

test('denied microphone permission remains distinct from unsupported recording', async () => {
  const error=new Error('synthetic denial');error.name='NotAllowedError';
  const h=harness({microphoneError:error});await h.render().startRec();
  assert.match(h.notices[0],/权限未获允许/);assert.equal(h.queued.length,0);
});
