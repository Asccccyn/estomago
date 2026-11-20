// B2/RE-04（2026-10-24）：正式通话面板——est React 页内真实通话入口（非 Siren 测试页）。
// 按钮点击→经 est owner 代理取 Siren 短 call token（内部凭据不进前端）→CallClient 连接。
// 字幕=partial/final/reply；挂断=abort+WS 1000+est 侧 voice_calls 收口。
// F-02（跨仓预审 2026-10-25）：incoming=接听来电的直连信息（宿主在邀请 accept 时已建
// 通话并交付连接）——此模式不发起 dial、不等char接听。F-03：静音=客户端真停上行。
import { useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Minimize2 } from 'lucide-react';
import { CallClient, type CallClientEvents } from './call-client'
import { microphoneEnvironmentIssue, secureMicrophoneUrl } from '../../src/microphone-access.js'

type Phase = 'idle' | 'connecting' | 'active' | 'ended' | 'error';

// P6（四仓审计 20261106，V02/U04）：mode=deep_listen=专属深听电话入口——拨号请求
// 显式携带 analysis_mode；后端沿 dial_requests→accept→voice_calls 全程绑定该模式
// （普通电话显式 ordinary；模式属于新通话意图，不改旧连接）。
export function CallPanel({ conversationId, onExit, incoming, mode = 'ordinary' }: { conversationId: string; onExit: () => void; incoming?: { ws_url: string; token: string; call_id: string }; mode?: 'ordinary' | 'deep_listen' }): React.JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [subtitle, setSubtitle] = useState('');
  const [transcript, setTranscript] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const [callState, setCallState] = useState<Parameters<CallClientEvents['onState']>[0]>('connecting');
  const [inputAvailable, setInputAvailable] = useState(false);
  // B5（2026-11-04，执行稿 B5）：悬浮最小化——纯展示态切换。缩小不走 onExit（卸载会挂断），
  // 同一 CallClient/call_id/effect 生命周期全程保持；通话中可回聊天页打字（B4 事实已区分此场景）。
  const [minimized, setMinimized] = useState(false);
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
        onState: (s) => {
          setCallState(s);
          if (s === 'ended') setPhase((current) => current === 'error' ? current : 'ended');
          else if (s !== 'connecting' && s !== 'error') setPhase('active');
        },
        onPartial: (t) => setSubtitle(t),
        onFinal: (t) => { setTranscript((prev) => [...prev.slice(-8), `她：${t}`]); setSubtitle(''); },
        onReply: (t) => { setTranscript((prev) => [...prev.slice(-8), `他：${t}`]); },
        onNotice: (t) => setSubtitle(t),
        onError: (m) => { setError(m); setPhase('error'); },
        onMicLevel: (rms) => setMicLevel(Math.min(1, rms * 12)),
        onInputAvailable: setInputAvailable,
      });
      clientRef.current = client;
      // JV-20（联合审计 2026-10-26）：WS 连接失败必须收口——connect 的 rejection
      // 不再无人处理（unhandled + 面板永远停在 connecting），如实报错并结束等待
      client.connect().catch(() => {
        if (!cancelled) {
          setError((current) => current ?? '通话连接失败（服务不可达或已过期）');
          setPhase('error');
        }
      });
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
      const unavailable = microphoneEnvironmentIssue();
      if (unavailable) { setError(unavailable); setPhase('error'); return; }
      setPhase('connecting');
      // F-02：接听来电的直连模式——宿主已建通话，直接连接（不反向拨号）
      if (incoming) { connectCall(incoming.ws_url, incoming.token, incoming.call_id); return; }
      try {
        const res = await fetch('/api/v1/calls/dial', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mode === 'deep_listen' ? { analysis_mode: 'deep_listen' } : {}) });
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

  // RVO-03（复审 20261106 第二轮）：本地挂断后按宿主回执的 media_close 如实收尾——
  // est 已收口 ≠ 远端已确认结束：hangup_requested=柔性挂断已受理（约15秒窗口，她开口会取消）；
  // siren_unavailable=远端不可达（真实停止由 Siren 生命周期/对账收口）；session_not_active=无在途会话。
  const hangup = (): void => {
    void clientRef.current?.hangup();
    if (callIdRef.current) {
      void fetch(`/api/v1/calls/${encodeURIComponent(callIdRef.current)}`, { method: 'DELETE' })
        .then((r) => r.json().catch(() => null))
        .then((b: { media_close?: string } | null) => {
          if (b?.media_close === 'hangup_requested') setError('已挂断；他那边约15秒内说完就结束（期间他开口会继续）');
          else if (b?.media_close === 'siren_unavailable') setError('已挂断；他的服务暂时不可达——结束会在恢复后自动确认');
        })
        .catch(() => undefined);
    } else {
      void fetch('/api/v1/calls/dial/current', { cache: 'no-store' }).then((r) => r.json()).then((c: { request_id?: string }) => { if (c.request_id) void fetch(`/api/v1/calls/dial/${encodeURIComponent(c.request_id)}`, { method: 'DELETE' }); }).catch(() => undefined);
    }
    setPhase('ended');
    setTimeout(onExit, 1200);
  };

  const toggleMute = (): void => {
    const next = !muted;
    setMuted(next);
    // F-03：静音=客户端真停上行（不上传采集帧、收尾在途输入）；不再用未协商的 interrupt 冒充
    clientRef.current?.setMuted(next);
  };
  const turnStatus = callState === 'speaking' ? 'char正在说话，收音暂停'
    : callState === 'ending' || callState === 'processing' ? '正在处理你刚才的话'
    : muted ? '已静音'
    : inputAvailable ? '轮到你说了' : '正在准备收音';

  // B5：最小化=右下角悬浮气泡（通话状态 + 麦克风脉动 + 展开/挂断）；挂断沿原 hangup 逻辑
  if (minimized) {
    const live = phase === 'active' || phase === 'connecting';
    return (
      <div className="fixed bottom-6 right-4 z-50 flex items-center gap-2 rounded-full bg-[#141310] py-2 pl-2 pr-3 text-[#f5f2ea] shadow-xl">
        <button onClick={() => setMinimized(false)} title="展开通话" className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 active:scale-95">
          <div className={`h-7 w-7 rounded-full transition-all ${inputAvailable ? 'bg-[#77b583]' : 'bg-white/30'}`} style={{ transform: `scale(${0.6 + micLevel * 0.4})`, opacity: 0.5 + micLevel * 0.5 }} />
        </button>
        <button onClick={() => setMinimized(false)} className="flex flex-col items-start">
          <span className="text-[13px] leading-tight">{phase === 'active' ? '通话中' : phase === 'connecting' ? '正在叫char…' : phase === 'ended' ? '已结束' : '连接失败'}</span>
          <span className="text-[11px] leading-tight opacity-50">{phase === 'active' ? turnStatus : '点击展开'}</span>
        </button>
        <button onClick={() => { if (live) { void clientRef.current?.hangup(); if (callIdRef.current) void fetch(`/api/v1/calls/${encodeURIComponent(callIdRef.current)}`, { method: 'DELETE' }); setPhase('ended'); setTimeout(onExit, 500); } }} title="挂断"
          className={`flex h-10 w-10 items-center justify-center rounded-full bg-[#d9534f] text-white active:scale-95 ${live ? '' : 'opacity-40'}`}>
          <PhoneOff size={18} />
        </button>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-[#141310] px-6 py-10 text-[#f5f2ea]">
      <div className="mt-6 text-center w-full relative">
        {/* B5：全屏面板的缩小入口（仅通话进行中显示——connecting 等待接听也可缩，ended/error 无意义） */}
        {phase !== 'ended' && phase !== 'error' && (
          <button onClick={() => setMinimized(true)} title="缩小为悬浮气泡" className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 active:scale-95">
            <Minimize2 size={16} />
          </button>
        )}
        <div className="text-[15px] opacity-70" role="status">{phase === 'connecting' ? '正在叫char…（他可以接听或拒绝）' : phase === 'active' ? turnStatus : phase === 'ended' ? '已结束' : '通话失败'}</div>
        {/* RVO-03：挂断回执的 media_close 未确认语义在 ended 状态可见（本地收口≠远端已结束） */}
        {error && <div className="mt-2 max-w-sm text-[13px] text-[#e08d6d]">{error}</div>}
        {error && secureMicrophoneUrl() && <a className="mt-3 inline-block underline" href={secureMicrophoneUrl()!} target="_blank" rel="noopener noreferrer">使用 HTTPS 打开</a>}
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
          <div className={`h-10 w-10 rounded-full transition-all ${inputAvailable ? 'bg-[#77b583]' : 'bg-white/30'}`} style={{ transform: `scale(${0.5 + micLevel * 0.5})`, opacity: 0.5 + micLevel * 0.5 }} />
        </div>
        <button onClick={hangup} title="挂断" className="flex h-16 w-16 items-center justify-center rounded-full bg-[#d9534f] text-white shadow-lg active:scale-95">
          <PhoneOff size={24} />
        </button>
      </div>
      <div className="text-[11px] opacity-40">同一会话 · 通话期间仅记忆能力 · <Phone size={10} className="inline" /> est↔Siren</div>
    </div>
  );
}
