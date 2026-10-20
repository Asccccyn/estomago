import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { canSend, shouldSendOnKeydown } from '../../src/composer-logic.js'

type Props = {
  value: string
  onChange: (value: string) => void
  onCancel: () => void
  onSave: () => Promise<boolean>
  canRetry: boolean
  pending?: boolean
  unconfirmed?: boolean
  hasAttachment?: boolean
  children?: ReactNode
}

/** Edit the original body in place; attachment transcripts are never copied into it. */
export function InlineMessageEditor({ value, onChange, onCancel, onSave, canRetry, pending, unconfirmed, hasAttachment, children }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const submitting = useRef(false)
  const composing = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const locked = busy || Boolean(pending)
  const valid = canSend(value, { hasAttachment: Boolean(hasAttachment), composing: false })

  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = '84px'
    el.style.height = `${Math.min(320, Math.max(84, el.scrollHeight))}px`
  }, [value])

  const save = async () => {
    if (submitting.current || pending || composing.current || !valid) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      if (!await onSave()) setError('未能完成，编辑内容已保留，请重试。')
    } catch {
      setError('未能完成，编辑内容已保留，请重试。')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <div className="w-full rounded-2xl border border-[#d4cec0] bg-[#f4f1e9] p-3 shadow-sm" aria-label="原位编辑消息">
      {children && <div className="mb-3 flex justify-end">{children}</div>}
      <textarea ref={textarea} rows={3} aria-label="编辑消息正文" value={value} readOnly={locked || unconfirmed}
        onChange={(e) => { onChange(e.target.value); setError('') }}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={(e) => { if (shouldSendOnKeydown(e)) { e.preventDefault(); void save() } }}
        className="block max-h-80 w-full resize-none bg-transparent text-[16px] leading-[1.6] text-[#1f1e1d] outline-none" />
      {error && <p role="alert" className="mt-2 text-[12px] leading-relaxed text-[#a54b35]">{error}</p>}
      {unconfirmed && <p role="status" className="mt-2 text-[12px] leading-relaxed text-[#8a8780]">上次提交结果尚未确认。内容已保留，请先确认上次提交，再继续修改。</p>}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <span className="w-full text-[11px] text-[#8a8780] sm:mr-auto sm:w-auto">Enter 换行 · ⌘/Ctrl+Enter 提交</span>
        <button type="button" onClick={onCancel} disabled={locked}
          className="rounded-full border border-[#d4cec0] px-3.5 py-1.5 text-[13px] text-[#5e5d59] hover:bg-black/5 disabled:opacity-50">取消</button>
        <button type="button" onClick={() => void save()} disabled={locked || !valid} aria-busy={locked}
          className="rounded-full bg-[#3d3929] px-3.5 py-1.5 text-[13px] text-white hover:bg-[#514c3c] disabled:opacity-50">
          {locked ? '正在提交…' : unconfirmed ? '确认上次提交' : canRetry ? '保存并重新发送' : '仅保存修改'}
        </button>
      </div>
    </div>
  )
}
