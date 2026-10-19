// Run the real homepage script with no butterfly canvas: cord rendering must
// remain independent, and an interrupted reveal must leave complete lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../apps/web/src/home/latest-interactions.js', import.meta.url), 'utf8');

class Events {
  listeners = new Map<string, Set<() => void>>();
  addEventListener(name: string, listener: () => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: () => void) {
    this.listeners.get(name)?.delete(listener);
  }
  emit(name: string) {
    for (const listener of [...(this.listeners.get(name) || [])]) listener();
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

class StrokeStyle {
  strokeDasharray = '';
  offset = '';
  failNextOffset = false;
  get strokeDashoffset() { return this.offset; }
  set strokeDashoffset(value: string) {
    if (this.failNextOffset) {
      this.failNextOffset = false;
      throw new Error('SVG style update unavailable');
    }
    this.offset = value;
  }
  removeProperty(name: string) {
    if (name === 'stroke-dasharray') this.strokeDasharray = '';
    if (name === 'stroke-dashoffset') this.offset = '';
  }
}

function mount(lengths: Array<number | Error>, options: { reduced?: boolean; hidden?: boolean } = {}) {
  let measurements = 0;
  let canvasLookups = 0;
  let frameId = 0;
  const start = 1250;
  let now = start;
  const frames = new Map<number, (time: number) => void>();
  const paths = lengths.map(length => ({
    style: new StrokeStyle(),
    getTotalLength() {
      measurements++;
      if (length instanceof Error) throw length;
      return length;
    },
  }));
  const media = Object.assign(new Events(), { matches: Boolean(options.reduced) });
  const document = Object.assign(new Events(), {
    hidden: Boolean(options.hidden),
    querySelectorAll(selector: string) {
      assert.equal(selector, '.drawn-red-cord .thread-line');
      return paths;
    },
    getElementById(id: string) {
      assert.equal(id, 'latest-butterfly-canvas');
      canvasLookups++;
      return null;
    },
  });
  const window = Object.assign(new Events(), {
    matchMedia(query: string) {
      assert.equal(query, '(prefers-reduced-motion: reduce)');
      return media;
    },
  });
  runInNewContext(source, {
    document,
    window,
    performance: { now: () => now },
    requestAnimationFrame(callback: (time: number) => void) {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    console: { error() { /* Missing butterfly is intentional in these fixtures. */ } },
  }, { filename: 'latest-interactions.js' });
  return {
    paths, media, document, window, frames,
    get measurements() { return measurements; },
    get canvasLookups() { return canvasLookups; },
    advance(elapsed: number) {
      now = start + elapsed;
      const pending = [...frames.entries()];
      for (const [id, callback] of pending) {
        if (!frames.delete(id)) continue;
        callback(now);
      }
    },
  };
}

function assertVisible(harness: ReturnType<typeof mount>) {
  for (const path of harness.paths) {
    assert.equal(path.style.strokeDasharray, '', 'restore the undashed stylesheet fallback');
    assert.equal(path.style.strokeDashoffset, '', 'remove any residual hidden portion');
  }
  assert.equal(harness.frames.size, 0, 'a finished reveal must not keep scheduling frames');
  assert.equal(harness.media.listenerCount, 0);
  assert.equal(harness.document.listenerCount, 0);
  assert.equal(harness.window.listenerCount, 0);
}

test('完整红线按相同实际距离展开，双描边同步，最长一根在四秒完成', () => {
  const harness = mount([400, 400, 1000, 1000]);
  assert.equal(harness.canvasLookups, 1, 'the butterfly setup exits without a canvas');
  assert.equal(harness.frames.size, 1, 'cords still animate independently');
  assert.deepEqual(harness.paths.map(path => path.style.strokeDasharray), ['400 400', '400 400', '1000 1000', '1000 1000']);
  harness.advance(1000);
  assert.deepEqual(harness.paths.map(path => Number(path.style.strokeDashoffset)), [150, 150, 750, 750], 'each path has revealed the same 250 units');
  harness.advance(2000);
  assert.deepEqual(harness.paths.map(path => Number(path.style.strokeDashoffset)), [0, 0, 500, 500], 'shorter cords complete before longer cords');
  harness.advance(3999);
  assert.ok(Number(harness.paths[2].style.strokeDashoffset) > 0, 'the longest cord is not complete early');
  harness.advance(4000);
  assertVisible(harness);
});

test('首次加载已设置减弱动画或页面隐藏时，完整红线直接可见', () => {
  for (const options of [{ reduced: true }, { hidden: true }]) {
    const harness = mount([400, 1000], options);
    assert.equal(harness.measurements, 0);
    assertVisible(harness);
  }
});

test('揭示途中开启减弱动画会显示完整红线，并且不会重新开始', () => {
  const harness = mount([400, 1000]);
  harness.advance(500);
  harness.media.matches = true;
  harness.media.emit('change');
  assertVisible(harness);
  harness.media.matches = false;
  harness.media.emit('change');
  harness.advance(1000);
  assertVisible(harness);
});

test('切至后台或离开页面时取消未完成揭示，返回时保留完整红线', () => {
  for (const event of ['visibilitychange', 'pagehide']) {
    const harness = mount([400, 1000]);
    harness.advance(500);
    if (event === 'visibilitychange') {
      harness.document.hidden = true;
      harness.document.emit(event);
    } else harness.window.emit(event);
    assertVisible(harness);
    harness.document.hidden = false;
    harness.document.emit('visibilitychange');
    harness.advance(1000);
    assertVisible(harness);
  }
});

test('路径测长异常或无效时不隐藏任何红线', () => {
  for (const badLength of [new Error('getTotalLength unavailable'), NaN, Infinity, 0, -1]) {
    const harness = mount([400, badLength, 1000]);
    assertVisible(harness);
    assert.equal(harness.canvasLookups, 1, 'a cord failure must not abort the following script');
  }
});

test('动画帧写入 SVG 失败时恢复所有红线可见', () => {
  const harness = mount([400, 1000]);
  harness.paths[1].style.failNextOffset = true;
  harness.advance(500);
  assertVisible(harness);
});

test('没有红线路径时不启动动画，也不影响后续蝴蝶初始化', () => {
  const harness = mount([]);
  assert.equal(harness.canvasLookups, 1);
  assertVisible(harness);
});
