// B2/RE-04（2026-10-24）：正式通话面板——est React 页内真实通话入口（非 Siren 测试页）。
// 按钮点击→经 est owner 代理取 Siren 短 call token（内部凭据不进前端）→CallClient 连接。
// 字幕=partial/final/reply；挂断=abort+WS 1000+est 侧 voice_calls 收口。
// F-02（跨仓预审 2026-10-25）：incoming=接听来电的直连信息（宿主在邀请 accept 时已建
// 通话并交付连接）——此模式不发起 dial、不等char接听。F-03：静音=客户端真停上行。
import { useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff } from 'lucide-react';
import { CallClient } from './call-client'

type Phase = 'idle' | 'connecting' | 'active' | 'ended' | 'error';

export function CallPanel({ conversationId, onExit, incoming }: { conversationId: string; onExit: () => void; incoming?: { ws_url: string; token: string; call_id: string } }): React.JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [subtitle, setSubtitle] = useState('');
  const [transcript, setTranscript] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const clientRef = useRef<CallClient | null>(null);
  const callIdRef = useRef<string | null>(null);

  // 她→他通话请求（2026-10-24）：先请char接/拒，再按状态走
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let dialId: string | null = null;
    const cleanupDial = (): void => { if (dialId) void fetch(`/api/v1/calls/dial/${encodeURIComponent(dialId)}`, { method: 'DELETE' }); };
    const connectCall = (wsUrl: string, token: string, callId: string): void => {
      callIdRef.current = callId;
      const client = new CallClient(wsUrl, token, {
        onState: (s) => { if (s === 'ended') setPhase('ended'); else if (s !== 'connecting') setPhase('active'); },
        onPartial: (t) => setSubtitle(t),
        onFinal: (t) => { setTranscript((prev) => [...prev.slice(-8), `她：${t}`]); setSubtitle(''); },
        onReply: (t) => { setTranscript((prev) => [...prev.slice(-8), `他：${t}`]); },
        onNotice: (t) => setSubtitle(t),
        onError: (m) => { setError(m); setPhase('error'); },
        onMicLevel: (rms) => setMicLevel(Math.min(1, rms * 12)),
      });
      clientRef.current = client;
      // JV-20（联合审计 2026-10-26）：WS 连接失败必须收口——connect 的 rejection
      // 不再无人处理（unhandled + 面板永远停在 connecting），如实报错并结束等待
      client.connect().catch(() => { if (!cancelled) { setError('通话连接失败（服务不可达或已过期）'); setPhase('error'); } });
    };
    const poll = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/v1/calls/dial/current', { cache: 'no-store' });
        const cur = await res.json() as { state?: string; ws_url?: string; token?: string; call_id?: string; request_id?: string };
        if (cancelled) return;
        if (cur.request_id) dialId = cur.request_id;
        if (cur.state === 'accepted' && cur.ws_url && cur.token && cur.call_id) { dialId = null; connectCall(cur.ws_url, cur.token, cur.call_id); return; }
        if (cur.state === 'declined') { setPhase('ended'); setError('他没有接——他说的话在聊天里'); setTimeout(onExit, 1600); return; }
        if (cur.state === 'expired') { setPhase('ended'); setError('他没有应答'); setTimeout(onExit, 1600); return; }
        pollTimer = setTimeout(() => void poll(), 1500);
      } catch { pollTimer = setTimeout(() => void poll(), 2000); }
    };
    void (async () => {
      setPhase('connecting');
      // F-02：接听来电的直连模式——宿主已建通话，直接连接（不反向拨号）
      if (incoming) { connectCall(incoming.ws_url, incoming.token, incoming.call_id); return; }
      try {
        const res = await fetch('/api/v1/calls/dial', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const created = await res.json().catch(() => null) as { request_id?: string; state?: string; ws_url?: string; token?: string; call_id?: string; error?: { message?: string } | null } | null;
        if (cancelled) return;
        // JV-20：拨号被拒（503/502 等错误 body）=等待结束——不再把错误 body 当成功
        // 轮询下去；释放已获得的请求（cleanupDial 语义）
        if (!res.ok || !created || typeof created.state !== 'string') {
          setError(`拨号失败：${created?.error?.message ?? res.status}`);
          setPhase('error');
          if (created?.request_id) { dialId = created.request_id; cleanupDial(); }
          return;
        }
        if (created.state === 'accepted' && created.ws_url) { connectCall(created.ws_url, created.token!, created.call_id!); return; }
        if (created.request_id) dialId = created.request_id;
        void poll(); // 等char接/拒
      } catch (err) {
        if (!cancelled) { setError(String((err as Error).message ?? err)); setPhase('error'); }
      }
    })();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      cleanupDial(); // 等待中关闭面板=取消请求（他 accept 时会得到 DIAL_SUPERSEDED）
      void clientRef.current?.hangup();
      if (callIdRef.current) void fetch(`/api/v1/calls/${encodeURIComponent(callIdRef.current)}`, { method: 'DELETE' });
    };
  }, [conversationId]);

  const hangup = (): void => {
    void clientRef.current?.hangup();
    if (callIdRef.current) void fetch(`/api/v1/calls/${encodeURIComponent(callIdRef.current)}`, { method: 'DELETE' });
    else void fetch('/api/v1/calls/dial/current', { cache: 'no-store' }).then((r) => r.json()).then((c: { request_id?: string }) => { if (c.request_id) void fetch(`/api/v1/calls/dial/${encodeURIComponent(c.request_id)}`, { method: 'DELETE' }); }).catch(() => undefined);
    setPhase('ended');
    setTimeout(onExit, 500);
  };

  const toggleMute = (): void => {
    const next = !muted;
    setMuted(next);
    // F-03：静音=客户端真停上行（不上传采集帧、收尾在途输入）；不再用未协商的 interrupt 冒充
    clientRef.current?.setMuted(next);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-[#141310] px-6 py-10 text-[#f5f2ea]">
      <div className="mt-6 text-center">
        <div className="text-[15px] opacity-70">{phase === 'connecting' ? '正在叫char…（他可以接听或拒绝）' : phase === 'active' ? '通话中' : phase === 'ended' ? '已结束' : '连接失败'}</div>
        {error && <div className="mt-2 max-w-sm text-[13px] text-[#e08d6d]">{error}</div>}
      </div>
      <div className="flex w-full max-w-md flex-1 flex-col justify-end gap-1 overflow-hidden pb-6">
        {transcript.map((line, i) => (
          <div key={i} className={`text-[14px] leading-relaxed ${line.startsWith('她：') ? 'self-end text-right opacity-90' : 'self-start text-left'}`}>{line}</div>
        ))}
        {subtitle && <div className="text-[13px] italic opacity-50">{subtitle}</div>}
      </div>
      <div className="flex items-center gap-8">
        <button onClick={toggleMute} title={muted ? '取消静音' : '静音'} className={`flex h-14 w-14 items-center justify-center rounded-full ${muted ? 'bg-[#e08d6d] text-white' : 'bg-white/10'}`}>
          {muted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/20">
          <div className="h-10 w-10 rounded-full bg-[#77b583] transition-all" style={{ transform: `scale(${0.5 + micLevel * 0.5})`, opacity: 0.5 + micLevel * 0.5 }} />
        </div>
        <button onClick={hangup} title="挂断" className="flex h-16 w-16 items-center justify-center rounded-full bg-[#d9534f] text-white shadow-lg active:scale-95">
          <PhoneOff size={24} />
        </button>
      </div>
      <div className="text-[11px] opacity-40">同一会话 · 通话期间仅记忆能力 · <Phone size={10} className="inline" /> est↔Siren</div>
    </div>
  );
}
