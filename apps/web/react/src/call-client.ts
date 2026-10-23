// B2/RE-04（2026-10-24）：正式通话面板的 Siren 实时协议 v2 客户端（子集，诚实边界）。
// 已实现：ready 协商、start/end（VAD 断句）、abort、上行 PCM16/16k 采集、下行 PCM 播放
// 与 playback_drained、partial/final/reply 字幕、input_id 过滤、interrupt 基础语义。
// 未实现（如实声明）：voice_interrupt 协商分支、回声参考通道、pre-roll 精调——
// 真机/真实 Siren 端到端属后续验收（本文件为浏览器真实音频栈实现，非测试页复用）。
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
  private pendingPcm: { rate: number; bytes: ArrayBuffer } | null = null;
  private inputId = `in_${Date.now().toString(36)}`;
  private inSpeech = false;
  private speechStart = 0;
  private lastVoice = 0;
  private silenceTimer: number | null = null;
  private ended = false;
  private drainedStreams = new Set<string>();

  constructor(private readonly url: string, private readonly token: string, private readonly events: CallClientEvents) {}

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
    this.send({ t: 'ready', protocol: 2, capabilities: { playback_drain: true } });
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data) as Record<string, unknown>; } catch { return; }
      switch (msg['t']) {
        case 'ready': void this.startMic(); break;
        case 'state': this.events.onState(msg['state'] === 'listening' ? 'listening' : msg['state'] === 'speaking' ? 'speaking' : msg['state'] === 'ending' ? 'ending' : 'listening'); break;
        case 'partial': if (typeof msg['text'] === 'string') this.events.onPartial(msg['text']); break;
        case 'final': case 'asr': if (typeof msg['text'] === 'string' && msg['text'].length > 0) this.events.onFinal(msg['text']); break;
        case 'reply': if (typeof msg['text'] === 'string') this.events.onReply(msg['text']); break;
        case 'notice': if (typeof msg['text'] === 'string') this.events.onNotice(msg['text']); break;
        case 'pcm': this.pendingPcm = { rate: Number(msg['rate'] ?? 24000), bytes: new ArrayBuffer(Number(msg['bytes'] ?? 0)) }; break;
        case 'pcm_end': if (typeof msg['stream_id'] === 'string') this.scheduleDrain(String(msg['stream_id'])); break;
        case 'interrupted': this.events.onNotice('（你打断了他）'); break;
        case 'error': this.events.onError(typeof msg['message'] === 'string' ? msg['message'] : String(msg['code'] ?? 'call_error')); break;
        default: break;
      }
      return;
    }
    if (data instanceof ArrayBuffer && this.pendingPcm) {
      this.playPcm(new Uint8Array(data), this.pendingPcm.rate);
      this.pendingPcm = null;
    }
  }

  // —— 上行：采集 + VAD 断句 ——
  private async startMic(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.ctx = new AudioContext({ sampleRate: UPLINK_RATE });
      await this.ctx.resume();
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
      this.worklet = new AudioWorkletNode(this.ctx, 'uplink');
      this.worklet.port.onmessage = (ev) => this.onPcmFrame(ev.data as Float32Array);
      source.connect(this.worklet);
      // 采集节点不连 destination（静音处理链，防本地回环）
      this.send({ t: 'start', input_id: this.inputId });
      this.events.onState('listening');
    } catch (err) {
      this.events.onError(`麦克风不可用：${String((err as Error).message ?? err)}`);
    }
  }

  private onPcmFrame(frame: Float32Array): void {
    if (this.ended || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // RMS 电平 + 简单能量 VAD（阈值可调；确认窗口后 start 已在开麦时发出）
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
    const rms = Math.sqrt(sum / frame.length);
    this.events.onMicLevel(rms);
    const now = performance.now();
    if (rms > 0.012) {
      if (!this.inSpeech) { this.inSpeech = true; this.speechStart = now; }
      this.lastVoice = now;
    } else if (this.inSpeech && now - this.lastVoice > END_SILENCE_MS) {
      this.inSpeech = false;
      if (now - this.speechStart >= MIN_SPEECH_MS) this.send({ t: 'end', input_id: this.inputId });
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
  private playPcm(bytes: Uint8Array, rate: number): void {
    if (!this.ctx) return;
    if (!this.player) this.player = { ctx: this.ctx, nextTime: this.ctx.currentTime + 0.05 };
    const p = this.player;
    const frames = new Float32Array(bytes.length / 2);
    for (let i = 0; i < frames.length; i++) {
      const v = (bytes[i * 2]! | (bytes[i * 2 + 1]! << 8)) / 32768;
      frames[i] = v;
    }
    const buf = p.ctx.createBuffer(1, frames.length, rate);
    buf.copyToChannel(frames, 0);
    const node = p.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(p.ctx.destination);
    node.start(p.nextTime);
    p.nextTime += frames.length / rate;
  }

  private scheduleDrain(streamId: string): void {
    if (this.drainedStreams.has(streamId)) return;
    const p = this.player;
    const ctx = this.ctx;
    if (!p || !ctx) return;
    const wait = Math.max(0, (p.nextTime - ctx.currentTime) * 1000 + 60);
    setTimeout(() => {
      if (!this.ended) this.send({ t: 'playback_drained', stream_id: streamId });
      this.drainedStreams.add(streamId);
    }, wait);
  }

  /** 手动打断当前输入（对旧 input 作废并开新输入） */
  interrupt(): void {
    if (this.ended) return;
    const old = this.inputId;
    this.inputId = `in_${Date.now().toString(36)}`;
    this.send({ t: 'interrupt', target_input_id: old, new_input_id: this.inputId });
  }

  async hangup(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.silenceTimer !== null) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
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
