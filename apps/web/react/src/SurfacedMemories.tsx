import { useEffect, useRef, useState } from 'react'
import type { EstomagoClient } from './chat-client'
type Section = 'memory' | 'relations' | 'source'
type Memory = { memory_ref:string; date:string|null; text:string }
type Entry = { speaker?:string; normalized_sender?:string; text?:string; source_gap?:string; unavailable?:boolean; changed?:boolean; uncertain?:boolean; attachments?:unknown[]; reason?:string; conversation_title?:string; occurred_date?:string; occurred_at?:string; direction?:string; relation_type?:string; target?:{title?:string;memory_id?:string;plan_id?:string} }
type Page = { date?:string; title?:string; text?:string; categories?:string[]; mood?:{text?:string;tags?:string[]}; our_words?:Entry[]; relations?:Entry[]; source?:Entry[]; next_cursor?:string; incomplete_sections?:Record<string,string>; changed_since_surface?:boolean }
const names:Record<Section,string>={memory:'记忆详情',relations:'关系与关联内容',source:'绑定原文'}
const speaker=(v?:string)=>v==='jiaming'?'char':v==='qiaosheng'?'宿主用户':v??''
function Contents({page}:{page:Page}) {
  return <>
    {page.changed_since_surface&&<p>这条记忆在浮现后有更新，下面是当前内容。</p>}
    {page.title&&<h4 className="font-medium">{page.title}</h4>}
    {page.date&&<p>{page.date}</p>}
    {page.text!==undefined&&<p className="whitespace-pre-wrap break-words">{page.text}</p>}
    {!!page.categories?.length&&<p>{page.categories.join(' · ')}</p>}
    {page.mood&&<section><h4 className="font-medium">心情</h4><p>{page.mood.tags?.join(' · ')}</p><p className="whitespace-pre-wrap">{page.mood.text}</p></section>}
    {page.our_words?.map((word,i)=><p key={i} className="whitespace-pre-wrap">{speaker(word.speaker)}：{word.text}{word.source_gap&&<span>（来源暂不可用）</span>}</p>)}
    {page.relations?.map((edge,i)=><section key={i} className="border-t pt-2"><h4>{edge.relation_type??'关联'} · {edge.direction==='in'?'指向这条记忆':'由这条记忆指向'} · {edge.target?.title??edge.target?.memory_id??edge.target?.plan_id}</h4>{edge.uncertain&&<p>这条关系尚未确认。</p>}{edge.unavailable?<p>关联内容暂不可用。</p>:<p className="whitespace-pre-wrap break-words">{edge.text}</p>}</section>)}
    {page.source?.map((entry,i)=><section key={i} className="border-t pt-2"><h4>{entry.conversation_title} · {speaker(entry.speaker??entry.normalized_sender)} {entry.occurred_at??entry.occurred_date}</h4>{entry.changed&&<p>来源已有新修订，这里保留绑定的原文。</p>}{entry.unavailable?<p>这段原文暂不可用；其他片段仍可阅读。</p>:<p className="whitespace-pre-wrap break-words">{entry.text}</p>}{!!entry.attachments?.length&&<pre className="whitespace-pre-wrap break-words">{JSON.stringify(entry.attachments,null,2)}</pre>}</section>)}
    {page.incomplete_sections&&<p>部分内容尚未完整返回。{page.next_cursor?'请继续读取。':'存在暂不可用的内容。'}</p>}
    {page.relations?.length===0&&<p>没有关联关系。</p>}
    {page.source?.length===0&&<p>这个记忆没有绑定原文。</p>}
  </>
}
export function SurfacedMemories({turnId,client}:{turnId:string;client:EstomagoClient}) {
  const [open,setOpen]=useState(false),[items,setItems]=useState<Memory[]|null>(null)
  const [selected,setSelected]=useState<string|null>(null),[section,setSection]=useState<Section>('memory'),[pages,setPages]=useState<Page[]>([])
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const generation=useRef(0)
  useEffect(()=>()=>{generation.current++},[turnId])
  async function toggle() {
    setOpen(!open)
    if(open||items||busy)return
    const gen=++generation.current;setBusy(true);setError('')
    try {const r=await client.loadSurfacedMemories(turnId);if(gen===generation.current)setItems(r.items??[])}
    catch{if(gen===generation.current)setError('回忆列表读取失败，请关闭后重试。')}
    finally{if(gen===generation.current)setBusy(false)}
  }
  async function detail(ref:string,part:Section,cursor?:string) {
    if(busy)return
    const gen=++generation.current;setBusy(true);setError('');setSelected(ref);setSection(part)
    if(!cursor)setPages([])
    try {const page=await client.loadSurfacedMemoryDetail(turnId,ref,cursor,part) as Page
      if(gen===generation.current)setPages(old=>cursor?[...old,page]:[page])}
    catch{if(gen===generation.current)setError('内容暂不可用，请重试；不会重新检索。')}
    finally{if(gen===generation.current)setBusy(false)}
  }
  const last=pages.at(-1)
  return <div className="mt-2 text-sm text-[#5e5d59]">
    <button type="button" aria-expanded={open} onClick={()=>void toggle()} className="underline underline-offset-4">本轮回忆</button>
    {open&&<div className="mt-2 space-y-3 rounded-xl border border-[#d4cec0] p-3">
      {busy&&<p role="status">读取中…</p>}{error&&<p role="alert">{error}</p>}
      {items?.length===0&&<p>本轮没有自动浮现的记忆。</p>}
      {items?.map(item=><section key={item.memory_ref}>
        <p>{item.date??'日期不确定'}</p><p className="whitespace-pre-wrap break-words">{item.text}</p>
        <div className="mt-1 flex flex-wrap gap-3">{(['memory','relations','source'] as Section[]).map(part=><button key={part} type="button" disabled={busy} onClick={()=>void detail(item.memory_ref,part)} className="underline">{part==='memory'?'查看详情':part==='relations'?'查看关系':'查看原文'}</button>)}</div>
      </section>)}
      {selected&&<h3 className="font-medium">{names[section]}</h3>}
      {selected&&pages.map((page,index)=><div key={index} className="space-y-2"><Contents page={page}/></div>)}
      {selected&&last?.next_cursor&&<button type="button" disabled={busy} onClick={()=>void detail(selected,section,last.next_cursor)} className="underline">继续读取</button>}
    </div>}
  </div>
}
