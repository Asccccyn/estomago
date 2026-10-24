import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the production hook with a deterministic hook scheduler and MediaRecorder.
// Synthetic lifecycle evidence only: no microphone, network, provider or real browser.
function harness() {
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
  const client = { snapshot: {attachments: []}, subscribe() {}, getSnapshot() {}, start: async () => {}, stop() {}, notify() {}, voiceAvailable: async () => true, queue: async (blob: Blob) => {queued.push(blob);} };
  const react = {
    useMemo: (fn: () => any) => { const i = slot++; return values[i] ??= fn(); },
    useSyncExternalStore: () => {slot++;return client.snapshot;},
    useRef: (initial: any) => { const i=slot++;return values[i] ??= {current: initial}; },
    useState: (initial: any) => { const i=slot++;if(!(i in values))values[i]=initial;return [values[i],(v:any)=>{values[i]=v;}]; },
    useEffect: (fn: () => void, deps: any[]) => { const i=slot++;if(!values[i]||deps.some((x,j)=>x!==values[i][j])){values[i]=deps;effects.push(fn);} },
  };
  const output: any = {};
  const code = ts.transpileModule(fs.readFileSync(new URL('../../apps/web/react/src/useEstomago.ts', import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const context = vm.createContext({exports:output,require:(id:string)=>id==='react'?react:{EstomagoClient:function(){return client;}},Blob,Date:{now:()=>now},performance:{now:()=>now},navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>tracks})}},MediaRecorder:Recorder,window:{addEventListener(){},removeEventListener(){}},setInterval:(fn:()=>void)=>{intervals.add(fn);return fn;},clearInterval:(fn:()=>void)=>intervals.delete(fn)});
  vm.runInContext(code,context);
  const render=()=>{slot=0;hook=output.useEstomago();effects.splice(0).forEach(fn=>fn());return hook;};
  return {render, queued, tracks, Recorder, advance(ms:number){now+=ms;intervals.forEach(fn=>fn());}};
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
