// P3（四仓合并审计 20261106，V03）：CallClient 终局清理——所有终止源（主动挂断、
// 远端关闭、连接失败、授权晚到）共用幂等 terminal cleanup。真实 CallClient，仅替换
// 浏览器 WS/麦克风边界（与审计独立探针同法，不改私有状态）。
// 反例见证（旧实现）：CONNECTING 挂断后 socket 仍 OPEN 且送出 ready；remote close
// 后晚到授权重建 AudioContext 回 listening、track 不释放。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallClient } from '../../apps/web/react/src/call-client.ts';

type Frame = Record<string, unknown>;
const sockets: Array<SocketStub> = [];
class SocketStub {
  static OPEN = 1; static CONNECTING = 0;
  readyState = 0; onopen: (() => void) | null = null; onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null; onerror: (() => void) | null = null;
  sent: Frame[] = []; closes: number = 0;
  constructor() { sockets.push(this); }
  send(s: string) { this.sent.push(JSON.parse(s) as Frame); }
  close() { this.closes++; this.readyState = 3; this.onclose?.({ code: 1000 }); }
  open() { this.readyState = 1; this.onopen?.(); }
  remoteClose() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}
const states: string[] = [];
const events = { onState: (s: string) => states.push(s), onPartial() {}, onFinal() {}, onReply() {}, onNotice() {}, onError() {}, onMicLevel() {} };
let resolveMedia: ((stream: { getTracks(): Array<{ stop(): void }> }) => void) | null = null;
let stopped = 0;
let mediaRequested = false;
const ctxs: Array<{ state: string }> = [];

test.before(() => {
  (globalThis as unknown as Record<string, unknown>)['WebSocket'] = SocketStub;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise((r) => { mediaRequested = true; resolveMedia = r as typeof resolveMedia; }) } } });
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
  (globalThis as unknown as Record<string, unknown>)['AudioContext'] = class {
    state = 'running'; sampleRate = 16000; audioWorklet = { addModule: async () => {} };
    constructor() { ctxs.push(this); }
    async resume() {} async close() { this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {} }; }
  };
  (globalThis as unknown as Record<string, unknown>)['AudioWorkletNode'] = class { port = {}; disconnect() {} };
});

test('V03-①：CONNECTING 期挂断=终局——socket 被关、之后零帧、connect 等待被 settle', async () => {
  states.length = 0;
  const client = new CallClient('ws://127.0.0.1:1/ws/call/synthetic-1', 'audit-token', events as never);
  const connecting = client.connect().then(() => 'opened', (err) => `rejected:${(err as Error).message}`);
  const socket = sockets.at(-1)!;
  assert.equal(socket.readyState, SocketStub.CONNECTING, '前置：握手未完成');
  await client.hangup();
  assert.ok(states.includes('ended'), 'UI 进入 ended');
  assert.equal(socket.closes, 1, '终局关闭 CONNECTING socket（旧实现不关）');
  const outcome = await connecting;
  assert.match(String(outcome), /rejected:call_terminated:local_hangup|^opened$/, 'connect 等待被 settle（不再悬挂）');
  socket.open(); // 模拟极端迟到 open——浏览器 close(CONNECTING) 后不会发生；证明客户端不再使用
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(socket.sent.filter((f) => f['t'] === 'ready').length, 0, '终局后不再送出任何握手帧（旧实现仍发 ready）');
});

test('V03-②：授权等待中远端关闭=终局——晚到授权立即释放 track、不重建上下文、UI 保持 ended', async () => {
  states.length = 0; stopped = 0; mediaRequested = false;
  const failures: string[] = [];
  const client = new CallClient('ws://127.0.0.1:1/ws/call/synthetic-2', 'audit-token', {
    ...events, onError: message => failures.push(message),
  });
  const connecting = client.connect();
  const socket = sockets.at(-1)!;
  socket.open();
  await connecting;
  socket.onmessage?.({ data: JSON.stringify({ t: 'ready', protocol: 2, capabilities: { voice_interrupt: true } }) });
  assert.ok(mediaRequested, '前置：已请求麦克风、授权未回');
  socket.remoteClose();
  assert.equal(states.at(-1), 'ended');
  assert.deepEqual(failures, ['通话连接中断（1006）']);
  resolveMedia?.({ getTracks: () => [{ stop() { stopped++; } }] });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stopped, 1, '晚到授权的 track 立即释放（旧实现 0 泄漏）');
  assert.equal(ctxs.length, 0, '不重建 AudioContext（旧实现重建并回 listening）');
  assert.equal(states.at(-1), 'ended', 'UI 保持 ended（旧实现回 listening）');
});

test('V03-③：WS 打开后的真实连接错误关闭连接与收音，诊断仍交给错误出口', async () => {
  const failures: string[] = [];
  const client = new CallClient('ws://127.0.0.1:1/ws/call/synthetic-3', 'audit-token', {
    ...events, onError: message => failures.push(message),
  });
  const connecting = client.connect();
  const socket = sockets.at(-1)!;
  socket.open();
  await connecting;
  const sentBefore = socket.sent.length;
  let tracksClosed = 0;
  socket.onmessage?.({ data: JSON.stringify({ t: 'ready', protocol: 2, capabilities: { voice_interrupt: true } }) });
  resolveMedia?.({ getTracks: () => [{ stop() { tracksClosed++; } }] });
  await new Promise(resolve => setTimeout(resolve, 10));
  socket.onerror?.();
  assert.equal(socket.closes, 1);
  assert.equal(tracksClosed, 1);
  assert.equal(states.at(-1), 'ended');
  assert.deepEqual(failures, ['通话连接失败']);
  assert.equal(socket.sent.length, sentBefore);
});

test('V03-④：设备授权失败释放已打开的 WS，并交付麦克风诊断', async () => {
  const originalMedia = navigator.mediaDevices;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => { throw new DOMException('synthetic denial', 'NotAllowedError'); },
  } });
  try {
    const failures: string[] = [];
    const client = new CallClient('ws://127.0.0.1:1/ws/call/synthetic-4', 'audit-token', {
      ...events, onError: message => failures.push(message),
    });
    const connecting = client.connect();
    const socket = sockets.at(-1)!;
    socket.open();
    await connecting;
    socket.onmessage?.({ data: JSON.stringify({ t: 'ready', protocol: 2, capabilities: { voice_interrupt: true } }) });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(socket.closes, 1);
    assert.equal(states.at(-1), 'ended');
    assert.match(failures[0] ?? '', /麦克风/);
    assert.deepEqual(socket.sent.map(frame => frame.t), ['ready']);
  } finally {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: originalMedia });
  }
});
