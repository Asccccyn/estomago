import { useEffect, useState } from 'react'
import type { EstomagoClient } from './chat-client'

type AccessSettings = {
  configured_entry: string
  sdk_model: string | null; sdk_proxy_configured: boolean; sdk_login_verified: boolean
  or_model: { effective: string | null }
  access: { policy: 'configured' | 'subscription-first'; actual_entry: string | null; next_entry?: string; last_error?: string | null
    subscription: { status: string; limit_type?: string | null; resets_at?: string | null; reset_state?: string; extra_usage?: string } }
}
const entryName = (value: string | null | undefined) => value === 'claude-agent-sdk' ? 'Claude 订阅 SDK' : value === 'openrouter' ? 'OpenRouter' : value === 'deepseek' ? 'DeepSeek' : '尚无已派发请求'

export function AccessControls({ client, onClose }: { client: EstomagoClient; onClose: () => void }) {
  const [settings, setSettings] = useState<AccessSettings | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = async () => { setSettings(await client.accessSettings() as AccessSettings); setError('') }
  useEffect(() => { void refresh().catch(e => setError((e as Error).message)) }, [client])
  const change = async (policy: 'configured' | 'subscription-first') => {
    setBusy(true); setNotice('')
    try { await client.setAccessPolicy(policy); await refresh(); setNotice('已保存，下一回合使用所选入口；刷新页面或重启服务后仍保留。') } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  const status = settings?.access.subscription
  return <main className="min-h-screen bg-[#faf9f5] px-5 py-8 text-[14px] text-[#3d3929]">
    <section aria-label="模型接入设置" className="mx-auto w-full max-w-xl">
      <div className="mb-6 flex items-center justify-between"><h1 className="text-[21px] font-medium">SDK / API key</h1><button onClick={onClose}>返回聊天</button></div>
      <p className="mb-5 text-[#8a8780]">选择聊天使用的模型入口。保存后由后端执行，无需重启。</p>
      <label className="block">模型执行入口
        <select aria-label="模型执行入口" className="mt-2 w-full rounded-lg border border-black/10 bg-white p-3" disabled={!settings || busy} value={settings?.access.policy ?? 'configured'} onChange={e => void change(e.target.value as 'configured' | 'subscription-first')}>
          <option value="subscription-first">SDK · Claude 订阅</option>
          <option value="configured">API key · {entryName(settings?.configured_entry)}</option>
        </select>
      </label>
      {busy && <p role="status" className="mt-3">正在保存…</p>}
      {notice && <p role="status" className="mt-3">{notice}</p>}
      <p className="mt-3 text-[12px] text-[#8a8780]">SDK 使用本机官方订阅登录；API key 使用后端已配置的 {entryName(settings?.configured_entry)} 凭据。</p>
      <p className="mt-3">当前选择：{!settings ? '正在读取…' : settings.access.policy === 'subscription-first' ? 'SDK · Claude 订阅' : `API key · ${entryName(settings.configured_entry)}`}</p>
      <p className="mt-3">最近实际入口：{entryName(settings?.access.actual_entry)}</p>
      <p>下一安全回合：{entryName(settings?.access.next_entry)}</p>
      <p>订阅型号：{settings?.sdk_model ?? '未配置'}</p>
      {settings?.configured_entry === 'openrouter' && <p>API 型号：{settings.or_model.effective ?? '未配置'}</p>}
      <p>订阅额度：{status?.status === 'rejected' ? '已拒绝' : status?.status === 'allowed_warning' ? '接近限额' : status?.status === 'allowed' ? '可用' : '尚未核验'}</p>
      <p>订阅重置：{status?.resets_at ? new Date(status.resets_at).toLocaleString() : '尚未取得重置时间'}{status?.reset_state === 'due_for_sdk_check' ? ' · 下一回合重新核验 SDK' : ''}</p>
      <p>额外付费：{status?.extra_usage === 'active' ? '检测到使用，已阻断' : status?.extra_usage === 'enabled' ? '账号已启用，SDK 已阻断' : settings?.sdk_login_verified ? '按已确认的账户设置使用；未知状态可继续，检测到开启或使用时阻断' : '等待账户设置确认'}</p>
      {settings && !settings.sdk_model && <p className="mt-3">尚未配置订阅模型。</p>}
      {settings && !settings.sdk_login_verified && <p>本机官方订阅登录待核验。</p>}
      {settings && !settings.sdk_proxy_configured && <p>家宽代理待配置，正式 SDK 请求保持阻塞。</p>}
      {settings?.access.last_error && <p className="mt-2">最近状态：{settings.access.last_error}</p>}
      {error && <p role="alert" className="mt-2 text-[#a54b35]">{error}</p>}
      <p className="mt-3 text-[12px] text-[#8a8780]">切换在下一回合生效，当前回合继续使用原入口。当前有效上下文继续保留，不会因此换窗。</p>
      <p className="mt-2 text-[12px] text-[#8a8780]">订阅额度被明确拒绝且本轮尚未输出或执行工具时，按现有策略回退 OpenRouter；网络、登录故障和 flag 不触发额度回退。</p>
      <button className="mt-5 rounded-lg border border-black/10 px-3 py-2" disabled={busy} onClick={() => void refresh().catch(e => setError((e as Error).message))}>刷新状态</button>
      <a href="/settings/account" className="ml-4 underline">账号与密码</a>
    </section>
  </main>
}
