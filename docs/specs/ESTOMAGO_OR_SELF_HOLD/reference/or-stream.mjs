import {requireThat,ContractError,normalizeOrUsage} from './policy.mjs';

/** Incremental UTF-8 SSE framing. No requests are made by this module. */
export class SseFramer {
  constructor(onData,{maxEventBytes=1048576}={}) {
    this.onData=onData; this.maxEventBytes=maxEventBytes;
    this.decoder=new TextDecoder('utf-8',{fatal:true}); this.buffer=''; this.data=[]; this.eventBytes=0;
  }
  feed(chunk) {
    this.buffer+=typeof chunk==='string'?chunk:this.decoder.decode(chunk,{stream:true});
    let cut;
    while ((cut=this.buffer.indexOf('\n'))>=0) {
      let line=this.buffer.slice(0,cut); this.buffer=this.buffer.slice(cut+1);
      if (line.endsWith('\r')) line=line.slice(0,-1);
      this.eventBytes+=Buffer.byteLength(line)+1;
      requireThat(this.eventBytes<=this.maxEventBytes,'SSE_EVENT_TOO_LARGE');
      if (!line) {
        this.eventBytes=0;
        if (this.data.length) { const data=this.data.join('\n'); this.data=[]; this.onData(data); }
      } else if (!line.startsWith(':') && line.startsWith('data:')) {
        this.data.push(line.slice(5).replace(/^ /,''));
      }
    }
    requireThat(this.eventBytes+Buffer.byteLength(this.buffer)<=this.maxEventBytes,'SSE_EVENT_TOO_LARGE');
  }
  end() {
    this.feed(this.decoder.decode());
    requireThat(this.buffer.length===0 && this.data.length===0,'SSE_TRUNCATED_FRAME');
  }
}

/** Aggregates one OR request, never executes tools. Opaque reasoning frames remain separate. */
export class OrStreamAccumulator {
  constructor() {
    this.id=null;this.text='';this.terminal=null;this.terminalEvents=0;this.done=false;
    this.rawUsage=null;this.tools=new Map();this.reasoningFrames=[];
    this.framer=new SseFramer(data=>this.accept(data));
  }
  feed(chunk) {this.framer.feed(chunk);}
  accept(data) {
    if (data==='[DONE]') {requireThat(!this.done,'DUPLICATE_DONE');this.done=true;return;}
    requireThat(!this.done,'DATA_AFTER_DONE');
    let x;try{x=JSON.parse(data);}catch{throw new ContractError('SSE_INVALID_JSON');}
    if (x.error) throw new ContractError('OR_STREAM_ERROR'); // don't leak provider text
    if (x.id) {requireThat(this.id===null||this.id===x.id,'GENERATION_ID_CHANGED');this.id=x.id;}
    if (x.usage) this.rawUsage=structuredClone(x.usage); // accounting frame replaces, never sums
    for (const ch of x.choices??[]) {
      requireThat(ch.index===0 || ch.index===undefined,'UNSUPPORTED_MULTIPLE_CHOICES');
      const d=ch.delta??{};
      const substantive=!!d.content || !!d.tool_calls?.length || !!d.reasoning_details?.length;
      requireThat(!this.terminal||!substantive,'CONTENT_AFTER_TERMINAL');
      if (d.content) {requireThat(typeof d.content==='string','CONTENT_TYPE_INVALID');this.text+=d.content;}
      if (d.reasoning_details?.length) this.reasoningFrames.push(structuredClone(d.reasoning_details));
      for (const t of d.tool_calls??[]) {
        requireThat(Number.isSafeInteger(t.index)&&t.index>=0,'TOOL_INDEX_INVALID');
        const v=this.tools.get(t.index)??{id:null,type:'function',name:'',arguments:''};
        if (t.id) {requireThat(v.id===null||v.id===t.id,'TOOL_ID_CHANGED');v.id=t.id;}
        if (t.type) requireThat(t.type==='function','TOOL_TYPE_INVALID');
        if (t.function?.name) v.name+=t.function.name;
        if (t.function?.arguments!==undefined) {
          requireThat(typeof t.function.arguments==='string','TOOL_ARGUMENT_FRAGMENT_INVALID');
          v.arguments+=t.function.arguments;
        }
        requireThat(Buffer.byteLength(v.arguments)<=1048576,'TOOL_ARGUMENTS_TOO_LARGE');
        this.tools.set(t.index,v);
      }
      if (ch.finish_reason) {
        if (ch.finish_reason==='error') throw new ContractError('OR_STREAM_ERROR');
        requireThat(this.terminal===null||this.terminal===ch.finish_reason,'FINISH_REASON_CHANGED');
        if (this.terminal===null) {this.terminal=ch.finish_reason;this.terminalEvents++;}
      }
    }
  }
  finish() {
    this.framer.end();
    requireThat(this.done&&this.terminal!==null,'MISSING_FINAL_RESULT');
    const status=['stop','tool_calls'].includes(this.terminal)?'completed':'incomplete';
    const calls=[];
    if (status==='completed') {
      requireThat((this.tools.size>0)===(this.terminal==='tool_calls'),'TOOL_FINISH_MISMATCH');
      for (const [,v] of [...this.tools.entries()].sort((a,b)=>a[0]-b[0])) {
        requireThat(!!v.id&&!!v.name,'INCOMPLETE_TOOL_CALL');
        let args;try{args=JSON.parse(v.arguments);}catch{throw new ContractError('TOOL_JSON_INVALID');}
        requireThat(args!==null&&typeof args==='object'&&!Array.isArray(args),'TOOL_JSON_NOT_OBJECT');
        calls.push({id:v.id,type:'function',function:{name:v.name,arguments:v.arguments},parsedArguments:args});
      }
      requireThat(new Set(calls.map(c=>c.id)).size===calls.length,'DUPLICATE_TOOL_ID');
    }
    return {id:this.id,status,finishReason:this.terminal,text:this.text,toolCalls:calls,
      usage:normalizeOrUsage(this.rawUsage),reasoningFrames:this.reasoningFrames,
      terminalEvents:this.terminalEvents};
  }
}
