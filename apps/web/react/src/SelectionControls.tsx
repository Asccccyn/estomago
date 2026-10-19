import { Check } from 'lucide-react'

// 多选（人工选集）专用控件——她 2026-10-18：交互参照微信（左缘圆圈、整条可点、
// 底部操作栏），视觉沿用现有前端设计语言（#c96442 主题 / #8a8780 辅灰 / 圆角 / 细边框）。
// 多选只带文本：图片消息在多选列表以「[图片]」占位显示，装配层 textOnly 保证不带入新窗。

/** 左缘勾选圆圈（微信式：空心圈 → 选中实心主题色对勾） */
export function SelectionCheck({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className={`mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition ${checked ? 'border-[#c96442] bg-[#c96442] text-white' : 'border-black/15 bg-transparent text-transparent'}`}>
      <Check size={10} strokeWidth={2.5} />
    </span>
  )
}

/** 多选模式下的消息体占位：图片/语音不渲染媒体控件，只显示占位行 + 文本 */
export function SelectionMediaText({ kind, text }: { kind: string; text: string }) {
  const label = kind === 'voice' ? '[语音]' : '[图片]'
  return (
    <span className="block whitespace-pre-wrap break-words rounded-2xl bg-black/5 px-3 py-2 text-[14px] leading-[1.6] text-[#5e5d59]">
      {label}{text ? ` ${text}` : ' · 只带文本，不随多选带入新窗'}
    </span>
  )
}

/** 底部操作栏（微信式：取消 / 不带历史 / 确认携带） */
export function SelectionBar({ count, onConfirm, onEmpty, onCancel }: { count: number; onConfirm: () => void; onEmpty: () => void; onCancel: () => void }) {
  return (
    <div role="toolbar" aria-label="历史多选操作" className="flex items-center justify-between gap-3 px-5 pb-2 pt-1 text-[14px]">
      <button onClick={onCancel} className="rounded-xl px-3 py-1.5 text-[#8a8780] hover:bg-black/5">取消</button>
      <div className="flex items-center gap-2">
        <button onClick={onEmpty} className="rounded-xl px-3 py-1.5 text-[13px] text-[#8a8780] hover:bg-black/5">不带历史</button>
        <button
          onClick={onConfirm}
          disabled={count === 0}
          aria-label={`携带所选 ${count} 条文本历史换窗`}
          className={`rounded-xl px-4 py-1.5 transition ${count === 0 ? 'cursor-not-allowed bg-[#f3f1ea] text-[#a3a099]' : 'bg-[#c96442] text-white hover:opacity-90'}`}
        >
          带所选换窗{count > 0 ? `（${count}）` : ''}
        </button>
      </div>
    </div>
  )
}
