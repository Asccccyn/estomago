import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallClient } from '../../apps/web/react/src/call-client.ts';

const sent: Array<{ kind: 'text'; obj: Record<string, unknown> } | { kind: 'binary'; samples: Int16Array }> = [];
const decodedPcm: number[][] = [];
const notices: string[] = [];
const errors: string[] = [];
const states: string[] = [];
const available: boolean[] = [];
const audioSources: Array<{ startAt: number; stopped: boolean; started: boolean; stop(): void; start(at: number): void; onended: (() => void) | null }> = [];
const audioContexts: FakeAudioContext[] = [];
const workletPorts: Array<{ onmessage: unknown }> = [];
const wsInstances: Array<InstanceType<typeof FakeWebSocket>> = [];

let serverDispatch: (data: unknown) => void = () => undefined;
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  binaryType = 'binary';
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) { this.url = url; serverDispatch = (d) => this.onmessage?.({ data: d }); wsInstances.push(this); }
  send(data: unknown): void {
    if (typeof data === 'string') sent.push({ kind: 'text', obj: JSON.parse(data) as Record<string, unknown> });
    else sent.push({ kind: 'binary', samples: new Int16Array(data as ArrayBuffer) });
  }
  close(): void { this.readyState = 3; }
}
class FakeAudioContext {
  sampleRate = 16000; state = 'running'; currentTime = 0;
  readonly destination = {};
  async resume(): Promise<void> { /* stub */ }
  async close(): Promise<void> { this.state = 'closed'; }
  createMediaStreamSource(): { connect(): void } { return { connect() { /* stub */ } }; }
  createBuffer(_ch: number, len: number, rate: number): { copyToChannel(frames: Float32Array): void } {
    assert.equal(rate, 16000);
    return {
      copyToChannel: (frames: Float32Array): void => { assert.equal(frames.length, len); decodedPcm.push(Array.from(frames)); }
    };
  }
  createBufferSource(): { buffer: unknown; connect(): void; start(at: number): void; stop(): void; onended: (() => void) | null } {
    const src = { startAt: -1, started: false, stopped: false, buffer: null as unknown, onended: null as (() => void) | null,
      connect() { /* stub */ },
      start(at: number): void { src.startAt = at; src.started = true; },
      stop(): void { src.stopped = true; } };
    audioSources.push(src);
    return src;
  }
  readonly audioWorklet = { addModule: async (): Promise<void> => { /* stub */ } };
  constructor() { audioContexts.push(this); }
}
class FakeWorkletNode {
  readonly port = { onmessage: null as unknown };
  constructor() { workletPorts.push(this.port); }
  disconnect(): void { /* stub */ }
}
const g = globalThis as unknown as Record<string, unknown>;
g.WebSocket = FakeWebSocket;
g.AudioContext = FakeAudioContext;
g.AudioWorkletNode = FakeWorkletNode;
Object.defineProperty(g, 'isSecureContext', { value: true, configurable: true });
Object.defineProperty(g, 'navigator', { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } }, configurable: true });
(g.URL as Record<string, unknown>).createObjectURL = (): string => 'blob:fake';
(g.URL as Record<string, unknown>).revokeObjectURL = (): void => undefined;

const serverSend = (message: Record<string, unknown>): void => serverDispatch(JSON.stringify(message));
const texts = (type: string) => sent.filter((item) => item.kind === 'text' && item.obj.t === type).map((item) => item.kind === 'text' ? item.obj : {});
const binary = () => sent.filter((item) => item.kind === 'binary').map((item) => item.kind === 'binary' ? item.samples : new Int16Array());
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const mic = (ms: number, amplitude: number, capturedAt = audioContexts.at(-1)!.currentTime): void => {
  const samples = new Float32Array(Math.round(16 * ms)).fill(amplitude);
  const receive = workletPorts.at(-1)!.onmessage as (event: { data: { samples: Float32Array; capturedAt: number } }) => void;
  receive({ data: { samples, capturedAt } });
};
const play = (streamId: string, sequence: number, raw: ArrayBuffer, inputId?: unknown): void => {
  serverSend({ t: 'pcm', stream_id: streamId, sequence, rate: 16000, bytes: raw.byteLength, input_id: inputId });
  serverDispatch(raw);
};
const state = (value: string, inputId?: unknown) => serverSend({ t: 'state', state: value, input_id: inputId });

async function connected() {
  for (const entries of [sent, decodedPcm, notices, errors, states, available, audioSources, audioContexts, workletPorts]) entries.length = 0;
  const client = new CallClient('ws://127.0.0.1:1/ws/call/synthetic', 'test-token', {
    onState: (value) => states.push(value), onInputAvailable: (value) => available.push(value),
    onPartial: () => undefined, onFinal: () => undefined, onReply: () => undefined,
    onNotice: (note) => notices.push(note), onError: (message) => errors.push(message), onMicLevel: () => undefined,
  });
  const pending = client.connect();
  wsInstances.at(-1)!.onopen!();
  await pending;
  assert.deepEqual(texts('ready')[0]?.capabilities, { playback_drain: true, voice_interrupt: true });
  serverSend({ t: 'ready', protocol: 2, capabilities: { voice_interrupt: true } });
  state('idle');
  await sleep(0);
  assert.equal(available.at(-1), true);
  assert.equal(states.at(-1), 'listening');
  return client;
}

test('静音和短杂音零上行；确认后等待同一输入 ACK，保留语音开头，700ms 静音收尾短句', async (t) => {
  const client = await connected();
  t.after(() => client.hangup());
  mic(260, 0.005);
  mic(16, 0.08);
  mic(240, 0);
  assert.equal(texts('start').length, 0);
  assert.equal(binary().length, 0);
  mic(80, 0.25);
  mic(80, 0.5);
  assert.equal(texts('start').length, 0);
  mic(40, 0.75);
  const id = texts('start')[0]?.input_id;
  assert.equal(typeof id, 'string');
  assert.equal(binary().length, 0, '真实 ACK 前保留话头，不上传');
  // 装配确认延迟：已确认的短句继续收尾，缓存的 PCM 顺序必须在 end 之前。
  mic(699, 0);
  assert.equal(texts('end').length, 0);
  mic(1, 0);
  assert.equal(available.at(-1), false);
  assert.equal(states.at(-1), 'processing');
  assert.equal(texts('end').length, 0, 'end 同样等待同一输入 ACK');
  serverSend({ t: 'input_started', input_id: id });
  assert.deepEqual(binary().map(frame => [frame.length, frame[0]]), [[1280, 8191], [1280, 16383], [640, 24575], [11184, 0], [16, 0]]);
  assert.deepEqual(sent.at(-1), { kind: 'text', obj: { t: 'end', input_id: id } });
  state('listening', id); // 服务端处理 start 时的早期 listening。
  mic(280, 0.5);
  state('ending', id);
  state('thinking', id);
  mic(300, 0.5);
  assert.equal(texts('start').length, 1);
  assert.equal(texts('interrupt').length, 0);
  assert.equal(binary().length, 5);
  state('listening', id);
  assert.equal(available.at(-1), true);
  mic(200, 0.5);
  assert.equal(texts('start').length, 2);
  assert.notEqual(texts('start')[1]?.input_id, id);
});

test('先收到服务端 listening 也继续保护尾音；pcm_end 和所有真实 onended 才恢复新鲜收音', async (t) => {
  const client = await connected();
  t.after(() => client.hangup());
  mic(200, 0.5);
  const id = texts('start')[0]?.input_id;
  serverSend({ t: 'input_started', input_id: id });
  state('listening', id);
  mic(700, 0);
  state('ending', id);
  state('thinking', id);
  state('speaking', id);
  const pcm = new Uint8Array([0x00, 0x80, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x40]).buffer;
  play('reply', 0, pcm, id);
  play('reply', 1, pcm, id);
  assert.deepEqual(decodedPcm[0], [-1, -0.5, 0, 0.5]);
  serverSend({ t: 'pcm_end', stream_id: 'reply', input_id: id });
  const context = audioContexts.at(-1)!;
  // 旧客户端靠墙钟排程推算，音频还暂停着就会送 drained。
  context.state = 'suspended';
  await sleep(150);
  assert.equal(texts('playback_drained').length, 0);
  state('listening', id); // Siren drain 超时兜底先发生。
  assert.equal(available.at(-1), false);
  assert.equal(states.at(-1), 'speaking');
  const before = sent.length;
  mic(240, 0.9);
  assert.equal(sent.length, before);
  assert.ok(audioSources.every(source => !source.stopped));
  context.state = 'running';
  audioSources[0]!.onended!();
  assert.equal(texts('playback_drained').length, 0);
  assert.equal(available.at(-1), false);
  context.currentTime = 0.3;
  audioSources[1]!.onended!();
  assert.deepEqual(texts('playback_drained'), [{ t: 'playback_drained', stream_id: 'reply' }]);
  assert.equal(available.at(-1), true);
  assert.equal(states.at(-1), 'listening');
  mic(220, 0.9, 0.1); // 播放期间采到、解锁之后才到主线程的回调。
  assert.equal(texts('start').length, 1);
  mic(200, 0.25);
  const nextId = texts('start')[1]?.input_id;
  assert.notEqual(nextId, id);
  serverSend({ t: 'input_started', input_id: nextId });
  assert.equal(binary().length, 3);
  assert.ok(binary().at(-1)?.every(sample => sample === 8191), '仅上传解锁后的原始新语音');
  assert.equal(texts('interrupt').length, 0);
  assert.equal(texts('abort').length, 0);
});

test('真实远端中断停掉旧流并重排新流；作废流的晚到 PCM 和 pcm_end 均被丢弃', async (t) => {
  const client = await connected();
  t.after(() => client.hangup());
  const pcm = new Uint8Array(32000).fill(0x10).buffer;
  state('speaking');
  play('old', 0, pcm);
  play('old', 1, pcm);
  assert.equal(audioSources.length, 2);
  const context = audioContexts.at(-1)!;
  context.currentTime = 0.2;
  serverSend({ t: 'interrupted', stream_id: 'old' });
  assert.ok(audioSources.every(source => source.stopped));
  play('old', 2, pcm);
  serverSend({ t: 'pcm_end', stream_id: 'old' });
  assert.equal(audioSources.length, 2);
  play('new', 0, pcm);
  assert.ok(audioSources[2]!.startAt > 0.2 && audioSources[2]!.startAt <= 0.26);
  audioSources[2]!.onended!(); // 播放节点先完；仍等网络 pcm_end。
  assert.equal(texts('playback_drained').length, 0);
  serverSend({ t: 'pcm_end', stream_id: 'new' });
  assert.deepEqual(texts('playback_drained'), [{ t: 'playback_drained', stream_id: 'new' }]);
  assert.equal(available.at(-1), false, '本地已经播完仍等 Siren 回 listening');
  state('listening');
  assert.equal(available.at(-1), true);
  context.currentTime = 2;
  play('following', 0, pcm);
  assert.ok(audioSources[3]!.startAt > 2 && audioSources[3]!.startAt <= 2.06, '下一轮不会排到已过去的时刻');
});

test('本轮 ASR 失败显示真实诊断且可继续；静音只结束自己的已发在途输入', async (t) => {
  const client = await connected();
  t.after(() => client.hangup());
  mic(200, 0.5);
  const id = texts('start')[0]?.input_id;
  serverSend({ t: 'input_started', input_id: id });
  client.setMuted(true);
  assert.equal(available.at(-1), false);
  assert.deepEqual(texts('end'), [{ t: 'end', input_id: id }]);
  state('ending', id);
  serverSend({ t: 'error', code: 'asr_timeout', message: 'speech recognition timed out', input_id: id });
  assert.deepEqual(notices, ['本轮语音处理失败：speech recognition timed out']);
  assert.deepEqual(errors, []);
  state('listening', id);
  assert.equal(states.at(-1), 'listening');
  const before = sent.length;
  mic(350, 0.6);
  assert.equal(sent.length, before);
  client.setMuted(false);
  assert.equal(available.at(-1), true);
  mic(200, 0.3);
  const next = texts('start')[1]?.input_id;
  assert.notEqual(next, id);
  state('speaking', id); // 旧 input_id 的迟到通知不改变新轮。
  assert.equal(available.at(-1), true);
  serverSend({ t: 'input_started', input_id: next });
  assert.equal(binary().length, 2);
  // 用户仍可按挂断键，终止整个通话。
  await client.hangup();
  assert.equal(states.at(-1), 'ended');
  assert.equal(wsInstances.at(-1)?.readyState, 3);
});
