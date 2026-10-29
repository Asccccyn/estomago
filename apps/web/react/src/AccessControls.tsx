import { useEffect, useState } from 'react'
import type { EstomagoClient } from './chat-client'

type AccessSettings = {
  configured_entry: string
  sdk_model: string | null; sdk_proxy_configured: boolean; sdk_login_verified: boolean
  access: { policy: 'configured' | 'subscription-first'; actual_entry: string | null; next_entry?: string; last_error?: string | null
    subscription: { status: string; limit_type?: string | null; resets_at?: string | null; reset_state?: string; extra_usage?: string } }
}
const entryName = (value: string | null | undefined) => value === 'claude-agent-sdk' ? 'Claude 订阅 SDK' : value === 'openrouter' ? 'OpenRouter' : value === 'deepseek' ? 'DeepSeek' : '尚无已派发请求'

export function AccessControls({ client, onClose }: { client: EstomagoClient; onClose: () => void }) {
  const [settings, setSettings] = useState<AccessSettings | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = async () => { try { setSettings(await client.accessSettings() as AccessSettings); setError('') } catch (e) { setError((e as Error).message) } }
  useEffect(() => { void refresh() }, [client])
  const change = async (policy: 'configured' | 'subscription-first') => {
    setBusy(true)
    try { await client.setAccessPolicy(policy); await refresh() } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  const status = settings?.access.subscription
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/25" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="模型接入设置" onClick={e => e.stopPropagation()} className="w-full max-w-xl rounded-t-3xl bg-[#faf9f5] p-5 text-[14px] text-[#3d3929]">
      <div className="mb-4 flex justify-between"><h2 className="text-[17px] font-medium">模型接入</h2><button onClick={onClose} aria-label="关闭模型接入设置">关闭</button></div>
      <label className="block">接入策略
        <select aria-label="接入策略" className="mt-2 w-full rounded-lg border border-black/10 bg-white p-2" disabled={!settings || busy} value={settings?.access.policy ?? 'configured'} onChange={e => void change(e.target.value as 'configured' | 'subscription-first')}>
          <option value="configured">{settings?.configured_entry === 'openrouter' ? 'API · OpenRouter' : `使用配置入口 · ${entryName(settings?.configured_entry)}`}</option>
          <option value="subscription-first">订阅 SDK 优先，额度耗尽后自动 OR</option>
        </select>
      </label>
      <p className="mt-3">最近实际入口：{entryName(settings?.access.actual_entry)}</p>
      <p>下一安全回合：{entryName(settings?.access.next_entry)}</p>
      <p>订阅型号：{settings?.sdk_model ?? '未配置'}</p>
      <p>订阅额度：{status?.status === 'rejected' ? '已拒绝' : status?.status === 'allowed_warning' ? '接近限额' : status?.status === 'allowed' ? '可用' : '尚未核验'}</p>
      <p>订阅重置：{status?.resets_at ? new Date(status.resets_at).toLocaleString() : '尚未取得重置时间'}{status?.reset_state === 'due_for_sdk_check' ? ' · 下一回合重新核验 SDK' : ''}</p>
      <p>额外付费：{status?.extra_usage === 'active' ? '检测到使用，已阻断' : status?.extra_usage === 'enabled' ? '账号已启用，SDK 已阻断' : settings?.sdk_login_verified ? '按已确认的账户设置使用；未知状态可继续，检测到开启或使用时阻断' : '等待账户设置确认'}</p>
      {settings && !settings.sdk_model && <p className="mt-3">尚未配置订阅模型。</p>}
      {settings && !settings.sdk_login_verified && <p>本机官方订阅登录待核验。</p>}
      {settings && !settings.sdk_proxy_configured && <p>家宽代理待配置，正式 SDK 请求保持阻塞。</p>}
      {settings?.access.last_error && <p className="mt-2">最近状态：{settings.access.last_error}</p>}
      {error && <p role="alert" className="mt-2 text-[#a54b35]">{error}</p>}
      <p className="mt-3 text-[12px] text-[#8a8780]">策略在安全回合边界生效；已经开始输出或执行工具的回合不会整轮重发。网络故障不会触发额度回退。</p>
      <button className="mt-4 rounded-lg border border-black/10 px-3 py-2" onClick={() => void refresh()}>刷新状态</button>
    </section>
  </div>
}
