import { useEffect, useRef, useState } from 'react'
import type { EstomagoClient } from './chat-client'
type Memory = { memory_ref:string; date:string|null; text:string }
type Page = { sections:Record<string,unknown>; section_status?:Record<string,string>; next_cursor?:string|null; complete?:boolean; changed_since_surface?:boolean }
const labels:Record<string,string>={memory:'日期、标题与事件正文',categories:'分类',mood:'心情',our_words:'我们的话',recollections:'后来的回忆',keeps:'留存资料',source:'来源绑定',relations:'关联关系'}
export function SurfacedMemories({turnId,client}:{turnId:string;client:EstomagoClient}) {
  const [open,setOpen]=useState(false),[items,setItems]=useState<Memory[]|null>(null)
  const [selected,setSelected]=useState<string|null>(null),[pages,setPages]=useState<Page[]>([])
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
  async function detail(ref:string,cursor?:string) {
    if(busy)return
    const gen=++generation.current;setBusy(true);setError('');setSelected(ref)
    if(!cursor)setPages([])
    try {const page=await client.loadSurfacedMemoryDetail(turnId,ref,cursor) as Page
      if(gen===generation.current)setPages(old=>cursor?[...old,page]:[page])}
    catch{if(gen===generation.current)setError('该记忆详情暂不可用，请重试；不会重新检索。')}
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
        <button type="button" disabled={busy} onClick={()=>void detail(item.memory_ref)} className="mt-1 underline">查看全量</button>
      </section>)}
      {selected&&pages.map((page,index)=><div key={index} className="space-y-2">
        {page.changed_since_surface&&<p>该记忆在浮现后有更新，以下为当前详情。</p>}
        {Object.entries(page.sections??{}).map(([name,value])=><section key={name}>
          <h4 className="font-medium">{labels[name]??name}</h4>
          {page.section_status?.[name]==='unavailable'?<p>此部分暂不可用。</p>:<pre className="whitespace-pre-wrap break-words font-sans">{typeof value==='string'?value:JSON.stringify(value,null,2)}</pre>}
        </section>)}
      </div>)}
      {selected&&last?.next_cursor&&<button type="button" disabled={busy} onClick={()=>void detail(selected,last.next_cursor!)} className="underline">继续读取全量</button>}
    </div>}
  </div>
}
