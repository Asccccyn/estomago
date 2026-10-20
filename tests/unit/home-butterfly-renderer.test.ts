import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../apps/web/src/home/latest-butterfly/renderer.js', import.meta.url), 'utf8');

class Events {
  listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(name: string, listener: (event: any) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: (event: any) => void) {
    this.listeners.get(name)?.delete(listener);
  }
  emit(name: string, event: any = {}) {
    for (const listener of [...(this.listeners.get(name) || [])]) listener(event);
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

function mount(options: Record<string, any> = {}, environment: { hidden?: boolean; failedAsset?: string; scale?: number } = {}) {
  const frames = new Map<number, (time: number) => void>();
  const requests: string[] = [];
  const paints: Array<{ time: number; still: boolean; pixelRatio: number }> = [];
  let frameId = 0;
  let drawCalls = 0;
  let scale = environment.scale ?? 1;
  let disconnected = false;
  const noop = () => {};
  const context = {
    setTransform: noop, clearRect: noop, translate: noop, save: noop, restore: noop,
    scale: noop, transform: noop, beginPath: noop, closePath: noop, clip: noop, moveTo: noop, lineTo: noop,
    drawImage() { drawCalls++; },
    getImageData(_x: number, _y: number, width: number, height: number) {
      return { data: new Uint8ClampedArray(width * height * 4).fill(255) };
    },
  };
  const makeCanvas = () => ({
    width: 500, height: 500,
    getBoundingClientRect() { return { width: 500, height: 500 }; },
    getContext() { return context; },
  });
  const canvas = makeCanvas();
  const media = Object.assign(new Events(), { matches: false });
  const document = Object.assign(new Events(), {
    hidden: Boolean(environment.hidden),
    currentScript: { src: 'https://example.test/home/latest-butterfly/renderer.js' },
    createElement(name: string) { assert.equal(name, 'canvas'); return makeCanvas(); },
  });
  const parent = { frameElement: null };
  const window: any = Object.assign(new Events(), {
    devicePixelRatio: 3,
    frameElement: {
      offsetWidth: 500,
      getBoundingClientRect() { return { width: 500 * scale }; },
    },
    parent,
    matchMedia() { return media; },
    requestAnimationFrame(callback: (time: number) => void) {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    BUTTERFLY_RIG: {
      width: 16, height: 16, pivot: [8, 8],
      particleGroups: ['assets/particles-01.png', 'assets/particles-02.png'],
      tails: { left: { anchor: [3, 3], tip: [12, 12] } },
    },
  });
  class MockImage {
    width = 16;
    height = 16;
    onload = noop;
    onerror = noop;
    set src(value: string) {
      requests.push(value);
      queueMicrotask(() => value.endsWith(environment.failedAsset || '\0') ? this.onerror() : this.onload());
    }
  }
  runInNewContext(source, {
    window, document, URL, Image: MockImage,
    ResizeObserver: class {
      observe() {}
      disconnect() { disconnected = true; }
    },
  }, { filename: 'renderer.js' });
  const api = window.mountButterfly(canvas, {
    ...options,
    onFrame(frame: { time: number; still: boolean; pixelRatio: number }) {
      paints.push(frame);
      options.onFrame?.(frame);
    },
  });
  return {
    api, canvas, document, window, media, frames, paints, requests,
    get drawCalls() { return drawCalls; },
    get disconnected() { return disconnected; },
    setScale(value: number) { scale = value; window.emit('resize'); },
    advance(now: number) {
      for (const [id, callback] of [...frames]) {
        if (frames.delete(id)) callback(now);
      }
    },
  };
}

test('a 120 Hz display keeps one loop and paints the complete butterfly at 30 fps', async () => {
  const harness = mount();
  await harness.api.ready;
  assert.equal(harness.paints.length, 1, 'initial artwork is drawn only once');
  for (let index = 0; index < 5; index++) harness.api.play();
  assert.equal(harness.frames.size, 1);
  for (let index = 0; index <= 120; index++) {
    harness.advance(index * 1000 / 120);
    assert.equal(harness.frames.size, 1, 'play and frame callbacks cannot create competing loops');
  }
  assert.equal(harness.paints.length, 32, 'one initial draw plus 31 evenly timed animation samples');
  assert.ok(Math.abs(harness.api.state.time - 1000) < .01, 'throttling does not slow the motion');
  assert.ok(harness.drawCalls > harness.paints.length * 7, 'artwork and articulated tail are still rendered');
  harness.api.pause();
  assert.equal(harness.frames.size, 0);
  harness.api.destroy();
});

test('background and bfcache suspension stop rendering and resume without a time jump', async () => {
  const harness = mount();
  await harness.api.ready;
  harness.advance(100);
  harness.advance(140);
  const elapsed = harness.api.state.time;
  const paintCount = harness.paints.length;
  harness.document.hidden = true;
  harness.document.emit('visibilitychange');
  assert.equal(harness.frames.size, 0);
  harness.api.play();
  harness.advance(10_000);
  assert.equal(harness.paints.length, paintCount);
  harness.document.hidden = false;
  harness.document.emit('visibilitychange');
  assert.equal(harness.frames.size, 1);
  harness.advance(20_000);
  assert.equal(harness.api.state.time, elapsed, 'hidden time is not added to the animation');
  harness.window.emit('pagehide');
  assert.equal(harness.frames.size, 0);
  harness.window.emit('pageshow');
  harness.window.emit('pageshow');
  assert.equal(harness.frames.size, 1);
  harness.api.pause();
  harness.document.emit('visibilitychange');
  harness.window.emit('pageshow');
  assert.equal(harness.frames.size, 0, 'visibility cannot override an explicit pause');
  harness.api.destroy();
  assert.equal(harness.document.listenerCount + harness.window.listenerCount + harness.media.listenerCount, 0);
  assert.equal(harness.disconnected, true);
});

test('a page loaded hidden paints the still frame without starting an animation loop', async () => {
  const harness = mount({}, { hidden: true });
  await harness.api.ready;
  assert.equal(harness.paints.length, 1);
  assert.equal(harness.frames.size, 0);
  harness.document.hidden = false;
  harness.document.emit('visibilitychange');
  assert.equal(harness.frames.size, 1);
  harness.api.destroy();
});

test('reduced motion and callback-triggered pause cannot accidentally restart a loop', async () => {
  const harness = mount();
  await harness.api.ready;
  harness.media.emit('change', { matches: true });
  assert.equal(harness.paints.at(-1)?.still, true);
  assert.equal(harness.frames.size, 0);
  harness.api.play();
  assert.equal(harness.frames.size, 0);
  harness.api.setReducedMotion(false);
  assert.equal(harness.frames.size, 1);
  harness.api.setMotion(false);
  assert.equal(harness.frames.size, 0);
  harness.api.setMotion(true);
  assert.equal(harness.frames.size, 1);
  harness.api.destroy();

  let api: any;
  const duringFrame = mount({ onFrame() { api?.pause(); } });
  api = duringFrame.api;
  await api.ready;
  assert.equal(duringFrame.frames.size, 0, 'an onFrame callback can pause the initial paint');
  api.play();
  duringFrame.advance(100);
  assert.equal(duringFrame.frames.size, 0, 'a pause inside tick is respected by its reschedule');
  api.destroy();
});

test('grouped particles start loading with wings and do not download the duplicate composite', async () => {
  const harness = mount({ assets: { leftForewing: 'assets/shared-wing.png', leftHindwing: 'assets/shared-wing.png' } });
  assert.equal(harness.requests.filter(url => url.includes('particles-')).length, 2, 'particles begin before any wing load settles');
  await harness.api.ready;
  assert.equal(harness.requests.filter(url => url.endsWith('/shared-wing.png')).length, 1, 'a shared asset is decoded once');
  assert.equal(harness.requests.some(url => url.endsWith('/particles.png')), false);
  harness.api.destroy();
  const disabled = mount({ particles: false });
  await disabled.api.ready;
  assert.equal(disabled.requests.some(url => url.includes('particles')), false, 'disabled particles require no network work');
  disabled.api.destroy();
});

test('a failed particle group falls back to the intact composite without failing the butterfly', async () => {
  const warnings: Error[] = [];
  const harness = mount({ onWarning(error: Error) { warnings.push(error); } }, { failedAsset: 'particles-01.png' });
  await harness.api.ready;
  assert.equal(warnings.length, 1);
  assert.equal(harness.requests.filter(url => url.endsWith('/particles.png')).length, 1);
  assert.equal(harness.api.state.ready, true);
  assert.equal(harness.frames.size, 1);
  harness.api.destroy();
});

test('backing pixels follow the iframe screen scale and update with its resize event', async () => {
  const harness = mount({}, { scale: .6 });
  await harness.api.ready;
  assert.equal(harness.canvas.width, 600);
  assert.equal(harness.canvas.height, 600);
  assert.equal(harness.paints.at(-1)?.pixelRatio, 1.2);
  assert.equal(harness.api.state.pixelRatio, 1.2);
  harness.setScale(.8);
  assert.equal(harness.canvas.width, 800);
  assert.equal(harness.paints.at(-1)?.pixelRatio, 1.6);
  assert.equal(harness.frames.size, 1);
  harness.api.destroy();
});

test('failed required artwork releases observers and lifecycle listeners', async () => {
  const harness = mount({}, { failedAsset: 'body.png' });
  await assert.rejects(harness.api.ready, /无法加载蝴蝶素材/);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.disconnected, true);
  assert.equal(harness.document.listenerCount + harness.window.listenerCount + harness.media.listenerCount, 0);
});
