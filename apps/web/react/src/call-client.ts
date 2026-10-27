// B2/RE-04（2026-10-24）：正式通话面板的 Siren 实时协议 v2 客户端。
// F-03（跨仓预审 2026-10-25）对齐服务端合同（packages/contracts/src/websocket.ts）：
// - 每次开口=新输入代际：干净轮界发 start(新 input_id)；上轮未收尾（ending/thinking/
//   speaking）时按协商 voice_interrupt 发 interrupt 换代（不再整通只发一次 start）；
// - 下行 PCM16 按有符号小端解码（Int16），不再用无符号拼装；
// - 静音=上行真停止（丢弃采集帧+收尾在途输入），不再拿未协商的 interrupt 冒充；
// - notice 读 message 字段（服务端合约为 {t:'notice', code, message}）。
// R-02（复审 2026-10-26）：下行按 stream_id 管理播放生命周期——打断（本地 interrupt
//  或服务端 interrupted 帧）停止该流全部已调度节点并重置排程，新回复立即从头排；
// 迟到的已作废流二进制块丢弃（P0-3）。未实现（如实声明）：回声参考通道、pre-roll
// 精调——真机/真实 Siren 端到端属后续验收。
export type CallClientEvents = {
  onState: (state: 'connecting' | 'listening' | 'speaking' | 'ending' | 'ended' | 'error') => void;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onReply: (text: string) => void;
  onNotice: (text: string) => void;
  onError: (message: string) => void;
  onMicLevel: (rms: number) => void;
};

const UPLINK_RATE = 16000;
const END_SILENCE_MS = 700;
const MIN_SPEECH_MS = 240;

export class CallClient {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private player: { ctx: AudioContext; nextTime: number } | null = null;
  private pendingPcm: { streamId: string; rate: number; bytes: ArrayBuffer } | null = null;
  private currentStreamId: string | null = null;
  private readonly streamNodes = new Map<string, Set<{ stop(): void }>>();
  private readonly cancelledStreams = new Set<string>();
  private inputId = `in_${Date.now().toString(36)}`;
  private inputLive = false;
  private inputHasVoice = false;
  private serverState = 'idle';
  private interruptCapable = false;
  private muted = false;
  private inSpeech = false;
  private speechStart = 0;
  private lastVoice = 0;
  private ended = false;
  private drainedStreams = new Set<string>();

  private readonly url: string;
  private readonly token: string;
  private readonly events: CallClientEvents;
  constructor(url: string, token: string, events: CallClientEvents) { this.url = url; this.token = token; this.events = events; }

  async connect(): Promise<void> {
    this.events.onState('connecting');
    const wsUrl = new URL(this.url);
    wsUrl.searchParams.set('token', this.token);
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (ev) => this.onMessage(ev.data);
    this.ws.onclose = (ev) => {
      if (!this.ended) {
        if (ev.code >= 4001 && ev.code <= 4007) this.events.onError(`通话被服务端关闭（${ev.code}）`);
        this.events.onState('ended');
      }
      void this.stopMic();
    };
    this.ws.onerror = () => this.events.onError('通话连接失败');
    await new Promise<void>((resolve, reject) => {
      const w = this.ws!;
      w.onopen = () => resolve();
      w.onerror = () => reject(new Error('ws_connect_failed'));
    });
    this.send({ t: 'ready', protocol: 2, capabilities: { playback_drain: true, voice_interrupt: true } });
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data) as Record<string, unknown>; } catch { return; }
      switch (msg['t']) {
        case 'ready': {
          // 服务端回报协商结果：voice_interrupt 决定能否在在途轮上换代
          const caps = msg['capabilities'] as { voice_interrupt?: unknown } | undefined;
          this.interruptCapable = caps?.voice_interrupt === true;
          void this.startMic();
          break;
        }
        case 'input_started': break; // 服务端已按本输入代际建轮（幂等 ACK）
        case 'state': this.serverState = typeof msg['state'] === 'string' ? msg['state'] : this.serverState; this.events.onState(this.serverState === 'listening' ? 'listening' : this.serverState === 'speaking' ? 'speaking' : this.serverState === 'ending' ? 'ending' : 'listening'); break;
        case 'partial': if (typeof msg['text'] === 'string') this.events.onPartial(msg['text']); break;
        case 'final': case 'asr': if (typeof msg['text'] === 'string' && msg['text'].length > 0) this.events.onFinal(msg['text']); break;
        case 'reply': if (typeof msg['text'] === 'string') this.events.onReply(msg['text']); break;
        case 'notice': if (typeof msg['message'] === 'string' && msg['message'].length > 0) this.events.onNotice(msg['message']); break;
        case 'pcm': {
          const sid = typeof msg['stream_id'] === 'string' ? msg['stream_id'] : '';
          this.pendingPcm = { streamId: sid, rate: Number(msg['rate'] ?? 24000), bytes: new ArrayBuffer(Number(msg['bytes'] ?? 0)) };
          break;
        }
        case 'pcm_end': if (typeof msg['stream_id'] === 'string') this.scheduleDrain(String(msg['stream_id'])); break;
        case 'interrupted': {
          // R-02（复审 2026-10-26）：旧输出流永久失效（P0-3 合同）——停止该流全部
          // 已调度节点并重置播放排程，新回复立即从头排，不再被旧队列拖住。
          const sid = typeof msg['stream_id'] === 'string' ? msg['stream_id'] : this.currentStreamId;
          if (sid) this.cancelStream(sid);
          this.events.onNotice('（你打断了他）');
          break;
        }
        case 'error': this.events.onError(typeof msg['message'] === 'string' ? msg['message'] : String(msg['code'] ?? 'call_error')); break;
        default: break;
      }
      return;
    }
    if (data instanceof ArrayBuffer && this.pendingPcm) {
      const header = this.pendingPcm;
      this.pendingPcm = null;
      if (this.cancelledStreams.has(header.streamId)) return; // 迟到旧流块：丢弃（P0-3）
      this.playPcm(new Uint8Array(data), header.rate, header.streamId);
    }
  }

  /** R-02：取消一条下行输出流——停止已调度节点；若它撑着排程序列则把
   *  nextTime 拉回当前时刻（新流不被已作废的旧队列拖延）。 */
  private cancelStream(streamId: string): void {
    if (this.cancelledStreams.has(streamId)) return;
    this.cancelledStreams.add(streamId);
    const nodes = this.streamNodes.get(streamId);
    let stopped = 0;
    if (nodes) {
      for (const node of nodes) { try { node.stop(); stopped++; } catch { /* 已播完 */ } }
      this.streamNodes.delete(streamId);
    }
    if (stopped > 0 && this.player && this.ctx && streamId === this.currentStreamId) {
      this.player.nextTime = this.ctx.currentTime + 0.05;
    }
  }

  // —— 上行：采集 + VAD 断句 + 输入代际 ——
  private async startMic(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      // JV-15（联合审计 2026-10-26）：授权/设备初始化是真实异步边界——await 期间可能
      // 已挂断。晚到资源立即释放，不再重建音频链（否则挂断后 mic track/context 泄漏）。
      if (this.ended) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      this.ctx = new AudioContext({ sampleRate: UPLINK_RATE });
      await this.ctx.resume();
      if (this.ended) { void this.stopMic(); return; }
      const source = this.ctx.createMediaStreamSource(this.stream);
      const workletCode = `
class UplinkProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('uplink', UplinkProcessor);`;
      const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(blobUrl);
      URL.revokeObjectURL(blobUrl);
      if (this.ended) { void this.stopMic(); return; }
      this.worklet = new AudioWorkletNode(this.ctx, 'uplink');
      this.worklet.port.onmessage = (ev) => this.onPcmFrame(ev.data as Float32Array);
      source.connect(this.worklet);
      // 采集节点不连 destination（静音处理链，防本地回环）
      // 首轮输入在开麦即开（保留话头 prebuffer）；后续每次开口由 VAD 换代
      this.beginInput();
      this.events.onState('listening');
    } catch (err) {
      if (this.ended) return; // 已挂断：设备错误不再打扰结束态
      this.events.onError(`麦克风不可用：${String((err as Error).message ?? err)}`);
    }
  }

  private newInputId(): string {
    return `in_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /** 新开口=新输入代际：开麦预开的空输入首次开口沿用（保留话头 prebuffer）；
   *  已上行语音的在途输入、或服务端未回 listening（在途轮）时按协商 interrupt 换代 */
  private beginInput(): void {
    if (this.ended || this.muted) return;
    const busy = this.serverState !== 'listening' && this.serverState !== 'idle';
    if (this.inputLive && !this.inputHasVoice && !busy) {
      this.inputHasVoice = true;
      return;
    }
    if (this.inputLive || busy) {
      if (!this.interruptCapable) return; // 未获协商：换代请求会被拒，帧由服务端丢弃（如实降级）
      const next = this.newInputId();
      // R-02：本地打断先作废当前输出流（已排队旧话立即停，不等服务端确认帧）
      if (this.currentStreamId) this.cancelStream(this.currentStreamId);
      this.send({ t: 'interrupt', target_input_id: this.inputId, new_input_id: next });
      this.inputId = next;
      this.inputLive = true;
      this.inputHasVoice = true;
      return;
    }
    const next = this.newInputId();
    this.send({ t: 'start', input_id: next });
    this.inputId = next;
    this.inputLive = true;
    this.inputHasVoice = false;
  }

  private endInput(): void {
    if (!this.inputLive) return;
    this.inputLive = false;
    this.inputHasVoice = false;
    this.send({ t: 'end', input_id: this.inputId });
  }

  private onPcmFrame(frame: Float32Array): void {
    if (this.ended || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // RMS 电平 + 简单能量 VAD（阈值可调）
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
    const rms = Math.sqrt(sum / frame.length);
    this.events.onMicLevel(rms);
    // 真静音：不上行任何帧、不推进 VAD（解除后从下一次开口重新开代）
    if (this.muted) return;
    const now = performance.now();
    if (rms > 0.012) {
      if (!this.inSpeech) { this.inSpeech = true; this.speechStart = now; this.beginInput(); }
      this.lastVoice = now;
    } else if (this.inSpeech && now - this.lastVoice > END_SILENCE_MS) {
      this.inSpeech = false;
      if (now - this.speechStart >= MIN_SPEECH_MS) this.endInput();
    }
    // PCM16 小端上行
    const pcm = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      const v = Math.max(-1, Math.min(1, frame[i]!));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    this.ws.send(pcm.buffer);
  }

  // —— 下行：PCM 播放 + drain 回执 ——
  private playPcm(bytes: Uint8Array, rate: number, streamId: string): void {
    if (!this.ctx) return;
    if (!this.player) this.player = { ctx: this.ctx, nextTime: this.ctx.currentTime + 0.05 };
    const p = this.player;
    this.currentStreamId = streamId;
    const frames = new Float32Array(bytes.length / 2);
    for (let i = 0; i < frames.length; i++) {
      // PCM16 有符号小端：先按 Int16 符号扩展再归一（[-1,-0.5,0,0.5] 必须解回原值）
      const raw = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
      frames[i] = ((raw << 16) >> 16) / 32768;
    }
    const buf = p.ctx.createBuffer(1, frames.length, rate);
    buf.copyToChannel(frames, 0);
    const node = p.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(p.ctx.destination);
    // JV-02（联合审计 2026-10-26）：排程时刻已过（上轮播完后真实时钟已前进，
    // 或打断/暂停后 nextTime 落在过去）——以当前音频时钟续接（小抖动），块保持
    // 顺序；否则旧时刻的块会被浏览器立即同时播放（第二轮全部重叠）。
    const now = p.ctx.currentTime;
    if (p.nextTime < now) p.nextTime = now + 0.05;
    node.start(p.nextTime);
    p.nextTime += frames.length / rate;
    // R-02：登记节点供打断时停止（流结束自然播完时在 onended 移除）
    let nodes = this.streamNodes.get(streamId);
    if (!nodes) { nodes = new Set(); this.streamNodes.set(streamId, nodes); }
    const registered = node as AudioBufferSourceNode & { onended?: (() => void) | null };
    nodes.add(node);
    registered.onended = () => { nodes!.delete(node); };
  }

  private scheduleDrain(streamId: string): void {
    if (this.drainedStreams.has(streamId)) return;
    if (this.cancelledStreams.has(streamId)) return; // 已作废流不再宣称播完（服务端 interrupt 时已不等）
    const p = this.player;
    const ctx = this.ctx;
    if (!p || !ctx) return;
    const wait = Math.max(0, (p.nextTime - ctx.currentTime) * 1000 + 60);
    setTimeout(() => {
      if (this.ended || this.cancelledStreams.has(streamId)) return;
      this.send({ t: 'playback_drained', stream_id: streamId });
      this.drainedStreams.add(streamId);
    }, wait);
  }

  /** 真静音开关：静音即停上行并收尾在途输入（已上行部分如实成轮）、冻结 VAD；
   *  解除后从下一次开口重新判定（必然开新代际，不接续静音前的旧话头） */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (muted) {
      this.inSpeech = false;
      this.endInput();
    }
  }

  async hangup(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    try { this.send({ t: 'abort', input_id: this.inputId }); } catch { /* 已关 */ }
    await this.stopMic();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'hangup');
    this.events.onState('ended');
  }

  private async stopMic(): Promise<void> {
    try { this.worklet?.disconnect(); } catch { /* 已断 */ }
    this.worklet = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx && this.ctx.state !== 'closed') { try { await this.ctx.close(); } catch { /* 忽略 */ } }
    this.ctx = null;
    this.player = null;
  }
}
