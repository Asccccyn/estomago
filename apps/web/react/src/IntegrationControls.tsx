import type { EstomagoClient, Snapshot } from './chat-client'
export function IntegrationControls({client,state}: {client:EstomagoClient;state:Snapshot}) {
  return <>
    {/* selectionMode 界面（已选计数/确认/取消）2026-10-18 起移至 App 多选模式：header 计数 + 底部 SelectionBar（微信式，见 SelectionControls.tsx） */}
    {state.notice && <div role="status" className="flex items-center justify-between gap-2 px-3 py-1 text-[12px] text-[#8a8780]">
      <span>{state.notice}</span><button aria-label="关闭提示" onClick={()=>client.notify('')}>×</button>
      {!state.ready&&<button onClick={()=>void client.start()}>重试</button>}
    </div>}
    {state.route && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/25">
      <div role="dialog" aria-modal="true" aria-label="模型路由待决" className="w-full rounded-t-3xl bg-[#faf9f5] p-5 text-[14px]">
        <p>本轮回答被切换了模型。已生成的部分回答已保留并标记中断；可以接受路由结果继续，也可以修改原消息或取消本轮。</p>
        <div className="mt-4 flex gap-4"><button onClick={()=>void client.resolveRoute('approve')}>接受并继续</button><button onClick={()=>void client.resolveRoute('edit')}>重新编辑</button><button onClick={()=>void client.resolveRoute('cancel')}>取消本轮</button></div>
      </div>
    </div>}
  </>
}
