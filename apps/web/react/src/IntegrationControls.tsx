import type { EstomagoClient, Snapshot } from './chat-client'
export function IntegrationControls({client,state}: {client:EstomagoClient;state:Snapshot}) {
  return <>
    {state.selectionMode && <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px] text-[#8a8780]">
      <span>已选 {state.selected.size} 条历史</span>
      <button onClick={()=>{if(confirm('确认携带所选历史换窗？'))void client.confirmSelection()}}>确认</button>
      <button onClick={()=>{if(confirm('确认不携带历史换窗？'))void client.confirmSelection(true)}}>不带历史</button>
      <button onClick={client.cancelSelection}>取消</button>
    </div>}
    {state.notice && <div role="status" className="flex items-center justify-between gap-2 px-3 py-1 text-[12px] text-[#8a8780]">
      <span>{state.notice}</span><button aria-label="关闭提示" onClick={()=>client.notify('')}>×</button>
      {!state.ready&&<button onClick={()=>void client.start()}>重试</button>}
    </div>}
    {state.route && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/25">
      <div role="dialog" aria-modal="true" aria-label="模型路由待决" className="w-full rounded-t-3xl bg-[#faf9f5] p-5 text-[14px]">
        <p>本轮模型路由需要处理。可以修改原消息或取消本轮。</p>
        <div className="mt-4 flex gap-4"><button onClick={()=>void client.resolveRoute('edit')}>重新编辑</button><button onClick={()=>void client.resolveRoute('cancel')}>取消本轮</button></div>
      </div>
    </div>}
  </>
}
