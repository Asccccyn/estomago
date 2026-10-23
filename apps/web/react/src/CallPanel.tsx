// B2/RE-04（2026-10-24）：正式通话面板——est React 页内真实通话入口（非 Siren 测试页）。
// 按钮点击→经 est owner 代理取 Siren 短 call token（内部凭据不进前端）→CallClient 连接。
// 字幕=partial/final/reply；挂断=abort+WS 1000+est 侧 voice_calls 收口。
import { useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff } from 'lucide-react';
import { CallClient } from './call-client'

type Phase = 'idle' | 'connecting' | 'active' | 'ended' | 'error';

export function CallPanel({ conversationId, onExit }: { conversationId: string; onExit: () => void }): React.JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [subtitle, setSubtitle] = useState('');
  const [transcript, setTranscript] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const clientRef = useRef<CallClient | null>(null);
  const callIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setPhase('connecting');
      try {
        const res = await fetch('/api/v1/calls', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: conversationId }),
        });
        if (!res.ok) throw new Error(`建呼失败（${res.status}）`);
        const created = await res.json() as { call_id: string; ws_url: string; token: string };
        if (cancelled) return;
        callIdRef.current = created.call_id;
        const client = new CallClient(created.ws_url, created.token, {
          onState: (s) => { if (s === 'ended') setPhase('ended'); else if (s !== 'connecting') setPhase('active'); },
          onPartial: (t) => setSubtitle(t),
          onFinal: (t) => { setTranscript((prev) => [...prev.slice(-8), `她：${t}`]); setSubtitle(''); },
          onReply: (t) => { setTranscript((prev) => [...prev.slice(-8), `他：${t}`]); },
          onNotice: (t) => setSubtitle(t),
          onError: (m) => { setError(m); setPhase('error'); },
          onMicLevel: (rms) => setMicLevel(Math.min(1, rms * 12)),
        });
        clientRef.current = client;
        await client.connect();
      } catch (err) {
        if (!cancelled) { setError(String((err as Error).message ?? err)); setPhase('error'); }
      }
    })();
    return () => {
      cancelled = true;
      void clientRef.current?.hangup();
      if (callIdRef.current) void fetch(`/api/v1/calls/${encodeURIComponent(callIdRef.current)}`, { method: 'DELETE' });
    };
  }, [conversationId]);

  const hangup = (): void => {
    void clientRef.current?.hangup();
    if (callIdRef.current) void fetch(`/api/v1/calls/${encodeURIComponent(callIdRef.current)}`, { method: 'DELETE' });
    setPhase('ended');
    setTimeout(onExit, 500);
  };

  const toggleMute = (): void => {
    const next = !muted;
    setMuted(next);
    // 静音=本地不上行候选（按协议以 abort 取消当前输入；恢复后新输入自动开始）
    if (next) clientRef.current?.interrupt();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-[#141310] px-6 py-10 text-[#f5f2ea]">
      <div className="mt-6 text-center">
        <div className="text-[15px] opacity-70">{phase === 'connecting' ? '正在接通…' : phase === 'active' ? '通话中' : phase === 'ended' ? '已结束' : '连接失败'}</div>
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
