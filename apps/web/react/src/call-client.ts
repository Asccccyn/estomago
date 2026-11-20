// 正式通话面板使用 Siren WS v2。收音轮和下行语音分开收口：服务端重新接纳
// 输入，且浏览器实际播完当前流后，才从新的麦克风样本开始判定下一句。
import { microphoneEnvironmentIssue, microphoneErrorMessage } from '../../src/microphone-access.js';

type CallClientState = 'connecting' | 'listening' | 'speaking' | 'ending' | 'processing' | 'ended' | 'error';

export type CallClientEvents = {
  onState: (state: CallClientState) => void;
  onInputAvailable?: (available: boolean) => void;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onReply: (text: string) => void;
  onNotice: (text: string) => void;
  onError: (message: string) => void;
  onMicLevel: (rms: number) => void;
};

const UPLINK_RATE = 16000;
const SPEECH_RMS = 0.012;
const DEFAULT_CONFIRM_MS = 200;
const DEFAULT_END_SILENCE_MS = 700;
// Siren v2 的 ACK 等待上限。音频在得到 input_started 之前留在本地。
const ACK_TIMEOUT_MS = 5000;
const MAX_ACK_SAMPLES = 256 * 1024 / Int16Array.BYTES_PER_ELEMENT;

type MicFrame = { samples: Float32Array; capturedAt: number };
type Input = {
  id: string;
  awaitingAck: Float32Array[] | null;
  bufferedSamples: number;
  silenceSamples: number;
  endRequested: boolean;
};
type Playback = { nodes: Set<AudioBufferSourceNode>; receivedEnd: boolean };

export class CallClient {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private nextPlaybackTime = 0;
  private pendingPcm: { streamId: string; rate: number; bytes: number } | null = null;
  private currentStreamId: string | null = null;
  private readonly playbacks = new Map<string, Playback>();
  private readonly retiredStreams = new Set<string>();
  private input: Input | null = null;
  private serverState = 'connecting';
  private micRequested = false;
  private correlatedInput = false;
  private muted = false;
  private ended = false;
  private viewState: CallClientState = 'connecting';
  private inputAvailable = false;
  private acceptFramesFrom = 0;
  private candidate: Float32Array[] = [];
  private candidateSamples = 0;
  private confirmSamples = UPLINK_RATE * DEFAULT_CONFIRM_MS / 1000;
  private endSilenceSamples = UPLINK_RATE * DEFAULT_END_SILENCE_MS / 1000;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private connectSettle: { resolve(): void; reject(err: Error): void } | null = null;

  private readonly url: string;
  private readonly token: string;
  private readonly events: CallClientEvents;

  constructor(url: string, token: string, events: CallClientEvents) {
    this.url = url;
    this.token = token;
    this.events = events;
  }

  async connect(): Promise<void> {
    this.events.onState('connecting');
    this.events.onInputAvailable?.(false);
    const wsUrl = new URL(this.url);
    wsUrl.searchParams.set('token', this.token);
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (ev) => this.onMessage(ev.data);
    this.ws.onclose = (event) => {
      if (this.ended) return;
      this.terminate('remote_close');
      if (event.code >= 4001 && event.code <= 4007) this.events.onError(`通话被服务端关闭（${event.code}）`);
      else if (event.code !== 1000) this.events.onError(`通话连接中断（${event.code}）`);
    };
    this.ws.onerror = () => {
      if (this.ended) return;
      this.failCall('通话连接失败');
    };
    await new Promise<void>((resolve, reject) => {
      const socket = this.ws!;
      this.connectSettle = { resolve, reject };
      socket.onopen = () => { this.connectSettle = null; resolve(); };
    });
    if (this.ended) return;
    // Siren v2 用这一能力绑定 input_id 和 input_started。本客户端始终按半双工收音。
    this.send({ t: 'ready', protocol: 2, capabilities: { playback_drain: true, voice_interrupt: true } });
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private readyForInput(): boolean {
    return this.serverState === 'idle' || this.serverState === 'listening';
  }

  private refreshState(): void {
    const playing = this.serverState === 'speaking' || this.pendingPcm !== null || this.playbacks.size > 0;
    const available = !!this.worklet && !this.ended && !this.muted && this.readyForInput() && !playing && !this.input?.endRequested;
    if (available !== this.inputAvailable) {
      this.inputAvailable = available;
      this.clearCandidate();
      if (available) this.acceptFramesFrom = this.ctx?.currentTime ?? 0;
      else this.events.onMicLevel(0);
      this.events.onInputAvailable?.(available);
    }
    const state = this.ended ? 'ended' : !this.worklet ? 'connecting' : playing ? 'speaking' :
      this.serverState === 'ending' ? 'ending' : this.readyForInput() && !this.input?.endRequested ? 'listening' : 'processing';
    if (state !== this.viewState) {
      this.viewState = state;
      this.events.onState(state);
    }
  }

  private onMessage(data: unknown): void {
    if (this.ended) return;
    if (typeof data !== 'string') {
      if (!(data instanceof ArrayBuffer) || !this.pendingPcm) return;
      const header = this.pendingPcm;
      this.pendingPcm = null;
      if (data.byteLength === header.bytes && !this.retiredStreams.has(header.streamId)) {
        this.playPcm(new Uint8Array(data), header.rate, header.streamId);
      }
      this.refreshState();
      return;
    }

    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (this.input && typeof msg.input_id === 'string' && msg.input_id !== this.input.id) {
      if (msg.t === 'pcm') { this.pendingPcm = null; this.refreshState(); }
      return; // 旧输入的迟到状态、正文和音频不覆盖真实活动轮。
    }
    switch (msg.t) {
      case 'ready': {
        if (this.micRequested) return;
        this.micRequested = true;
        const caps = msg.capabilities as { voice_interrupt?: unknown } | undefined;
        this.correlatedInput = caps?.voice_interrupt === true;
        const vad = msg.vad as { confirm_ms?: unknown; end_silence_ms?: unknown } | undefined;
        this.confirmSamples = this.samplesFor(vad?.confirm_ms, DEFAULT_CONFIRM_MS, 2000);
        this.endSilenceSamples = this.samplesFor(vad?.end_silence_ms, DEFAULT_END_SILENCE_MS, 5000);
        void this.startMic();
        break;
      }
      case 'input_started': {
        const input = this.input;
        if (input && input.id === msg.input_id) this.acceptInput(input);
        break;
      }
      case 'state': {
        if (typeof msg.state !== 'string') break;
        if (msg.state === 'ended') { this.terminate('remote_close'); return; }
        const wasReady = this.readyForInput();
        this.serverState = msg.state;
        // start 也会伴随一条 listening。只有处理状态回到 listening 才完成收尾，
        // 避免早到的 start/listening 在本地 end 后误打开下一轮。
        if (!wasReady && this.readyForInput()) this.clearInput();
        this.refreshState();
        break;
      }
      case 'partial': if (typeof msg.text === 'string') this.events.onPartial(msg.text); break;
      case 'final':
      case 'asr': if (typeof msg.text === 'string' && msg.text.length > 0) this.events.onFinal(msg.text); break;
      case 'reply': if (typeof msg.text === 'string') this.events.onReply(msg.text); break;
      case 'notice': if (typeof msg.message === 'string' && msg.message) this.events.onNotice(msg.message); break;
      case 'pcm': {
        const streamId = typeof msg.stream_id === 'string' ? msg.stream_id : '';
        const rate = Number(msg.rate ?? 24000);
        const bytes = Number(msg.bytes);
        this.pendingPcm = streamId && !this.retiredStreams.has(streamId) &&
          Number.isFinite(rate) && rate > 0 && Number.isSafeInteger(bytes) && bytes > 0 && bytes % 2 === 0
          ? { streamId, rate, bytes } : null;
        this.refreshState();
        break;
      }
      case 'pcm_end': {
        if (typeof msg.stream_id !== 'string') break;
        const playback = this.playbacks.get(msg.stream_id);
        if (playback) { playback.receivedEnd = true; this.finishPlayback(msg.stream_id, playback); }
        break;
      }
      case 'interrupted': {
        const streamId = typeof msg.stream_id === 'string' ? msg.stream_id : this.currentStreamId;
        if (streamId) this.cancelStream(streamId);
        this.events.onNotice('当前回复已中断。');
        break;
      }
      case 'error': {
        // Siren 的识别、合成和 Core 错误属于一轮。后续 listening 照常重开收音；
        // WS 关闭/本地设备错误另走通话终止路径。
        const diagnostic = typeof msg.message === 'string' ? msg.message : String(msg.code ?? 'call_error');
        if (this.input?.awaitingAck) { this.clearInput(); this.refreshState(); }
        this.events.onNotice(`本轮语音处理失败：${diagnostic}`);
        break;
      }
    }
  }

  private samplesFor(value: unknown, fallback: number, max: number): number {
    const ms = typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : fallback;
    return Math.ceil(UPLINK_RATE * ms / 1000);
  }

  private async startMic(): Promise<void> {
    try {
      const unavailable = microphoneEnvironmentIssue();
      if (unavailable) { this.failCall(unavailable); return; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.ended) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const ctx = new AudioContext({ sampleRate: UPLINK_RATE });
      this.ctx = ctx;
      await ctx.resume();
      if (this.ended) return;
      const source = ctx.createMediaStreamSource(stream);
      const workletCode = `
class UplinkProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) this.port.postMessage({ samples: samples.slice(0), capturedAt: currentTime });
    return true;
  }
}
registerProcessor('uplink', UplinkProcessor);`;
      const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
      try { await ctx.audioWorklet.addModule(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
      if (this.ended) return;
      this.worklet = new AudioWorkletNode(ctx, 'uplink');
      this.worklet.port.onmessage = (event) => this.onPcmFrame(event.data as MicFrame);
      source.connect(this.worklet);
      this.refreshState();
    } catch (err) {
      if (this.ended) return;
      this.failCall(microphoneErrorMessage(err));
    }
  }

  private clearCandidate(): void {
    this.candidate = [];
    this.candidateSamples = 0;
  }

  private clearAckTimer(): void {
    if (this.ackTimer === null) return;
    clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  private clearInput(): void {
    this.clearAckTimer();
    this.input = null;
    this.clearCandidate();
  }

  private beginInput(): void {
    const frames = this.candidate;
    const input: Input = {
      id: `in_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      awaitingAck: this.correlatedInput ? frames : null,
      bufferedSamples: this.candidateSamples,
      silenceSamples: 0,
      endRequested: false,
    };
    this.clearCandidate();
    this.input = input;
    this.send({ t: 'start', input_id: input.id });
    if (input.awaitingAck) {
      this.ackTimer = setTimeout(() => this.dropAwaitingInput('未收到本轮收音确认，请再说一次。'), ACK_TIMEOUT_MS);
    } else {
      for (const frame of frames) this.sendPcm(frame);
    }
  }

  private acceptInput(input: Input): void {
    const frames = input.awaitingAck;
    if (!frames) return;
    if (!this.readyForInput() || this.playbacks.size || this.pendingPcm) {
      this.clearInput();
      this.refreshState();
      return;
    }
    this.clearAckTimer();
    input.awaitingAck = null;
    for (const frame of frames) this.sendPcm(frame);
    if (input.endRequested) this.send({ t: 'end', input_id: input.id });
  }

  private dropAwaitingInput(notice?: string): void {
    const input = this.input;
    if (!input?.awaitingAck) return;
    this.clearInput();
    if (this.readyForInput() && !this.playbacks.size && !this.pendingPcm) this.send({ t: 'abort', input_id: input.id });
    this.refreshState();
    if (notice) this.events.onNotice(notice);
  }

  private endInput(): void {
    const input = this.input;
    if (!input || input.endRequested) return;
    input.endRequested = true;
    if (!input.awaitingAck) this.send({ t: 'end', input_id: input.id });
    this.refreshState();
  }

  private onPcmFrame({ samples, capturedAt }: MicFrame): void {
    if (!this.inputAvailable || !samples.length || capturedAt < this.acceptFramesFrom) return;
    let energy = 0;
    for (const value of samples) energy += value * value;
    const rms = Math.sqrt(energy / samples.length);
    this.events.onMicLevel(rms);
    const voiced = rms > SPEECH_RMS;
    const input = this.input;
    if (!input) {
      if (!voiced) { this.clearCandidate(); return; }
      this.candidate.push(samples);
      this.candidateSamples += samples.length;
      if (this.candidateSamples >= this.confirmSamples) this.beginInput();
      return;
    }
    if (input.awaitingAck) {
      input.bufferedSamples += samples.length;
      if (input.bufferedSamples > MAX_ACK_SAMPLES) { this.dropAwaitingInput('本轮收音确认超时，请再说一次。'); return; }
      input.awaitingAck.push(samples);
    } else {
      this.sendPcm(samples);
    }
    input.silenceSamples = voiced ? 0 : input.silenceSamples + samples.length;
    // 起声通过确认后，无论句子长短均交给 ASR 判断。最后一段静音帧先于 end。
    if (!voiced && input.silenceSamples >= this.endSilenceSamples) this.endInput();
  }

  private sendPcm(samples: Float32Array): void {
    const socket = this.ws;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i]!));
      pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    socket.send(pcm.buffer);
  }

  private playPcm(bytes: Uint8Array, rate: number, streamId: string): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let playback = this.playbacks.get(streamId);
    if (!playback) {
      playback = { nodes: new Set(), receivedEnd: false };
      this.playbacks.set(streamId, playback);
    }
    if (playback.receivedEnd) return;
    this.currentStreamId = streamId;
    const frames = new Float32Array(bytes.length / 2);
    for (let i = 0; i < frames.length; i++) {
      const raw = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
      frames[i] = ((raw << 16) >> 16) / 32768;
    }
    const buffer = ctx.createBuffer(1, frames.length, rate);
    buffer.copyToChannel(frames, 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const stream = playback;
    stream.nodes.add(node);
    node.onended = () => {
      stream.nodes.delete(node);
      this.finishPlayback(streamId, stream);
    };
    if (this.nextPlaybackTime <= ctx.currentTime) this.nextPlaybackTime = ctx.currentTime + 0.05;
    node.start(this.nextPlaybackTime);
    this.nextPlaybackTime += frames.length / rate;
  }

  private finishPlayback(streamId: string, playback: Playback): void {
    if (this.ended || this.playbacks.get(streamId) !== playback || !playback.receivedEnd || playback.nodes.size > 0) return;
    this.playbacks.delete(streamId);
    this.retiredStreams.add(streamId);
    if (this.currentStreamId === streamId) this.currentStreamId = null;
    this.send({ t: 'playback_drained', stream_id: streamId });
    this.refreshState();
  }

  /** 只消费远端实际发出的流中断。麦克风无权停止下行。 */
  private cancelStream(streamId: string): void {
    this.retiredStreams.add(streamId);
    const playback = this.playbacks.get(streamId);
    this.playbacks.delete(streamId);
    for (const node of playback?.nodes ?? []) { try { node.stop(); } catch { /* 已播完 */ } }
    if (this.pendingPcm?.streamId === streamId) this.pendingPcm = null;
    if (this.currentStreamId === streamId) {
      this.currentStreamId = null;
      this.nextPlaybackTime = 0;
    }
    this.refreshState();
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (muted && this.readyForInput() && !this.playbacks.size && !this.pendingPcm) {
      if (this.input?.awaitingAck) this.dropAwaitingInput();
      else this.endInput();
    }
    this.refreshState();
  }

  async hangup(): Promise<void> {
    this.terminate('local_hangup');
  }

  private failCall(message: string): void {
    this.terminate('local_error');
    this.events.onError(message);
  }

  private terminate(reason: 'local_hangup' | 'remote_close' | 'local_error'): void {
    if (this.ended) return;
    this.ended = true;
    this.clearInput();
    this.connectSettle?.reject(new Error(`call_terminated:${reason}`));
    this.connectSettle = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onopen = null;
      try { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, reason); } catch { /* 已断 */ }
    }
    this.playbacks.clear();
    this.pendingPcm = null;
    this.refreshState();
    void this.stopMic();
  }

  private async stopMic(): Promise<void> {
    try { this.worklet?.disconnect(); } catch { /* 已断 */ }
    this.worklet = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') { try { await ctx.close(); } catch { /* 忽略 */ } }
  }
}
