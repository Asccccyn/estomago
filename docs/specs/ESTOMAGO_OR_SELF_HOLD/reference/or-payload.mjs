import {requireThat} from './policy.mjs';
const oneHour=()=>({type:'ephemeral',ttl:'1h'});
const clone=x=>structuredClone(x);

// Remove only control markers in supported locations, not schema properties or user JSON.
export function withoutCacheMarkers(payload) {
  const out=clone(payload); delete out.cache_control;
  for (const tool of out.tools ?? []) delete tool.cache_control;
  for (const m of out.messages ?? []) {
    delete m.cache_control;
    if (Array.isArray(m.content)) for (const block of m.content) delete block.cache_control;
  }
  return out;
}

/** boundaries = [{messageIndex, contentIndex}], at most A,B,G, all text blocks. */
export function buildOrPayload({model,sessionId,messages,tools=[],boundaries=[],maxTokens=8192,reasoning=null}) {
  requireThat(typeof model==='string' && /^anthropic\/claude-[a-zA-Z0-9.-]+$/.test(model) &&
    !/latest|auto/.test(model), 'EXACT_CLAUDE_MODEL_REQUIRED');
  requireThat(typeof sessionId==='string' && sessionId.length>0 && sessionId.length<=256, 'SESSION_ID_INVALID');
  requireThat(Number.isSafeInteger(maxTokens) && maxTokens>0, 'MAX_TOKENS_INVALID');
  requireThat(Array.isArray(messages) && messages.length>0, 'MESSAGES_REQUIRED');
  const base=withoutCacheMarkers({messages,tools});
  const seen=new Set();
  for (const b of boundaries) {
    requireThat(Number.isInteger(b.messageIndex) && b.messageIndex>=0 &&
      Number.isInteger(b.contentIndex) && b.contentIndex>=0, 'BOUNDARY_INVALID');
    const key=`${b.messageIndex}:${b.contentIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requireThat(seen.size<=3, 'TOO_MANY_EXPLICIT_BREAKPOINTS');
    const content=base.messages[b.messageIndex]?.content;
    requireThat(Array.isArray(content), 'BOUNDARY_CONTENT_NOT_BLOCKS');
    const block=content[b.contentIndex];
    requireThat(block?.type==='text' && typeof block.text==='string' && block.text.length>0, 'BOUNDARY_NOT_TEXT');
    block.cache_control=oneHour();
  }
  // No caller supplied preset/fallback can overwrite the critical controls.
  const out={model,session_id:sessionId,stream:true,max_tokens:maxTokens,
    provider:{only:['anthropic'],allow_fallbacks:false,require_parameters:true},
    cache_control:oneHour(),plugins:[{id:'context-compression',enabled:false}],...base};
  if (reasoning!==null) out.reasoning=clone(reasoning); // capability gate remains caller responsibility
  return out;
}

/** At our adapter boundary only. Not a claim about hidden OR internal transformations. */
export function assertAppendOnly(previous,current) {
  const p=withoutCacheMarkers(previous), c=withoutCacheMarkers(current);
  for (const key of ['model','session_id','provider','tools','reasoning']) {
    requireThat(JSON.stringify(p[key]??null)===JSON.stringify(c[key]??null), `PREFIX_PROFILE_CHANGED:${key}`);
  }
  requireThat(c.messages.length>=p.messages.length,'HISTORY_SHORTENED');
  for (let i=0;i<p.messages.length;i++) {
    requireThat(JSON.stringify(p.messages[i])===JSON.stringify(c.messages[i]),`HISTORY_CHANGED:${i}`);
  }
  return true;
}
