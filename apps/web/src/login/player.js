/* Login canvas sizing and motion preferences; playback belongs to animation.js. */
(() => {
  'use strict';
  const canvas = document.getElementById('scene');
  const stage = document.querySelector('.stage');
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const state = { paused: true, progress: 0, duration: 10.1, ended: false };
  let viewport = { width: 0, height: 0, dpr: 1, aspect: 1, portrait: false };
  let focusedViewport = null;
  const editing = () => document.activeElement?.matches('input, textarea, [contenteditable="true"]');

  function setState(next = {}) {
    if (typeof next.paused === 'boolean') state.paused = next.paused;
    if (typeof next.ended === 'boolean') state.ended = next.ended;
    if (Number.isFinite(next.progress)) state.progress = Math.max(0, Math.min(1, next.progress));
    if (Number.isFinite(next.duration) && next.duration > 0) state.duration = next.duration;
  }

  function holdInputLayout() {
    if (focusedViewport || !editing() || !viewport.height) return;
    focusedViewport = {
      width: viewport.width,
      visualHeight: window.visualViewport?.height ?? window.innerHeight,
    };
    // Freeze CSS size as well as the backing canvas: a shrinking 100dvh would
    // otherwise stretch the artwork and move the form when the keyboard opens.
    stage.style.height = `${viewport.height}px`;
  }

  function resize() {
    let rect = stage.getBoundingClientRect();
    if (focusedViewport) {
      const rotated = Math.abs(rect.width - focusedViewport.width) > 1;
      const visualHeight = window.visualViewport?.height ?? window.innerHeight;
      const keyboardClosed = visualHeight >= focusedViewport.visualHeight - 64;
      if (rotated || (!editing() && keyboardClosed)) {
        focusedViewport = null;
        stage.style.removeProperty('height');
        rect = stage.getBoundingClientRect();
      }
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    if (width !== viewport.width || height !== viewport.height || dpr !== viewport.dpr) {
      viewport = { width, height, dpr, aspect: width / height, portrait: height > width };
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      window.dispatchEvent(new CustomEvent('scene:resize', { detail: { ...viewport } }));
    }
    holdInputLayout();
  }

  window.AnimationPlayer = Object.freeze({
    canvas,
    get viewport() { return { ...viewport }; },
    get state() { return { ...state }; },
    get reducedMotion() { return motionQuery.matches; },
    setState,
    resize,
  });
  stage.addEventListener('focusin', holdInputLayout);
  stage.addEventListener('focusout', () => requestAnimationFrame(resize));
  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('pageshow', resize);
  window.visualViewport?.addEventListener('resize', resize, { passive: true });
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  motionQuery.addEventListener('change', event => {
    window.dispatchEvent(new CustomEvent('scene:motion-preference', { detail: { reducedMotion: event.matches } }));
  });
  resize();
})();
