import type { EstomagoClient, Snapshot } from './chat-client'
export function IntegrationControls({client,state}: {client:EstomagoClient;state:Snapshot}) {
  const flagged=state.route?.evidence_code==='SDK_FLAGGED'
  return <>
    {/* selectionMode 界面（已选计数/确认/取消）2026-10-18 起移至 App 多选模式：header 计数 + 底部 SelectionBar（微信式，见 SelectionControls.tsx） */}
    {state.notice && <div role="status" className="flex items-center justify-between gap-2 px-3 py-1 text-[12px] text-[#8a8780]">
      <span>{state.notice}</span><button aria-label="关闭提示" onClick={()=>client.notify('')}>×</button>
      {!state.ready&&<button onClick={()=>void client.start()}>重试</button>}
    </div>}
    {state.route && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/25">
      <div role="dialog" aria-modal="true" aria-label="模型路由待决" className="w-full rounded-t-3xl bg-[#faf9f5] p-5 text-[14px]">
        <p>{flagged?'Anthropic 标记了本轮，回复已暂停。你可以继续尝试，或取消后作为新消息重发。已派发的原消息保持不变。':state.route?.already_switched?'本轮已切换模型，当前已暂停，已生成内容保留。':'本轮收到路由提示，当前已暂停；尚未确认模型已经切换。'}</p>
        <div className="mt-4 flex gap-4"><button onClick={()=>void client.resolveRoute('approve')}>{flagged?'继续尝试':'接受并继续'}</button>{!flagged&&<button onClick={()=>void client.resolveRoute('edit')}>重新编辑</button>}<button onClick={()=>void client.resolveRoute('cancel')}>取消本轮</button></div>
      </div>
    </div>}
  </>
}
