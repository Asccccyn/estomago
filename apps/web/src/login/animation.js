(() => {
  'use strict';
  const player = window.AnimationPlayer;
  const login = document.getElementById('login-panel');
  if (!player) {
    // A failed sizing script must not keep the actual login hidden or inert.
    login.hidden = false;
    login.inert = false;
    login.style.left = '50%';
    login.style.top = 'calc(50% - 12px)';
    login.style.width = 'min(440px, calc(100% - 44px))';
    login.style.height = 'min(352px, calc(100% - 112px))';
    login.style.transform = 'translate(-50%, -50%)';
    login.style.opacity = '1';
    for (const part of ['title', 'names', 'fields', 'door']) login.style.setProperty(`--${part}-opacity`, '1');
    return;
  }
  const scene = window.PinkyJourney;
  const ctx = player.canvas.getContext('2d', { alpha: false });
  const canRender = ctx && scene && window.PinkyScene && window.PinkyCord;
  const sheet = new Image();
  const status = document.getElementById('status');
  const duration = scene?.duration ?? 10.1;
  const fade = n => { n = Math.max(0, Math.min(1, n)); return n * n * (3 - 2 * n); };
  let time = 0, playing = false, ready = false, stamp = 0, frame = 0;

  function finalView(width, height, unit) {
    // Keep authentication usable if canvas or an animation module is unavailable.
    if (scene) return scene.stateAt(duration, width, height, unit);
    const frameWidth = Math.min(width - 44 * unit, 440 * unit);
    const frameHeight = Math.min(352 * unit, height - 112 * unit);
    return { camera: height, form: 1, frame: {
      left: (width - frameWidth) / 2, top: (height - frameHeight) / 2 - 12 * unit,
      width: frameWidth, height: frameHeight,
    } };
  }

  function draw() {
    if (!ready) return;
    const { width, height } = player.canvas;
    const ratio = width / player.viewport.width;
    const view = canRender ? scene.render(ctx, sheet, width, height, time, ratio) : finalView(width, height, ratio);
    const box = view.frame;
    login.hidden = view.form === 0;
    login.inert = view.form < 1;
    login.style.left = `${box.left / ratio}px`;
    login.style.top = `${(height + box.top - view.camera) / ratio}px`;
    login.style.width = `${box.width / ratio}px`;
    login.style.height = `${box.height / ratio}px`;
    login.style.opacity = view.form;
    const reveal = time - (scene?.timing.form ?? 8.95);
    login.style.setProperty('--title-opacity', fade(reveal / .65));
    login.style.setProperty('--names-opacity', fade((reveal - .12) / .8));
    login.style.setProperty('--fields-opacity', fade((reveal - .28) / .8));
    login.style.setProperty('--door-opacity', fade((reveal - .5) / .65));
    player.setState({ progress: time / duration, duration, paused: !playing, ended: time >= duration });
  }

  function tick(now) {
    if (!playing) return;
    if (stamp) time = Math.min(duration, time + Math.min((now - stamp) / 1000, .06));
    stamp = now;
    if (time >= duration) playing = false;
    draw();
    if (playing) frame = requestAnimationFrame(tick);
  }

  function play() {
    if (!ready || playing || document.hidden || player.reducedMotion || time >= duration) return;
    playing = true;
    stamp = 0;
    draw();
    frame = requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    stamp = 0;
    cancelAnimationFrame(frame);
    player.setState({ paused: true });
  }

  function finish() {
    pause();
    ready = true;
    time = duration;
    // At the final camera position journey never reads the hand sheet.
    draw();
  }

  window.addEventListener('scene:resize', draw);
  window.addEventListener('scene:motion-preference', event => {
    if (event.detail.reducedMotion) finish();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else play();
  });
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', play);
  sheet.onload = () => {
    ready = true;
    if (player.reducedMotion || time >= duration) finish();
    else { draw(); play(); }
  };
  sheet.onerror = () => {
    finish();
    if (status) status.textContent = '动画未能加载，您仍可登录。';
  };
  if (!canRender || player.reducedMotion) finish();
  else sheet.src = '/login/assets/pinky-cels-original.png';
})();
