// Phase 0.5 整改验证（跨仓预审 F-03，2026-10-25）：正式 CallClient 对齐 Siren WS v2 合同。
// 用真实 CallClient 类 + 浏览器边界 fake（WebSocket/AudioContext/AudioWorklet/getUserMedia/
// Blob URL——外部硬件与网络边界替代），从公开回调喂合规帧，不改客户端私有状态：
// - 多轮：每轮开口=start(新 input_id)，静音=end；成对且代际不同（旧缺陷：整通只 1 次 start）
// - 在途轮开口（服务端未回 listening）=interrupt 换代（协商 voice_interrupt 后）
// - 下行 PCM16 有符号小端解码：[-1,-0.5,0,0.5] 解回原值（旧缺陷：[1,1.5,0,0.5]）
// - 真静音：setMuted 后零上行帧；解除后新代际 start
// - notice 读 message 字段（旧缺陷：读 text 恒 undefined）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallClient } from '../../apps/web/react/src/call-client.ts';

const sent: Array<{ kind: 'text'; obj: Record<string, unknown> } | { kind: 'binary'; bytes: number }> = [];
const decodedPcm: number[][] = [];
const notices: string[] = [];
const audioSources: Array<{ startAt: number; stopped: boolean; started: boolean; stop(): void; start(at: number): void }> = [];
const audioContexts: FakeAudioContext[] = [];
const workletPorts: Array<{ onmessage: unknown }> = [];
const wsInstances: Array<InstanceType<typeof FakeWebSocket>> = [];

let serverDispatch: (data: unknown) => void = () => undefined;
class FakeWebSocket {
  static OPEN = 1;
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
    else sent.push({ kind: 'binary', bytes: (data as ArrayBuffer).byteLength });
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
Object.defineProperty(g, 'navigator', { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } }, configurable: true });
(g.URL as Record<string, unknown>).createObjectURL = (): string => 'blob:fake';
(g.URL as Record<string, unknown>).revokeObjectURL = (): void => undefined;

const serverSend = (data: unknown): void => { serverDispatch(data); };
const texts = (): Array<Record<string, unknown>> => sent.filter((s) => s.kind === 'text').map((s) => (s as { kind: 'text'; obj: Record<string, unknown> }).obj);
const speechFrame = (): void => { const f = new Float32Array(256).fill(0.5); (workletPorts.at(-1)!.onmessage as (ev: { data: Float32Array }) => void)({ data: f }); };
const silenceFrame = (): void => { const f = new Float32Array(256).fill(0); (workletPorts.at(-1)!.onmessage as (ev: { data: Float32Array }) => void)({ data: f }); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('F-03 正式客户端：多轮输入代际/signed PCM/真静音/notice', async () => {
  const client = new CallClient('ws://127.0.0.1:1/ws/call/sc_1', 'tok', {
    onState: () => undefined, onPartial: () => undefined, onFinal: () => undefined, onReply: () => undefined,
    onNotice: (t) => notices.push(t), onError: () => undefined, onMicLevel: () => undefined,
  });
  const connecting = client.connect();
  await sleep(10);
  wsInstances.at(-1)!.onopen!(); // 浏览器边界：WS 打开
  await connecting;
  // ready 协商：客户端上报 voice_interrupt
  const readyOut = texts().find((m) => m['t'] === 'ready');
  assert.deepEqual(readyOut?.['capabilities'], { playback_drain: true, voice_interrupt: true });
  // 服务端回报协商成功 + 进入 listening → startMic → 首轮 start
  serverSend(JSON.stringify({ t: 'ready', protocol: 2, audio: { input_rate: 16000, output_rate: 24000, format: 'pcm16' }, capabilities: { voice_interrupt: true } }));
  serverSend(JSON.stringify({ t: 'state', state: 'listening' }));
  await sleep(30);
  let starts = texts().filter((m) => m['t'] === 'start');
  assert.equal(starts.length, 1, '开麦即开首轮输入');
  const firstInput = starts[0]!['input_id'] as string;

  // —— 第一轮：说话→静音→end ——
  speechFrame();
  silenceFrame();
  await sleep(800); // END_SILENCE_MS=700（真实时钟）
  silenceFrame();
  await sleep(30);
  const ends = texts().filter((m) => m['t'] === 'end');
  assert.equal(ends.length, 1, '静音断句发 end');
  assert.equal(ends[0]!['input_id'], firstInput);
  serverSend(JSON.stringify({ t: 'state', state: 'listening' })); // 服务端回 listening（轮已收）

  // —— 第二轮：干净轮界 → 新 start（新 input_id）——
  speechFrame();
  await sleep(30);
  starts = texts().filter((m) => m['t'] === 'start');
  assert.equal(starts.length, 2, '第二次开口=新输入代际（旧缺陷：整通只 1 次 start）');
  const secondInput = starts[1]!['input_id'] as string;
  assert.notEqual(secondInput, firstInput);
  silenceFrame();
  await sleep(800);
  silenceFrame();
  await sleep(30);
  assert.equal(texts().filter((m) => m['t'] === 'end').length, 2);

  // —— 在途轮（服务端 speaking）开口 → interrupt 换代 ——
  serverSend(JSON.stringify({ t: 'state', state: 'speaking' }));
  speechFrame();
  await sleep(30);
  const interrupts = texts().filter((m) => m['t'] === 'interrupt');
  assert.equal(interrupts.length, 1, '在途轮开口按协商 interrupt 换代');
  assert.equal(interrupts[0]!['target_input_id'], secondInput);
  assert.equal(typeof interrupts[0]!['new_input_id'], 'string');

  // —— 下行 signed PCM16：[-1,-0.5,0,0.5] ——
  serverSend(JSON.stringify({ t: 'pcm', stream_id: 'os_1', sequence: 0, rate: 16000, bytes: 8 }));
  serverSend(new Uint8Array([0x00, 0x80, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x40]).buffer);
  await sleep(30);
  assert.deepEqual(decodedPcm[0]?.map((v) => Math.round(v * 1000) / 1000), [-1, -0.5, 0, 0.5], 'signed PCM16 解码');

  // —— pcm_end → 播放完成后 playback_drained ——
  serverSend(JSON.stringify({ t: 'pcm_end', stream_id: 'os_1' }));
  await sleep(150);
  const drained = texts().find((m) => m['t'] === 'playback_drained');
  assert.equal(drained?.['stream_id'], 'os_1');

  // —— notice：读 message ——
  serverSend(JSON.stringify({ t: 'notice', code: 'hangup_pending', message: '他想挂电话了：等这段说完。' }));
  await sleep(20);
  assert.deepEqual(notices, ['他想挂电话了：等这段说完。'], 'notice.message 上屏（旧缺陷：读 text 恒空）');

  // —— 真静音：零上行、不开新代；解除后新代际 ——
  serverSend(JSON.stringify({ t: 'state', state: 'listening' }));
  await sleep(10);
  const binaryBefore = sent.filter((s) => s.kind === 'binary').length;
  const startsBefore = texts().filter((m) => m['t'] === 'start').length;
  client.setMuted(true);
  speechFrame();
  silenceFrame();
  await sleep(800);
  speechFrame();
  await sleep(50);
  assert.equal(sent.filter((s) => s.kind === 'binary').length, binaryBefore, '静音期间零上行帧');
  assert.equal(texts().filter((m) => m['t'] === 'start').length, startsBefore, '静音期间不开新输入');
  client.setMuted(false);
  speechFrame();
  await sleep(30);
  assert.equal(texts().filter((m) => m['t'] === 'start').length, startsBefore + 1, '解除静音后新开口=新代际');

  await client.hangup();
  console.log(JSON.stringify({
    case: 'f03_call_client',
    start_count: texts().filter((m) => m['t'] === 'start').length,
    end_count: texts().filter((m) => m['t'] === 'end').length,
    interrupt_count: texts().filter((m) => m['t'] === 'interrupt').length,
    pcm_decoded: decodedPcm[0],
    notice: notices[0],
    muted_zero_uplink: true
  }));
});

test('R-02 打断取消已排队旧音频：停止旧流节点、重置排程、丢弃迟到块、不发旧流 drained', async () => {
  const client = new CallClient('ws://127.0.0.1:1/ws/call/sc_2', 'tok', {
    onState: () => undefined, onPartial: () => undefined, onFinal: () => undefined, onReply: () => undefined,
    onNotice: () => undefined, onError: () => undefined, onMicLevel: () => undefined,
  });
  const connecting = client.connect();
  await sleep(10);
  wsInstances.at(-1)!.onopen!();
  await connecting;
  const baseTexts = texts().length; // module 级帧记录跨用例累积：本用例断言用增量
  serverSend(JSON.stringify({ t: 'ready', protocol: 2, audio: { input_rate: 16000, output_rate: 24000, format: 'pcm16' }, capabilities: { voice_interrupt: true } }));
  serverSend(JSON.stringify({ t: 'state', state: 'listening' }));
  await sleep(30); // startMic 完成，首轮 start 已发
  const textsFrom = (): Array<Record<string, unknown>> => texts().slice(baseTexts);

  // 服务端说话中：旧输出流 os_old 排 2 块各 1 秒（16000 samples @16k）
  const baseSources = audioSources.length;
  const oneSecond = new Uint8Array(32000).fill(0x10);
  serverSend(JSON.stringify({ t: 'pcm', stream_id: 'os_old', sequence: 0, rate: 16000, bytes: 32000 }));
  serverSend(oneSecond.buffer);
  serverSend(JSON.stringify({ t: 'pcm', stream_id: 'os_old', sequence: 1, rate: 16000, bytes: 32000 }));
  serverSend(oneSecond.buffer);
  await sleep(20);
  const queued = audioSources.slice(baseSources).filter((s) => s.started);
  assert.equal(queued.length, 2, '两块旧音频已排队');
  assert.ok(queued[0]!.startAt < queued[1]!.startAt, '按顺序排程');

  // 播放到 0.2s，他在说话（speaking），她开口打断
  audioContexts.at(-1)!.currentTime = 0.2;
  serverSend(JSON.stringify({ t: 'state', state: 'speaking' }));
  speechFrame();
  await sleep(20);
  const interrupts = textsFrom().filter((m) => m['t'] === 'interrupt');
  assert.equal(interrupts.length, 1, 'barge-in 发 interrupt');
  // R-02 核心：旧流已排队节点被 stop（不再播旧话），且不是等服务端确认才停
  assert.equal(queued.filter((s) => s.stopped).length, 2, '本地打断立即停止已排队旧节点');

  // 服务端确认 interrupted(os_old)（幂等，迟到无害）
  serverSend(JSON.stringify({ t: 'interrupted', stream_id: 'os_old' }));
  await sleep(20);

  // 迟到的旧流块：丢弃，不进播放队列
  const decodedBefore = decodedPcm.length;
  serverSend(JSON.stringify({ t: 'pcm', stream_id: 'os_old', sequence: 2, rate: 16000, bytes: 32000 }));
  serverSend(oneSecond.buffer);
  await sleep(20);
  assert.equal(decodedPcm.length, decodedBefore, '已作废流的迟到二进制块被丢弃');

  // 新回复流 os_new：首块从当前时刻附近开始（不被旧队列的 2.05s 拖住）
  serverSend(JSON.stringify({ t: 'pcm', stream_id: 'os_new', sequence: 0, rate: 16000, bytes: 32000 }));
  serverSend(oneSecond.buffer);
  await sleep(20);
  const newest = audioSources.slice(baseSources).filter((s) => s.started && !s.stopped).at(-1)!;
  assert.ok(newest.startAt <= 0.2 + 0.06, `新流首块应排在打断后近处，实际 ${newest.startAt}`);

  // 旧流 pcm_end 到达：不发送已作废流的 playback_drained
  serverSend(JSON.stringify({ t: 'pcm_end', stream_id: 'os_old' }));
  await sleep(120);
  assert.equal(textsFrom().filter((m) => m['t'] === 'playback_drained' && m['stream_id'] === 'os_old').length, 0, '作废流不宣称播完');
  // 新流正常 drain（新块排到 ~1.26s：等待覆盖播放完成）
  serverSend(JSON.stringify({ t: 'pcm_end', stream_id: 'os_new' }));
  await sleep(1400);
  assert.equal(textsFrom().filter((m) => m['t'] === 'playback_drained' && m['stream_id'] === 'os_new').length, 1, '新流正常 ACK');

  await client.hangup();
  console.log(JSON.stringify({ case: 'r02_interrupt_cancels_playback', old_nodes_stopped: 2, late_chunk_dropped: true, new_stream_rescheduled: newest.startAt, stale_drain_suppressed: true }));
});

test('JV-02 跨轮播放续接：第二轮块以当前音频时钟排程（不落在过去重叠播放）', async () => {
  const client = new CallClient('ws://127.0.0.1:1/ws/call/sc_3', 'tok', {
    onState: () => undefined, onPartial: () => undefined, onFinal: () => undefined, onReply: () => undefined,
    onNotice: () => undefined, onError: () => undefined, onMicLevel: () => undefined,
  });
  const connecting = client.connect();
  await sleep(10);
  wsInstances.at(-1)!.onopen!();
  await connecting;
  serverSend(JSON.stringify({ t: 'ready', protocol: 2, audio: { input_rate: 16000, output_rate: 24000, format: 'pcm16' }, capabilities: { voice_interrupt: true } }));
  serverSend(JSON.stringify({ t: 'state', state: 'listening' }));
  await sleep(30);
  const base2 = audioSources.length;
  const oneSecond = new Uint8Array(32000).fill(0x10);

  // 第一轮：两块各 1s（排到 ~2.05s），真实时钟走完（currentTime 推进模拟播放）
  serverSend(JSON.stringify({ t: 'pcm', stream_id: 'r1a', sequence: 0, rate: 16000, bytes: 32000 }));
  serverSend(oneSecond.buffer);
  serverSend(JSON.stringify({ t: 'pcm', stream_id: 'r1a', sequence: 1, rate: 16000, bytes: 32000 }));
  serverSend(oneSecond.buffer);
  serverSend(JSON.stringify({ t: 'pcm_end', stream_id: 'r1a' }));
  audioContexts.at(-1)!.currentTime = 2.3; // 第一轮播完 + 正常静默（真实时钟已前进）
  await sleep(20);

  // 第二轮（她再说一句，他回复）：新流第一块必须排在当前时刻附近（≈2.35），
  // 而不是第一轮遗留的过去时刻（≈2.05）——修复前块 start 在过去 → 浏览器立即全部重叠播放
  serverSend(JSON.stringify({ t: 'pcm', stream_id: 'r2a', sequence: 0, rate: 16000, bytes: 32000 }));
  serverSend(oneSecond.buffer);
  await sleep(20);
  const secondRound = audioSources.slice(base2);
  assert.equal(secondRound.length, 3, '第一轮 2 块 + 第二轮 1 块');
  const firstRoundBlocks = secondRound.slice(0, 2);
  const r2 = secondRound[2]!;
  assert.ok(r2.startAt > audioContexts.at(-1)!.currentTime, `第二轮排在当前时刻之后，实际 ${r2.startAt}`);
  assert.ok(r2.startAt <= audioContexts.at(-1)!.currentTime + 0.06, `第二轮紧贴当前时刻续接（+抖动），实际 ${r2.startAt}`);
  assert.ok(firstRoundBlocks[1]!.startAt < firstRoundBlocks[0]!.startAt + 1.5, '第一轮块保持顺序');
  await client.hangup();
  console.log(JSON.stringify({ case: 'jv02_cross_turn_reschedule', second_round_start: r2.startAt, no_overlap: true }));
});
