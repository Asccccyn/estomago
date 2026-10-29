import { useEffect, useState } from 'react'
import type { EstomagoClient } from './chat-client'

export function AccountSettings({ client }: { client: EstomagoClient }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    void client.accountSettings().then(data => { setUsername(data.username ?? ''); setReady(true) }).catch(e => setError((e as Error).message))
  }, [client])
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (password !== confirmation) { setError('两次密码不一致。'); return }
    setBusy(true); setMessage(''); setError('')
    try {
      await client.setAccount(username, password, confirmation)
      setMessage('账号密码已更新。本浏览器保持登录，其他浏览器下次请求需要重新登录。')
    } catch (e) { setError((e as Error).message) }
    finally { setPassword(''); setConfirmation(''); setBusy(false) }
  }
  return <main className="min-h-screen bg-[#faf9f5] px-5 py-8 text-[14px] text-[#3d3929]">
    <section className="mx-auto w-full max-w-xl">
      <div className="mb-6 flex items-center justify-between"><h1 className="text-[21px] font-medium">账号与密码</h1><a href="/chat">返回聊天</a></div>
      <p className="mb-5 text-[#8a8780]">设置 estómago 网页的登录账号与密码。此处不修改 Claude 订阅账号或模型 API key。</p>
      <form onSubmit={event => void save(event)} className="space-y-4">
        <label className="block">账号<input aria-label="新账号" autoComplete="username" required maxLength={64} disabled={busy || !ready} value={username} onChange={e => setUsername(e.target.value)} className="mt-2 block w-full rounded-lg border border-black/10 bg-white p-3" /></label>
        <label className="block">新密码<input aria-label="新密码" type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={busy || !ready} value={password} onChange={e => setPassword(e.target.value)} className="mt-2 block w-full rounded-lg border border-black/10 bg-white p-3" /></label>
        <p className="text-[12px] text-[#8a8780]">至少 12 字；可以使用较长、容易记住的密码短语。请不要把密码发到聊天里。</p>
        <label className="block">再次输入新密码<input aria-label="确认新密码" type="password" autoComplete="new-password" required minLength={12} maxLength={256} disabled={busy || !ready} value={confirmation} onChange={e => setConfirmation(e.target.value)} className="mt-2 block w-full rounded-lg border border-black/10 bg-white p-3" /></label>
        <button disabled={busy || !ready} className="rounded-lg bg-[#c96442] px-4 py-3 text-white disabled:opacity-50">{busy ? '正在保存…' : '保存账号密码'}</button>
      </form>
      {error && <p role="alert" className="mt-4 text-[#a54b35]">{error}</p>}
      {message && <p role="status" className="mt-4">{message}</p>}
      <a href="/settings/model-access" className="mt-6 inline-block underline">SDK / API key 设置</a>
    </section>
  </main>
}
