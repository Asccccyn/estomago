// 协议①（2026-10-24）：来电横幅 + 未接/拒接卡片——est 代理 Siren 邀请（内部凭据不进前端）。
// 横幅只在有 pending 邀请时出现（Siren 服务端过期，不依赖本页轮询保活；轮询仅用于展示）；
// 接听=先落邀请终态、宿主建好通话拿到连接信息再打开通话面板；拒接=直接落终态（不自动补打）。
// F-02（跨仓预审 2026-10-25）：接/拒以服务端终态为准（失败不进通话、横幅不凭旧缓存滞留）。
import { useEffect, useState } from 'react';
import { Phone, PhoneOff, X, Clock } from 'lucide-react';

type Invite = { invite_id: string; state: string; expires_at?: number; created_at?: number; ended_reason?: string | null };

const LABELS: Record<string, string> = { expired: '未接来电', declined: '已拒接', cancelled: '已取消', accepted: '已接听' };

export function CallInvites({ onAccept }: { onAccept: (conn: { ws_url: string; token: string; call_id: string }) => void }): React.JSX.Element | null {
  const [active, setActive] = useState<Invite | null>(null);
  const [recent, setRecent] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('/api/v1/calls/invites', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json() as { active: Invite | null; recent: Invite[] };
        if (stop) return;
        // 服务端权威：active 变 null（过期/取消/接听）即撤横幅，不保留旧 pending
        setActive(data.active ?? null);
        setRecent((data.recent ?? []).slice(0, 3));
      } catch { /* 服务不可达=无来电显示，聊天不受影响 */ }
    };
    void load();
    const timer = setInterval(load, 5000); // 仅展示刷新；过期回收在服务端
    return () => { stop = true; clearInterval(timer); };
  }, []);

  const act = async (id: string, action: 'accept' | 'decline'): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/calls/invites/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      const out = await res.json().catch(() => null) as { state?: string; call_id?: string; ws_url?: string; token?: string } | null;
      if (action === 'accept') {
        // 只有服务端确认 accepted 且宿主已交付通话连接才进入通话面板；
        // 过期/冲突（state=expired 等）保持横幅，下次轮询按服务端状态如实刷新
        if (out?.state === 'accepted' && out.call_id && out.ws_url && out.token) {
          onAccept({ ws_url: out.ws_url, token: out.token, call_id: out.call_id });
        }
      } else if (out?.state === 'declined') {
        setActive(null);
      }
    } catch { /* 失败=下次轮询按服务端状态刷新 */ }
    setBusy(false);
  };

  return (
    <>
      {active && active.state === 'pending' && (
        <div className="pointer-events-auto fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-3">
          <div className="pop-in flex w-full max-w-sm items-center gap-3 rounded-2xl border border-black/10 bg-white px-4 py-3 shadow-xl">
            <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-[#77b583] text-white">
              <Phone size={18} className="animate-pulse" />
            </span>
            <div className="flex-1">
              <div className="text-[14px] font-medium">char来电</div>
              <div className="text-[11.5px] text-[#8a8780]">接听后进入语音通话 · 通话期间仅保留记忆能力</div>
            </div>
            <button disabled={busy} onClick={() => void act(active.invite_id, 'accept')} className="flex h-10 w-10 items-center justify-center rounded-full bg-[#77b583] text-white active:scale-95 disabled:opacity-50" aria-label="接听">
              <Phone size={16} />
            </button>
            <button disabled={busy} onClick={() => void act(active.invite_id, 'decline')} className="flex h-10 w-10 items-center justify-center rounded-full bg-[#d9534f] text-white active:scale-95 disabled:opacity-50" aria-label="拒接">
              <PhoneOff size={16} />
            </button>
          </div>
        </div>
      )}
      {recent.length > 0 && (
        <div className="mx-auto mb-1 flex max-w-72 flex-col gap-1 px-4">
          {recent.map((r) => (
            <div key={r.invite_id} className="flex items-center gap-2 rounded-xl bg-[#f0ede5] px-3 py-1.5 text-[11.5px] text-[#8a8780]">
              <Clock size={12} />
              <span>{LABELS[r.state] ?? r.state}{r.state === 'expired' ? '（他没有等到你接）' : ''}</span>
              {r.state === 'expired' && <X size={10} className="opacity-40" />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
