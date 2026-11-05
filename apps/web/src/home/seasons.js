(() => {
  'use strict';
  const viewport = document.getElementById('seasons');
  const world = document.getElementById('season-world');
  const panorama = document.getElementById('panorama');
  const sceneLayer = document.getElementById('season-scenes');
  const travelLayer = document.getElementById('travelers');
  const veil = document.getElementById('season-veil');
  const canvas = document.getElementById('atmosphere');
  const ctx = canvas.getContext('2d');
  const desktopQuery = matchMedia('(min-width: 900px)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const seasonNames = ['spring', 'summer', 'autumn', 'winter'];
  const seasonLabels = ['春天', '夏天', '秋天', '冬天'];
  const PAIR_WIDTH = .82;
  const ANIMAL_WIDTH_IN_PAIR = .55;
  const SPRITE_WIDTH = PAIR_WIDTH * ANIMAL_WIDTH_IN_PAIR;
  const COMPANION_OFFSET = PAIR_WIDTH * (1 - ANIMAL_WIDTH_IN_PAIR) / 2;
  viewport.style.setProperty('--pair-width', `${PAIR_WIDTH * 100}%`);
  viewport.style.setProperty('--animal-width-in-pair', `${ANIMAL_WIDTH_IN_PAIR * 100}%`);
  viewport.style.setProperty('--pair-aspect', String(1 / ANIMAL_WIDTH_IN_PAIR));
  const resting = [
    { x: .48, y: .65, pose: 'prone' },
    { x: .49, y: .62, pose: 'sit' },
    { x: .50, y: .64, pose: 'sit' },
    { x: .48, y: .69, pose: 'prone' },
  ];
  const authoredRestY = resting.map(({ y }) => y);
  const actions = [
    [{ action: 'calendar', label: '日历与记忆', x: .34, y: .20, w: .59, h: .27, target: 'blossoms' }],
    [
      { action: 'wishes', label: '许愿星', x: .53, y: .20, w: .52, h: .26, target: 'stars' },
      { action: 'reading', label: '共读', x: .68, y: .44, w: .30, h: .14, target: 'fireflies' },
      { action: 'anniversaries', label: '纪念日', x: .24, y: .89, w: .31, h: .10, target: 'flowers' },
    ],
    [{ action: 'moments', label: '朋友圈', x: .73, y: .46, w: .35, h: .14, target: 'wheat' }],
    [
      { action: 'album', label: '水獭相册', x: .48, y: .48, w: .18, h: .12, target: 'bedside-lamp', subject: 'otter' },
      { action: 'album', label: '小浣熊相册', x: .77, y: .15, w: .16, h: .13, target: 'dried-flowers', subject: 'raccoon' },
      { action: 'album', label: '小猫相册', x: .92, y: .15, w: .14, h: .18, target: 'wind-chime', subject: 'cat' },
      { action: 'voice', label: '语音', x: .79, y: .22, w: .18, h: .10, target: 'wooden-birds' },
      { action: 'upstairs', label: '二楼', x: .38, y: .135, w: .14, h: .13, target: 'red-thread' },
    ],
  ];
  let current = 0;
  let destination = null;
  let busy = false;
  let width = 0;
  let height = 0;
  let panelWidth = 0;
  let cameraY = 0;
  let activeAnimations = [];
  let ambientFrame = 0;
  let lastFrame = 0;
  let elapsed = 0;
  const scenes = [];
  const pairs = [];

  function animal(kind, pose, className = '') {
    const node = document.createElement('span');
    node.className = `animal ${className}`;
    node.dataset.animal = kind;
    node.dataset.pose = pose;
    const sprite = document.createElement('span');
    sprite.className = 'animal-sprite';
    node.append(sprite);
    return node;
  }

  for (let season = 0; season < 4; season++) {
    const scene = document.createElement('section');
    scene.className = 'season-scene';
    scene.dataset.season = seasonNames[season];
    scene.setAttribute('aria-label', seasonLabels[season]);
    scene.style.left = `${season * 25}%`;
    for (const detail of actions[season]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scene-hotspot';
      button.dataset.action = detail.action;
      button.dataset.target = detail.target;
      button.setAttribute('aria-label', detail.label);
      Object.assign(button.style, { left: `${detail.x * 100}%`, top: `${detail.y * 100}%`, width: `${detail.w * 100}%`, height: `${detail.h * 100}%` });
      button.addEventListener('click', () => {
        if (busy) return;
        const payload = { action: detail.action, season: seasonNames[season], target: detail.target };
        if (detail.subject) payload.subject = detail.subject;
        document.dispatchEvent(new CustomEvent('home:action', { detail: payload, bubbles: true, cancelable: true }));
      });
      scene.append(button);
    }
    const pair = document.createElement('button');
    pair.type = 'button';
    pair.className = 'animal-pair';
    pair.setAttribute('aria-label', `${seasonLabels[season]}的水獭和小浣熊，前往${seasonLabels[(season + 1) % 4]}`);
    pair.style.left = `${resting[season].x * 100}%`;
    pair.style.top = `${resting[season].y * 100}%`;
    pair.append(animal('otter', resting[season].pose), animal('raccoon', resting[season].pose));
    pair.addEventListener('click', () => advance(season));
    scene.append(pair);
    sceneLayer.append(scene);
    scenes.push(scene);
    pairs.push(pair);
  }

  function cameraX(season) {
    return desktopQuery.matches ? (viewport.clientWidth - width) / 2 : (viewport.clientWidth - panelWidth) / 2 - panelWidth * season;
  }
  function cameraTransform(season) {
    return `translate3d(${cameraX(season)}px, ${cameraY}px, 0)`;
  }
  function updateAccessibleScenes() {
    for (let i = 0; i < 4; i++) scenes[i].inert = busy || (!desktopQuery.matches && i !== current);
    viewport.dataset.season = seasonNames[current];
    viewport.dataset.busy = String(busy);
  }
  function layout() {
    // The artwork and every hit area share this single cover transform.
    const ratio = 24 / 13;
    const visibleRatio = desktopQuery.matches ? ratio : ratio / 4;
    height = Math.max(viewport.clientHeight, viewport.clientWidth / visibleRatio);
    width = height * ratio;
    panelWidth = width / 4;
    cameraY = (viewport.clientHeight - height) / 2;
    const visibleBottom = (viewport.clientHeight - cameraY - 44) / height;
    for (let i = 0; i < resting.length; i++) {
      resting[i].y = Math.min(authoredRestY[i], visibleBottom - panelWidth * SPRITE_WIDTH / 2 / height);
      pairs[i].style.top = `${resting[i].y * 100}%`;
    }
    const flowers = actions[1].find(({ target }) => target === 'flowers');
    scenes[1].querySelector('[data-target="flowers"]').style.top = `${Math.min(flowers.y, visibleBottom - flowers.h / 2) * 100}%`;
    world.style.width = `${width}px`;
    world.style.height = `${height}px`;
    world.style.transform = cameraTransform(current);
    // A resize ends the existing journey at its destination instead of keeping stale pixel paths.
    if (busy) {
      current = destination;
      activeAnimations.forEach(animation => animation.cancel());
      world.style.transform = cameraTransform(current);
    }
    const density = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    ctx.setTransform(density, 0, 0, density, 0, 0);
    updateAccessibleScenes();
    drawAtmosphere(elapsed);
  }
  new ResizeObserver(layout).observe(viewport);
  panorama.addEventListener('load', layout);

  function animate(node, frames, options) {
    const animation = node.animate(frames, { fill: 'both', ...options });
    activeAnimations.push(animation);
    if (document.hidden) animation.pause();
    return animation.finished.catch(() => {});
  }
  function point(season, x, y, rotation = 0, scale = 1) {
    const size = panelWidth * SPRITE_WIDTH;
    return `translate3d(${panelWidth * (season + x) - size / 2}px, ${height * y - size / 2}px, 0) rotate(${rotation}deg) scale(${scale})`;
  }
  function footprints(season, duration) {
    for (let i = 0; i < 12; i++) {
      const mark = document.createElement('i');
      mark.className = 'footprint';
      const t = i / 12;
      mark.style.left = `${(season + .43 + t * .27 + (i % 2 ? .035 : -.035)) * panelWidth}px`;
      mark.style.top = `${(resting[season].y + .015 - t * (resting[season].y - .485)) * height}px`;
      travelLayer.append(mark);
      animate(mark, [{ opacity: 0 }, { opacity: .30, offset: .1 }, { opacity: .22, offset: .65 }, { opacity: 0 }], { duration: duration * .60, delay: i * duration * .035 });
    }
  }

  async function advance(from) {
    if (busy) return;
    const to = (from + 1) % 4;
    current = from;
    destination = to;
    busy = true;
    updateAccessibleScenes();
    if (reducedMotion.matches) {
      current = to;
      busy = false;
      world.style.transform = cameraTransform(current);
      updateAccessibleScenes();
      return;
    }
    pairs[from].hidden = true;
    pairs[to].hidden = true;
    travelLayer.style.clipPath = from === 3 && desktopQuery.matches ? 'inset(0 0 0 75%)' : '';
    activeAnimations = [];
    const duration = [3800, 4100, 6200, 3900][from];
    const journeys = [];
    if (from === 2) footprints(from, duration);
    for (let index = 0; index < 2; index++) {
      const kind = index ? 'raccoon' : 'otter';
      const pose = from === 0 || from === 3 ? 'prone' : 'walk';
      const traveler = animal(kind, pose, 'traveler');
      traveler.style.width = `${panelWidth * SPRITE_WIDTH}px`;
      travelLayer.append(traveler);
      const offset = index ? COMPANION_OFFSET : -COMPANION_OFFSET;
      const start = resting[from];
      const finish = resting[to];
      const startY = start.y;
      const finishY = finish.y;
      let frames;
      if (from === 0) {
        frames = [
          { transform: point(from, start.x + offset, startY), offset: 0 },
          { transform: point(from, .66 + offset, startY - .002), offset: .24 },
          { transform: point(from, 1.02 + offset, startY), offset: .50 },
          { transform: point(to, .20 + offset, finishY - .002), offset: .75 },
          { transform: point(to, finish.x + offset, finishY), offset: 1 },
        ];
      } else if (from === 1) {
        frames = [];
        for (let step = 0; step <= 12; step++) {
          const t = step / 12;
          const x = start.x + offset + t * (1 + finish.x - start.x - .10);
          const jump = Math.abs(Math.sin(t * Math.PI * 3)) * .075;
          frames.push({ offset: t * .80, transform: point(from, x, startY + (finishY - startY) * t - jump, Math.sin(t * Math.PI * 6) * 9) });
        }
        frames.push(
          { offset: .85, transform: point(to, finish.x + offset, finishY - .065, -12) },
          { offset: .90, transform: point(to, finish.x + offset + .025, finishY + .015, 28, .92) },
          { offset: .95, transform: point(to, finish.x + offset + .01, finishY + .010, -7, .95) },
          { offset: 1, transform: point(to, finish.x + offset, finishY) },
        );
      } else if (from === 2) {
        frames = [
          { transform: point(from, start.x + offset, startY), offset: 0 },
          { transform: point(from, .55 + offset * .65, startY - .08, -3, .78), offset: .18 },
          { transform: point(from, .64 + offset * .40, startY - .17, 2, .54), offset: .34 },
          { transform: point(from, .74 + offset * .20, .37, -2, .30), offset: .48 },
          { transform: point(from, .91 + offset * .35, .49, 2, .43), offset: .60 },
          { transform: point(to, .13 + offset * .55, .64, -2, .65), offset: .75 },
          { transform: point(to, finish.x + offset, finishY, 0, 1), offset: 1 },
        ];
      } else {
        frames = [
          { transform: point(from, start.x + offset, startY), offset: 0 },
          { transform: point(from, start.x + offset, startY - .018, 0, 1.04), offset: .16 },
          { transform: point(from, .49 + offset * .85, .81, index ? 3 : -3, 1), offset: .31 },
          { transform: point(from, .49 + offset, .87, index ? 2 : -2, 1.05), offset: .45 },
          { transform: point(from, .49 + offset * 1.1, .85, index ? 3 : -3, 1.45), offset: .57 },
          { transform: point(from, .49 + offset * 1.5, startY - .04, index ? 5 : -5, 2.8), offset: .78 },
          { transform: point(from, .49 + offset * 2.1, startY - .15, index ? 6 : -6, 5.8), offset: 1 },
        ];
      }
      if (from === 3 && desktopQuery.matches) {
        frames.forEach(frame => { frame.opacity = frame.offset === 1 ? 0 : 1; });
      }
      const journey = animate(traveler, frames, { duration, delay: index * 180, easing: from === 2 ? 'linear' : 'ease-in-out' });
      journeys.push(journey);
      const row = index ? '100%' : '0%';
      const poseFrames = from === 3
        ? [[0, '0%'], [.13, '33.333333%'], [.24, '66.666667%'], [.57, '33.333333%'], [1, '33.333333%']]
        : from === 0
          ? [[0, '0%'], [.98, '33.333333%'], [1, '33.333333%']]
          : from === 2
            ? [[0, '66.666667%'], [.96, '0%'], [1, '0%']]
            : [[0, '66.666667%'], [.88, '0%'], [.96, '33.333333%'], [1, '33.333333%']];
      journeys.push(animate(traveler.firstElementChild, poseFrames.map(([offset, column]) => ({
        offset, backgroundPosition: `${column} ${row}`, easing: 'steps(1, end)',
      })), { duration, delay: index * 180 }));
      if (from === 0) {
        const rolling = document.createElement('span');
        rolling.className = 'rolling-sprite';
        traveler.append(rolling);
        const visibility = [[0, 0], [.06, 1], [.94, 0], [1, 0]];
        journeys.push(animate(rolling, visibility.map(([offset, opacity]) => ({
          offset, opacity, easing: 'steps(1, end)',
        })), { duration, delay: index * 180 }));
        journeys.push(animate(traveler.firstElementChild, visibility.map(([offset, opacity]) => ({
          offset, opacity: 1 - opacity, easing: 'steps(1, end)',
        })), { duration, delay: index * 180 }));
        // Each column is a drawn body perspective, so no flat-image rotation is needed.
        animate(rolling, [0, 20, 40, 60, 80, 100, 0].map((column, frame) => ({
          offset: frame / 6, backgroundPosition: `${column}% ${row}`, easing: 'steps(1, end)',
        })), { duration: 720, iterations: Infinity, delay: index * 180 + duration * .06 });
      }
    }
    if (from !== 3 && !desktopQuery.matches) {
      journeys.push(animate(world, [
        { transform: cameraTransform(from), offset: 0 },
        { transform: cameraTransform(from), offset: from === 2 ? .48 : .25 },
        { transform: cameraTransform(to), offset: .90 },
        { transform: cameraTransform(to), offset: 1 },
      ], { duration: duration + 180, easing: 'ease-in-out' }));
    }
    if (from === 3 && !desktopQuery.matches) {
      journeys.push(animate(veil, [{ opacity: 0 }, { opacity: 0, offset: .77 }, { opacity: 1 }], { duration: duration + 180, easing: 'ease-in' }));
    }
    await Promise.all(journeys);
    current = to;
    world.style.transform = cameraTransform(current);
    activeAnimations.forEach(animation => animation.cancel());
    activeAnimations = [];
    travelLayer.replaceChildren();
    travelLayer.style.clipPath = '';
    pairs.forEach(pair => { pair.hidden = false; });
    if (from === 3 && !desktopQuery.matches) {
      await animate(veil, [{ opacity: 1 }, { opacity: 0 }], { duration: 800, easing: 'ease-out' });
      activeAnimations.forEach(animation => animation.cancel());
      activeAnimations = [];
    } else {
      const arrival = pairs[to];
      await animate(arrival, [{ transform: 'translate(-50%, -50%) scale(1.04, .94)' }, { transform: 'translate(-50%, -50%) scale(1, 1)' }], { duration: 450, easing: 'ease-out' });
      activeAnimations.forEach(animation => animation.cancel());
      activeAnimations = [];
    }
    busy = false;
    destination = null;
    updateAccessibleScenes();
  }

  const petals = Array.from({ length: 23 }, (_, i) => ({ x: (i * .381966) % 1, y: (i * .618034) % 1, speed: .012 + (i % 5) * .002, phase: i * 1.7 }));
  const lights = Array.from({ length: 33 }, (_, i) => ({ x: .10 + ((i * .618034) % .82), y: .40 + ((i * .381966) % .49), phase: i * 2.3 }));
  const stars = Array.from({ length: 28 }, (_, i) => ({ x: .13 + ((i * .381966) % .73), y: .035 + ((i * .618034) % .38), phase: i * 1.3 }));
  function drawAtmosphere(time) {
    ctx.clearRect(0, 0, width, height);
    const visible = season => desktopQuery.matches || season === current || (busy && season === destination);
    const unit = panelWidth / 426;
    if (visible(0)) {
      for (const petal of petals) {
        const y = (petal.y + time * petal.speed) % .94;
        const x = ((petal.x + time * .011 + Math.sin(time * .55 + petal.phase) * .035) % 1) * panelWidth;
        ctx.save();
        ctx.translate(x, height * y);
        ctx.rotate(time * .7 + petal.phase);
        ctx.scale(1, .45 + Math.abs(Math.sin(time * .75 + petal.phase)) * .50);
        ctx.fillStyle = 'rgba(246,169,184,.65)';
        ctx.beginPath();
        ctx.ellipse(0, 0, (3 + petal.phase % 3) * unit, 2.4 * unit, .3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    if (visible(1)) {
      for (const star of stars) {
        const a = .22 + Math.pow((Math.sin(time * .9 + star.phase) + 1) / 2, 2) * .65;
        const x = (1 + star.x) * panelWidth;
        const y = star.y * height;
        ctx.fillStyle = `rgba(255,238,179,${a})`;
        ctx.beginPath();
        ctx.arc(x, y, 1.35 * unit, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const light of lights) {
        const x = (1 + light.x + Math.sin(time * .35 + light.phase) * .032) * panelWidth;
        const y = (light.y + Math.sin(time * .43 + light.phase * .7) * .022) * height;
        const a = .15 + (Math.sin(time * 1.2 + light.phase) + 1) * .31;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 8 * unit);
        glow.addColorStop(0, `rgba(255,244,157,${a})`);
        glow.addColorStop(.25, `rgba(255,236,126,${a * .58})`);
        glow.addColorStop(1, 'rgba(255,231,126,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x - 8 * unit, y - 8 * unit, 16 * unit, 16 * unit);
      }
    }
    if (visible(2)) {
      // A few foreground stalks move independently; the painted field remains stable.
      for (let i = 0; i < 16; i++) {
        const localX = .035 + i * .063;
        if (localX > .26 && localX < .70) continue;
        const baseX = (2 + localX) * panelWidth;
        const baseY = height * (.88 + (i % 3) * .025);
        const length = height * (.11 + (i % 4) * .017);
        const lean = Math.sin(time * .65 + i * .31) * 9 * unit + 14 * unit;
        ctx.strokeStyle = 'rgba(169,124,45,.37)';
        ctx.lineWidth = 1.2 * unit;
        ctx.beginPath();
        ctx.moveTo(baseX, baseY);
        ctx.quadraticCurveTo(baseX + lean * .25, baseY - length * .55, baseX + lean, baseY - length);
        ctx.stroke();
        for (let ear = 0; ear < 6; ear++) {
          const ey = baseY - length + ear * 4.5 * unit;
          ctx.fillStyle = 'rgba(224,177,76,.47)';
          ctx.beginPath();
          ctx.ellipse(baseX + lean + (ear % 2 ? 2.7 : -2.7) * unit, ey, 2.2 * unit, 4 * unit, ear % 2 ? .55 : -.55, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    if (visible(3)) {
      const x = 3.86 * panelWidth;
      const y = .52 * height;
      const radius = panelWidth * .25;
      const a = .10 + Math.sin(time * 3.9) * .018 + Math.sin(time * 6.7) * .012;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, `rgba(255,173,63,${a})`);
      glow.addColorStop(1, 'rgba(255,174,63,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      ctx.save();
      ctx.beginPath();
      ctx.rect(3.15 * panelWidth, height * .16, panelWidth * .25, height * .27);
      ctx.clip();
      for (let i = 0; i < 15; i++) {
        const sx = (3.15 + ((i * .618034 + Math.sin(time * .3 + i) * .01) % .25)) * panelWidth;
        const sy = (.16 + ((i * .381966 + time * .023) % .27)) * height;
        ctx.fillStyle = 'rgba(250,252,255,.66)';
        ctx.beginPath();
        ctx.arc(sx, sy, (1 + i % 2) * unit, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
  function frame(now) {
    ambientFrame = 0;
    if (document.hidden || reducedMotion.matches) return;
    if (lastFrame && now - lastFrame < 32) {
      ambientFrame = requestAnimationFrame(frame);
      return;
    }
    if (lastFrame) elapsed += Math.min((now - lastFrame) / 1000, .08);
    lastFrame = now;
    drawAtmosphere(elapsed);
    ambientFrame = requestAnimationFrame(frame);
  }
  function syncMotion() {
    document.documentElement.dataset.homeHidden = String(document.hidden);
    if (ambientFrame) cancelAnimationFrame(ambientFrame);
    ambientFrame = 0;
    lastFrame = 0;
    for (const animation of activeAnimations) {
      if (document.hidden) animation.pause();
      else animation.play();
    }
    if (!document.hidden && !reducedMotion.matches) ambientFrame = requestAnimationFrame(frame);
    else drawAtmosphere(elapsed);
  }
  document.addEventListener('visibilitychange', syncMotion);
  reducedMotion.addEventListener('change', syncMotion);
  desktopQuery.addEventListener('change', layout);
  layout();
  syncMotion();
})();
