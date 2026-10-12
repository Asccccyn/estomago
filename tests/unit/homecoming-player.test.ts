// Controlled DOM / animation-clock VM tests, not a browser or visual acceptance test.
// Run production player + animation sources; use the real journey state calculation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const LOGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/web/src/login');
const sources = new Map(['player.js', 'cord.js', 'scene.js', 'journey.js', 'animation.js']
  .map(name => [name, fs.readFileSync(path.join(LOGIN, name), 'utf8')]));

function events() {
  const listeners = new Map<string, Array<(event: any) => void>>();
  return {
    addEventListener(type: string, callback: (event: any) => void) {
      const callbacks = listeners.get(type) ?? [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
    dispatchEvent(event: any) {
      for (const callback of listeners.get(event.type) ?? []) callback(event);
      return true;
    },
  };
}

function style(): Record<string, any> {
  return {
    setProperty(name: string, value: unknown) { this[name] = String(value); },
    removeProperty(name: string) { delete this[name]; },
  };
}

function harness(options: {
  hidden?: boolean; reducedMotion?: boolean; canvas?: boolean; player?: boolean; realRender?: boolean;
} = {}) {
  const frames = new Map<number, (now: number) => void>();
  const images: any[] = [];
  const rendered: number[] = [];
  let nextFrame = 0;
  let imageDraws = 0;
  const context2d = new Proxy({
    drawImage(image: any) {
      imageDraws++;
      assert.ok(image.complete, 'An unavailable hand sheet must never be drawn by final-state fallback');
    },
  } as Record<string, any>, {
    get(target, key: string) { return key in target ? target[key] : () => {}; },
    set(target, key: string, value: unknown) { target[key] = value; return true; },
  });
  const canvas = { width: 0, height: 0, getContext: () => options.canvas === false ? null : context2d };
  const stage = { ...events(), style: style(), getBoundingClientRect: () => ({ width: 390, height: 844 }) };
  const login = { hidden: true, inert: true, style: style() };
  const status = { textContent: '' };
  const nodes = new Map<string, any>([['scene', canvas], ['login-panel', login], ['status', status]]);
  const document = {
    ...events(), hidden: options.hidden ?? false, activeElement: null,
    getElementById: (id: string) => nodes.get(id),
    querySelector: (selector: string) => selector === '.stage' ? stage : null,
    createElement: () => ({ width: 0, height: 0, getContext: () => context2d }),
  };
  const motion = { ...events(), matches: options.reducedMotion ?? false };
  const window: any = {
    ...events(), devicePixelRatio: 3, innerHeight: 844,
    visualViewport: { ...events(), height: 844 }, matchMedia: () => motion,
  };
  const context = vm.createContext({
    window, document,
    CustomEvent: class {
      type: string; detail: unknown;
      constructor(type: string, init: { detail: unknown }) { this.type = type; this.detail = init.detail; }
    },
    ResizeObserver: class { observe() {} },
    Image: class {
      src = ''; complete = false; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      constructor() { images.push(this); }
    },
    requestAnimationFrame(callback: (now: number) => void) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  });
  function run(name: string) {
    vm.runInContext(sources.get(name)!, context, { filename: name, timeout: 1000 });
  }
  if (options.player !== false) run('player.js');
  for (const name of ['cord.js', 'scene.js', 'journey.js']) run(name);
  const actualRender = window.PinkyJourney.render;
  window.PinkyJourney.render = (...args: any[]) => {
    const [, , width, height, time, unit] = args;
    rendered.push(time);
    // Lifecycle tests need the real timeline but not thousands of rope paint calls.
    // Degradation tests opt into the actual renderer to check its sheet-free end state.
    return options.realRender ? actualRender(...args) : window.PinkyJourney.stateAt(time, width, height, unit);
  };
  run('animation.js');
  return {
    window, document, login, status, canvas, images, rendered,
    get pendingFrames() { return frames.size; },
    get imageDraws() { return imageDraws; },
    get state() { return window.AnimationPlayer.state; },
    step(now: number) {
      const pending = [...frames];
      frames.clear();
      for (const [, callback] of pending) callback(now);
    },
    visibility(hidden: boolean) {
      document.hidden = hidden;
      document.dispatchEvent({ type: 'visibilitychange' });
    },
    reduceMotion(matches: boolean) {
      motion.matches = matches;
      motion.dispatchEvent({ type: 'change', matches });
    },
    load() { images[0].complete = true; images[0].onload(); },
    fail() { images[0].onerror(); },
  };
}

function assertLoginUsable(h: ReturnType<typeof harness>) {
  assert.equal(h.login.hidden, false, 'The actual login panel must be visible');
  assert.equal(h.login.inert, false, 'The actual login panel must accept input');
  assert.equal(Number(h.login.style.opacity), 1);
  for (const part of ['title', 'names', 'fields', 'door']) {
    assert.ok(Number(h.login.style[`--${part}-opacity`]) > .999, `${part} must not retain its animation-hidden opacity`);
  }
  assert.ok(h.login.style.width && h.login.style.height, 'The fallback needs an actual form layout');
}

test('homecoming: hidden pauses; visible resumes the same position without a background time jump', () => {
  const h = harness();
  assert.equal(h.images[0].src, '/login/assets/pinky-cels-original.png');
  assert.equal(h.canvas.width, 780, 'DPR must remain capped at 2');
  assert.equal(h.canvas.height, 1688);
  h.load();
  assert.equal(h.pendingFrames, 1);
  h.step(1000);
  h.step(1050);
  const progress = h.state.progress;
  assert.ok(progress > 0);
  h.visibility(true);
  assert.equal(h.pendingFrames, 0);
  assert.equal(h.state.paused, true);
  h.step(50000);
  assert.equal(h.state.progress, progress);
  h.visibility(false);
  h.visibility(false);
  assert.equal(h.pendingFrames, 1, 'Repeated foreground events must not create duplicate loops');
  assert.equal(h.state.paused, false);
  h.step(50100);
  assert.equal(h.state.progress, progress, 'The first resumed frame resets its timestamp');
  h.step(50150);
  assert.ok(h.state.progress > progress);
  assert.ok(h.state.progress < progress + .01);
});

test('homecoming: a sheet that loads while hidden starts on returning to the foreground', () => {
  const h = harness({ hidden: true });
  h.load();
  assert.equal(h.pendingFrames, 0);
  assert.equal(h.state.paused, true);
  h.visibility(false);
  assert.equal(h.pendingFrames, 1);
  h.step(1000);
  h.step(1050);
  assert.ok(h.state.progress > 0);
});

test('homecoming: a completed login never replays after visibility or pageshow events', () => {
  const h = harness();
  h.load();
  for (let i = 0; i < 180; i++) h.step(1000 + i * 60);
  assert.equal(h.state.progress, 1);
  assert.equal(h.state.ended, true);
  assert.equal(h.pendingFrames, 0);
  assertLoginUsable(h);
  const renderedCount = h.rendered.length;
  h.visibility(true);
  h.visibility(false);
  h.window.dispatchEvent({ type: 'pagehide' });
  h.window.dispatchEvent({ type: 'pageshow' });
  h.step(90000);
  assert.equal(h.state.progress, 1);
  assert.equal(h.pendingFrames, 0);
  assert.equal(h.rendered.length, renderedCount);
  assertLoginUsable(h);
});

test('homecoming: reduced motion immediately renders the sheet-free final login', () => {
  const h = harness({ reducedMotion: true, realRender: true });
  assertLoginUsable(h);
  assert.equal(h.state.ended, true);
  assert.equal(h.pendingFrames, 0);
  assert.equal(h.images[0].src, '', 'Reduced motion must not wait for the sheet download');
  assert.equal(h.imageDraws, 0);
  h.reduceMotion(false);
  h.visibility(false);
  assert.equal(h.pendingFrames, 0);
  assertLoginUsable(h);
});

test('homecoming: enabling reduced motion during playback finishes and cancels the loop', () => {
  const h = harness();
  h.load();
  h.step(1000);
  h.step(1050);
  h.reduceMotion(true);
  assert.equal(h.pendingFrames, 0);
  assert.equal(h.state.progress, 1);
  assertLoginUsable(h);
});

test('homecoming: image load failure still paints the real final rope and enables login', () => {
  const h = harness({ realRender: true });
  h.fail();
  assertLoginUsable(h);
  assert.equal(h.imageDraws, 0, 'The final renderer must not read the broken hand sheet');
  assert.equal(h.rendered.at(-1), h.window.PinkyJourney.duration);
  assert.equal(h.pendingFrames, 0);
  h.visibility(true);
  h.visibility(false);
  assert.equal(h.pendingFrames, 0);
});

test('homecoming: unavailable Canvas leaves the DOM login fully usable', () => {
  const h = harness({ canvas: false });
  assertLoginUsable(h);
  assert.equal(h.pendingFrames, 0);
  assert.equal(h.rendered.length, 0, 'Canvas fallback must not call the painter');
  assert.equal(h.state.ended, true);
});

test('homecoming: a missing player script does not trap login behind hidden or inert', () => {
  const h = harness({ player: false });
  assertLoginUsable(h);
  assert.equal(h.pendingFrames, 0);
  assert.equal(h.images.length, 0);
  assert.match(h.login.style.width, /min\(/, 'Static fallback still fits a phone or desktop');
  assert.match(h.login.style.height, /min\(/);
});
