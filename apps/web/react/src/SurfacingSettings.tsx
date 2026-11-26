// SOL_RECALL_REFACTOR（2026-10-30）：自动记忆浮现设置面。
// 服务端是权威——加载前显示"加载中/未知"（不默认开）；凭据只显示配置
// 状态、绝不回显值；判断模板预览与实际 Sol 请求同一生效值读者（服务端
// settingsView）；保存/重置失败回滚并显示原因。独立组件自持状态。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EstomagoClient } from './chat-client'
import { X, RotateCcw } from 'lucide-react'

type Json = Record<string, any>

export function SurfacingSettings({ client, onClose }: { client: EstomagoClient; onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<Json | null>(null)
  const [busy, setBusy] = useState(false)
  const [modelDraft, setModelDraft] = useState('')
  const [templateDraft, setTemplateDraft] = useState<string | null>(null) // null=跟随默认
  const [notice, setNotice] = useState('')
  const generation = useRef(0)

  const apply = useCallback((v: Json) => {
    setView(v)
    const sol = v.sol ?? {}
    setModelDraft(String(sol.model ?? ''))
    setTemplateDraft(null) // 编辑区永远从"当前生效值"开始，未改动即不提交
  }, [])

  const refresh = useCallback(async () => {
    const g = ++generation.current
    setError(null)
    try {
      const v = await client.surfacingSettings()
      if (g !== generation.current) return
      apply(v)
    } catch (e) {
      if (g !== generation.current) return
      setError((e as Error).message || '加载失败')
    } finally {
      if (g === generation.current) setLoading(false)
    }
  }, [client, apply])

  useEffect(() => { void refresh(); return () => { generation.current++ } }, [refresh])

  const save = useCallback(async (patch: Json, okNote: string) => {
    setBusy(true); setNotice(''); setError(null)
    try {
      const v = await client.surfacingPutSettings(patch)
      apply(v)
      setNotice(okNote)
    } catch (e) {
      setError((e as Error).message || '保存失败')
    } finally { setBusy(false) }
  }, [client, apply])

  const sol = (view?.sol ?? {}) as Json
  const effectiveTemplate = typeof sol.effective_template === 'string' ? sol.effective_template : ''
  const templateDirty = templateDraft !== null && templateDraft !== effectiveTemplate

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-label="自动记忆浮现设置">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="sheet-in relative max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-[#faf9f5] px-5 pt-3 pb-[max(env(safe-area-inset-bottom),24px)] sm:rounded-3xl no-bar">
        <div className="sticky top-0 z-10 -mx-5 mb-3 flex items-center justify-between border-b border-black/5 bg-[#faf9f5]/95 px-5 pb-2 pt-1 backdrop-blur">
          <h2 className="text-[15px] font-medium">自动记忆浮现</h2>
          <button aria-label="关闭" onClick={onClose} className="rounded-lg p-1 text-[#8a8780] hover:bg-black/5"><X size={18} /></button>
        </div>

        {loading && <p className="py-6 text-center text-[13px] text-[#8a8780]">加载中…</p>}
        {error && <p className="mb-3 rounded-xl bg-[#fdeceb] px-3 py-2 text-[13px] text-[#b4483a]">{error}</p>}
        {notice && <p className="mb-3 rounded-xl bg-[#e8f3e6] px-3 py-2 text-[13px] text-[#4a7c4e]">{notice}</p>}

        {view && !loading && (
          <div className="space-y-4 text-[13.5px]">
            <section className="rounded-2xl border border-black/10 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">自动浮现</p>
                  <p className="mt-0.5 text-[12px] text-[#8a8780]">开启后每条正式消息由检索判断模型先判断，再决定是否查回忆。</p>
                </div>
                <button
                  disabled={busy}
                  onClick={() => void save({ enabled: !view.enabled }, view.enabled ? '已关闭' : '已开启')}
                  className={`relative h-7 w-12 shrink-0 rounded-full transition ${view.enabled ? 'bg-[#c96442]' : 'bg-black/15'}`}
                  aria-pressed={!!view.enabled} aria-label={view.enabled ? '关闭自动浮现' : '开启自动浮现'}>
                  <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${view.enabled ? 'left-[22px]' : 'left-0.5'}`} />
                </button>
              </div>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
                <dt className="text-[#8a8780]">判断凭据</dt>
                <dd>{sol.configured ? <span className="text-[#4a7c4e]">已配置</span> : <span className="text-[#b4483a]">未配置（作业会以真实原因收口，不伪装"无需回忆"）</span>}</dd>
                <dt className="text-[#8a8780]">缓存期限</dt><dd>{String(sol.cache_ttl ?? '—')}</dd>
                <dt className="text-[#8a8780]">模板版本</dt><dd>{String(sol.template_revision ?? '—')}{sol.template_source === 'override' ? '（自定义覆盖）' : '（内置默认）'}</dd>
              </dl>
            </section>

            <section className="rounded-2xl border border-black/10 bg-white p-4">
              <p className="font-medium">判断模型</p>
              <div className="mt-2 flex gap-2">
                <input value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} disabled={busy}
                  className="min-w-0 flex-1 rounded-xl border border-black/10 px-3 py-2 text-[13px] outline-none focus:border-[#c96442]" placeholder="gpt-6.1-sol" />
                <button disabled={busy || modelDraft === String(sol.model ?? '')} onClick={() => void save({ model: modelDraft }, '模型已保存')}
                  className="rounded-xl bg-[#c96442] px-3 py-2 text-[13px] text-white disabled:opacity-40">保存</button>
              </div>
            </section>

            <section className="rounded-2xl border border-black/10 bg-white p-4">
              <div className="flex items-center justify-between">
                <p className="font-medium">判断模板</p>
                <button disabled={busy || sol.template_source !== 'override'} onClick={() => void save({ decision_template: null }, '已重置为内置默认')}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-[#8a8780] hover:bg-black/5 disabled:opacity-40"><RotateCcw size={13} />重置默认</button>
              </div>
              <p className="mt-1 text-[12px] text-[#8a8780]">预览与实际请求正文同源。留空保存=沿用当前生效模板。</p>
              <textarea value={templateDraft ?? effectiveTemplate} onChange={(e) => setTemplateDraft(e.target.value)} disabled={busy}
                className="mt-2 h-40 w-full resize-none rounded-xl border border-black/10 p-3 font-mono text-[11.5px] leading-relaxed outline-none focus:border-[#c96442]" spellCheck={false} />
              <div className="mt-2 flex justify-end">
                <button disabled={busy || !templateDirty} onClick={() => void save({ decision_template: templateDraft }, '模板已保存')}
                  className="rounded-xl bg-[#c96442] px-3 py-2 text-[13px] text-white disabled:opacity-40">保存模板</button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
