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
  const adjusting = new URLSearchParams(location.search).get('adjust') === '1';
  const isDesktop = () => desktopQuery.matches && !viewport.classList.contains('editor-phone');
  const seasonNames = ['spring', 'summer', 'autumn', 'winter'];
  const seasonLabels = ['春天', '夏天', '秋天', '冬天'];
  const PAIR_WIDTH = .82;
  const ANIMAL_WIDTH_IN_PAIR = .55;
  const SPRITE_WIDTH = PAIR_WIDTH * ANIMAL_WIDTH_IN_PAIR;
  const COMPANION_OFFSET = PAIR_WIDTH * (1 - ANIMAL_WIDTH_IN_PAIR) / 2;
  const FOOT_ANCHOR = .88;
  // Each sheet has different transparent padding; visible paws share one ground anchor.
  const POSE_FEET = {
    otter: { prone: .845, sit: .876, awake: .786284, frontSit: .840510 },
    raccoon: { prone: .797, sit: .840, awake: .773525, frontSit: .818182 },
  };
  const WALK_FEET = {
    otter: [.745856, .745856, .748619, .751381, .751381, .754144],
    raccoon: [.743094, .740331, .743094, .740331, .743094, .743094],
  };
  const ROLLING_FEET = {
    otter: [.740, .760, .765, .762, .738, .762],
    raccoon: [.735, .738, .751, .754, .738, .746],
  };
  const POSE_SHEETS = {
    prone: { image: '/home/assets/seasons/characters.png', columns: 4, column: 0 },
    sit: { image: '/home/assets/seasons/characters.png', columns: 4, column: 1 },
    awake: { image: '/home/assets/seasons/season-poses.png', columns: 2, column: 0 },
    frontSit: { image: '/home/assets/seasons/season-poses.png', columns: 2, column: 1 },
    walk: { image: '/home/assets/seasons/walk-cycle.png', columns: 6 },
  };
  const AUTUMN_PATH = [
    { x: .08, y: .465, offset: .30, scale: .27 },
    { x: .30, y: .445, offset: .42, scale: .25 },
    { x: .48, y: .420, offset: .53, scale: .23 },
    { x: .55, y: .410, offset: .60, scale: .21 },
    { x: .47, y: .395, offset: .67, scale: .19 },
    { x: .36, y: .382, offset: .75, scale: .17 },
    { x: .46, y: .370, offset: .83, scale: .15 },
    { x: .59, y: .355, offset: .91, scale: .13 },
  ];
  viewport.style.setProperty('--pair-width', `${PAIR_WIDTH * 100}%`);
  viewport.style.setProperty('--animal-width-in-pair', `${ANIMAL_WIDTH_IN_PAIR * 100}%`);
  viewport.style.setProperty('--pair-aspect', String(1 / ANIMAL_WIDTH_IN_PAIR));
  const resting = [
    { x: .50, groundY: .77, pose: 'awake', groundOffsets: [0, 0], xOffsets: [.065, -.035], bodySizes: [1.05, 1], rotations: [0, 0], frontAnimal: 'otter' },
    { x: .58, groundY: .86, pose: 'sit', groundOffsets: [0, -.012], xOffsets: [0, 0], bodySizes: [1.05, 1], rotations: [0, 0], frontAnimal: 'raccoon' },
    { x: .44, groundY: .84, pose: 'frontSit', groundOffsets: [0, 0], xOffsets: [0, 0], bodySizes: [1.06, 1], rotations: [0, 0], frontAnimal: 'raccoon' },
    { x: .53, groundY: .83, pose: 'prone', groundOffsets: [0, 0], xOffsets: [0, 0], bodySizes: [1, 1], rotations: [0, 0], frontAnimal: 'raccoon' },
  ];
  const actions = [
    [{ action: 'calendar', label: '日历与记忆', x: .34, y: .20, w: .59, h: .27, target: 'blossoms' }],
    [
      { action: 'wishes', label: '许愿星', x: .53, y: .20, w: .52, h: .26, target: 'stars' },
      { action: 'reading', label: '共读', x: .68, y: .44, w: .30, h: .14, target: 'fireflies' },
      { action: 'anniversaries', label: '纪念日', x: .24, y: .89, w: .31, h: .10, target: 'flowers' },
    ],
    [{ action: 'moments', label: '朋友圈', x: .73, y: .46, w: .35, h: .14, target: 'wheat' }],
    [
      { action: 'album', label: '水獭相册', x: .42, y: .49, w: .18, h: .12, target: 'bedside-lamp', subject: 'otter' },
      { action: 'album', label: '小浣熊相册', x: .77, y: .15, w: .16, h: .13, target: 'dried-flowers', subject: 'raccoon' },
      { action: 'album', label: '小猫相册', x: .92, y: .15, w: .14, h: .18, target: 'wind-chime', subject: 'cat' },
      { action: 'voice', label: '语音', x: .79, y: .22, w: .18, h: .10, target: 'wooden-birds' },
      { action: 'upstairs', label: '二楼', x: .27, y: .17, w: .14, h: .13, target: 'red-thread' },
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

  function poseStyle(kind, pose, frame = 0) {
    const sheet = POSE_SHEETS[pose];
    const column = pose === 'walk' ? frame : sheet.column;
    const foot = pose === 'walk' ? WALK_FEET[kind][frame] : POSE_FEET[kind][pose];
    return {
      backgroundImage: `url('${sheet.image}')`,
      backgroundSize: `${sheet.columns * 100}% 200%`,
      backgroundPosition: `${column * 100 / (sheet.columns - 1)}% ${kind === 'raccoon' ? '100%' : '0%'}`,
      translate: `0 ${(FOOT_ANCHOR - foot) * 100}%`,
      transformOrigin: `50% ${foot * 100}%`,
    };
  }
  function animal(kind, pose, className = '', bodySize = 1) {
    const node = document.createElement('span');
    node.className = `animal ${className}`;
    node.dataset.animal = kind;
    node.dataset.pose = pose;
    const size = document.createElement('span');
    size.className = 'animal-size';
    size.style.transform = `scale(${bodySize})`;
    const sprite = document.createElement('span');
    sprite.className = 'animal-sprite';
    Object.assign(sprite.style, poseStyle(kind, pose));
    size.append(sprite);
    node.append(size);
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
        if (busy || adjusting) return;
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
    pair.append(animal('otter', resting[season].pose, '', resting[season].bodySizes[0]), animal('raccoon', resting[season].pose, '', resting[season].bodySizes[1]));
    pair.addEventListener('click', () => advance(season));
    scene.append(pair);
    sceneLayer.append(scene);
    scenes.push(scene);
    pairs.push(pair);
  }

  function cameraX(season) {
    return isDesktop() ? (viewport.clientWidth - width) / 2 : (viewport.clientWidth - panelWidth) / 2 - panelWidth * season;
  }
  function cameraTransform(season) {
    return `translate3d(${cameraX(season)}px, ${cameraY}px, 0)`;
  }
  function updateAccessibleScenes() {
    for (let i = 0; i < 4; i++) scenes[i].inert = busy || (!isDesktop() && i !== current);
    viewport.dataset.season = seasonNames[current];
    viewport.dataset.busy = String(busy);
  }
  function layout() {
    // The artwork and every hit area share this single cover transform.
    const ratio = 24 / 13;
    const visibleRatio = isDesktop() ? ratio : ratio / 4;
    height = Math.max(viewport.clientHeight, viewport.clientWidth / visibleRatio);
    width = height * ratio;
    panelWidth = width / 4;
    cameraY = (viewport.clientHeight - height) / 2;
    const visibleBottom = (viewport.clientHeight - cameraY - 44) / height;
    for (let i = 0; i < resting.length; i++) {
      const spriteSize = panelWidth * SPRITE_WIDTH;
      const centerY = resting[i].groundY - (FOOT_ANCHOR - .5) * spriteSize / height;
      resting[i].y = Math.min(centerY, visibleBottom - spriteSize / 2 / height);
      pairs[i].style.top = `${resting[i].y * 100}%`;
      pairs[i].style.left = `${resting[i].x * 100}%`;
      for (let animalIndex = 0; animalIndex < 2; animalIndex++) {
        const actor = pairs[i].children[animalIndex];
        actor.style.top = `${resting[i].groundOffsets[animalIndex] * height}px`;
        actor.style.left = `${((animalIndex ? COMPANION_OFFSET * 2 : 0) + resting[i].xOffsets[animalIndex]) * panelWidth}px`;
        actor.style.right = 'auto';
        const size = actor.querySelector('.animal-size');
        size.style.transform = `scale(${resting[i].bodySizes[animalIndex]})`;
        size.style.rotate = `${resting[i].rotations[animalIndex]}deg`;
        actor.style.zIndex = actor.dataset.animal === resting[i].frontAnimal ? '1' : '0';
      }
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
  function groundPoint(season, x, groundY, scale = 1) {
    const footRise = (FOOT_ANCHOR - .5) * panelWidth * SPRITE_WIDTH * scale / height;
    return point(season, x, groundY - footRise, 0, scale);
  }
  function footprints(season, duration) {
    for (let segment = 0; segment < AUTUMN_PATH.length - 1; segment++) {
      const from = AUTUMN_PATH[segment];
      const to = AUTUMN_PATH[segment + 1];
      const angle = Math.atan2((to.y - from.y) * height, (to.x - from.x) * panelWidth) * 180 / Math.PI;
      for (const progress of [.25, .75]) {
        const mark = document.createElement('i');
        mark.className = 'footprint';
        const scale = from.scale + (to.scale - from.scale) * progress;
        const offset = from.offset + (to.offset - from.offset) * progress;
        mark.style.left = `${(season + from.x + (to.x - from.x) * progress) * panelWidth}px`;
        mark.style.top = `${(from.y + (to.y - from.y) * progress) * height}px`;
        mark.style.transform = `translate(-50%, -50%) rotate(${angle}deg) scale(${scale})`;
        travelLayer.append(mark);
        animate(mark, [{ opacity: 0 }, { opacity: .30, offset: .1 }, { opacity: .22, offset: .65 }, { opacity: 0 }], { duration: duration * .45, delay: duration * offset });
      }
    }
  }

  function playCycle(node, kind, mode, start, end, duration, delay) {
    const size = node.querySelector('.animal-size');
    const sprite = size.querySelector('.animal-sprite');
    const layer = document.createElement('span');
    layer.className = `animal-cycle ${mode === 'roll' ? 'rolling-sprite' : 'walking-sprite'}`;
    size.append(layer);
    const visibility = [[0, 0], [start, 1], [end, 0], [1, 0]];
    const finished = Promise.all([
      animate(layer, visibility.map(([offset, opacity]) => ({ offset, opacity, easing: 'steps(1, end)' })), { duration, delay }),
      animate(sprite, visibility.map(([offset, opacity]) => ({ offset, opacity: 1 - opacity, easing: 'steps(1, end)' })), { duration, delay }),
    ]);
    const frames = [0, 1, 2, 3, 4, 5, 0].map((frame, index) => {
      if (mode === 'walk') return { offset: index / 6, ...poseStyle(kind, 'walk', frame), easing: 'steps(1, end)' };
      const shift = FOOT_ANCHOR - (.75 + (ROLLING_FEET[kind][frame] - .75) * .93);
      return {
        offset: index / 6,
        backgroundImage: "url('/home/assets/seasons/rolling.png')",
        backgroundSize: '600% 200%',
        backgroundPosition: `${frame * 20}% ${kind === 'raccoon' ? '100%' : '0%'}`,
        transform: `translateY(${shift * 100}%) scale(.93)`,
        transformOrigin: '50% 75%', easing: 'steps(1, end)',
      };
    });
    animate(layer, frames, { duration: mode === 'roll' ? 720 : 700, iterations: Infinity, delay: delay + duration * start });
    return { layer, finished };
  }

  async function advance(from) {
    if (busy || adjusting) return;
    const to = (from + 1) % 4;
    current = from;
    destination = to;
    busy = true;
    updateAccessibleScenes();
    if (reducedMotion.matches) {
      pairs[from].hidden = true;
      pairs[to].hidden = false;
      current = to;
      destination = null;
      busy = false;
      world.style.transform = cameraTransform(current);
      updateAccessibleScenes();
      return;
    }
    pairs[from].hidden = true;
    pairs[to].hidden = true;
    travelLayer.dataset.journey = seasonNames[from];
    travelLayer.style.clipPath = from === 3 && isDesktop() ? 'inset(0 0 0 75%)' : '';
    activeAnimations = [];
    const duration = [4200, 5200, 8800, 3300][from];
    const journeys = [];
    let revealVeil = false;

    if (from === 3) {
      // Both sleeping animals remain one composition throughout the close-up.
      const group = pairs[from].cloneNode(true);
      group.hidden = false;
      group.tabIndex = -1;
      group.removeAttribute('aria-label');
      group.classList.add('winter-zoom');
      const centerX = (from + resting[from].x) * panelWidth;
      const centerY = resting[from].y * height;
      const moveX = (from + .5) * panelWidth - centerX;
      const moveY = viewport.clientHeight * .60 - cameraY - centerY;
      group.style.left = `${centerX}px`;
      group.style.top = `${centerY}px`;
      group.style.width = `${PAIR_WIDTH * panelWidth}px`;
      travelLayer.append(group);
      journeys.push(animate(group, [
        { offset: 0, transform: 'translate(-50%, -50%) translate3d(0, 0, 0) scale(1)', opacity: 1 },
        { offset: .42, transform: `translate(-50%, -50%) translate3d(${moveX * .4}px, ${moveY * .4}px, 0) scale(1.7)`, opacity: 1 },
        { offset: .80, transform: `translate(-50%, -50%) translate3d(${moveX * .8}px, ${moveY * .8}px, 0) scale(3.2)`, opacity: 1 },
        { offset: 1, transform: `translate(-50%, -50%) translate3d(${moveX}px, ${moveY}px, 0) scale(4)`, opacity: isDesktop() ? 0 : 1 },
      ], { duration, easing: 'ease-in-out' }));
      if (!isDesktop()) {
        revealVeil = true;
        journeys.push(animate(veil, [{ opacity: 0 }, { opacity: 0, offset: .76 }, { opacity: 1 }], { duration, easing: 'ease-in' }));
      }
    } else {
      if (from === 2) footprints(from, duration);
      for (let index = 0; index < 2; index++) {
        const kind = index ? 'raccoon' : 'otter';
        const start = resting[from];
        const finish = resting[to];
        const traveler = animal(kind, start.pose, 'traveler', start.bodySizes[index]);
        traveler.style.width = `${panelWidth * SPRITE_WIDTH}px`;
        traveler.style.zIndex = kind === start.frontAnimal ? '1' : '0';
        travelLayer.append(traveler);
        const size = traveler.querySelector('.animal-size');
        const sprite = traveler.querySelector('.animal-sprite');
        const offset = index ? COMPANION_OFFSET : -COMPANION_OFFSET;
        const startOffset = offset + start.xOffsets[index];
        const finishOffset = offset + finish.xOffsets[index];
        const delay = index * 180;
        const startY = start.y + start.groundOffsets[index];
        const finishY = finish.y + finish.groundOffsets[index];
        const footRise = (FOOT_ANCHOR - .5) * panelWidth * SPRITE_WIDTH / height;
        const startGround = startY + footRise;
        const finishGround = finishY + footRise;
        let frames;
        let poses;
        let cycle;
        if (from === 0) {
          frames = [
            { offset: 0, transform: point(from, start.x + startOffset, startY) },
            { offset: .24, transform: groundPoint(from, .72 + offset, startGround + (finishGround - startGround) * .24) },
            { offset: .50, transform: groundPoint(from, 1.02 + offset, startGround + (finishGround - startGround) * .50) },
            { offset: .76, transform: groundPoint(to, .20 + offset, startGround + (finishGround - startGround) * .80) },
            { offset: .96, transform: point(to, finish.x + finishOffset, finishY) },
            { offset: 1, transform: point(to, finish.x + finishOffset, finishY) },
          ];
          poses = [[0, 'awake'], [.92, 'sit'], [1, 'sit']];
          cycle = playCycle(traveler, kind, 'roll', .06, .92, duration, delay);
        } else if (from === 1) {
          frames = [
            { offset: 0, transform: point(from, start.x + startOffset, startY) },
            { offset: .12, transform: point(from, start.x + startOffset, startY) },
            { offset: .43, transform: groundPoint(from, .93 + offset, startGround + (finishGround - startGround) * .40) },
            { offset: .72, transform: groundPoint(to, .17 + offset, startGround + (finishGround - startGround) * .75) },
            { offset: .94, transform: point(to, finish.x + finishOffset, finishY) },
            { offset: 1, transform: point(to, finish.x + finishOffset, finishY) },
          ];
          poses = [[0, 'sit'], [.94, 'frontSit'], [1, 'frontSit']];
          cycle = playCycle(traveler, kind, 'walk', .10, .94, duration, delay);
        } else {
          frames = [
            { offset: 0, transform: point(from, start.x + startOffset, startY), opacity: 1 },
            { offset: .04, transform: point(from, start.x + startOffset, startY), opacity: 1 },
            { offset: .15, transform: groundPoint(from, .16 + offset * .35, .64, .55), opacity: 1 },
            ...AUTUMN_PATH.map(stop => ({ offset: stop.offset, transform: groundPoint(from, stop.x, stop.y, stop.scale), opacity: 1 })),
            { offset: .96, transform: groundPoint(from, .59, .355, .10), opacity: 0 },
            { offset: 1, transform: groundPoint(from, .59, .355, .10), opacity: 0 },
          ];
          poses = [[0, 'frontSit'], [1, 'frontSit']];
          cycle = playCycle(traveler, kind, 'walk', .04, .98, duration, delay);
          journeys.push(animate(cycle.layer, [
            { offset: 0, scale: '-1 1', easing: 'steps(1, end)' },
            { offset: .30, scale: '1 1', easing: 'steps(1, end)' },
            { offset: .60, scale: '-1 1', easing: 'steps(1, end)' },
            { offset: .75, scale: '1 1', easing: 'steps(1, end)' },
            { offset: 1, scale: '1 1' },
          ], { duration, delay }));
        }
        journeys.push(cycle.finished);
        journeys.push(animate(traveler, frames, { duration, delay, easing: from === 0 ? 'ease-in-out' : 'linear' }));
        journeys.push(animate(sprite, poses.map(([offset, pose]) => ({ offset, ...poseStyle(kind, pose), easing: 'steps(1, end)' })), { duration, delay }));
        const finalSize = from === 2 ? start.bodySizes[index] : finish.bodySizes[index];
        const finalRotation = from === 2 ? 0 : finish.rotations[index];
        journeys.push(animate(size, [
          { offset: 0, rotate: `${start.rotations[index]}deg` },
          { offset: .12, rotate: '0deg' },
          { offset: .88, rotate: '0deg' },
          { offset: 1, rotate: `${finalRotation}deg` },
        ], { duration, delay, easing: 'ease-in-out' }));
        journeys.push(animate(size, [{ transform: `scale(${start.bodySizes[index]})` }, { transform: `scale(${finalSize})` }], { duration, delay, easing: 'ease-in-out' }));
      }
      if (from < 2 && !isDesktop()) {
        journeys.push(animate(world, [
          { transform: cameraTransform(from), offset: 0 },
          { transform: cameraTransform(from), offset: .25 },
          { transform: cameraTransform(to), offset: .90 },
          { transform: cameraTransform(to), offset: 1 },
        ], { duration: duration + 180, easing: 'ease-in-out' }));
      }
    }

    await Promise.all(journeys);
    if (from === 2 && !isDesktop() && current === from) {
      // The doorway grows only after both animals have disappeared inside it.
      const door = AUTUMN_PATH[AUTUMN_PATH.length - 1];
      const zoom = 2.6;
      const x = viewport.clientWidth / 2 - (from + door.x) * panelWidth * zoom;
      const y = viewport.clientHeight * .52 - door.y * height * zoom;
      revealVeil = true;
      await Promise.all([
        animate(world, [{ transform: cameraTransform(from) }, { transform: `translate3d(${x}px, ${y}px, 0) scale(${zoom})` }], { duration: 1100, easing: 'ease-in-out' }),
        animate(veil, [{ opacity: 0 }, { opacity: 0, offset: .35 }, { opacity: 1 }], { duration: 1100, easing: 'ease-in' }),
      ]);
    }
    if (current !== from) revealVeil = false;
    current = to;
    world.style.transform = cameraTransform(current);
    activeAnimations.forEach(animation => animation.cancel());
    activeAnimations = [];
    travelLayer.replaceChildren();
    travelLayer.style.clipPath = '';
    delete travelLayer.dataset.journey;
    pairs[to].hidden = false;
    if (revealVeil) {
      await animate(veil, [{ opacity: 1 }, { opacity: 0 }], { duration: 650, easing: 'ease-out' });
    } else if (from === 2 || from === 3) {
      await animate(pairs[to], [{ opacity: 0 }, { opacity: 1 }], { duration: 650, easing: 'ease-out' });
    } else {
      await animate(pairs[to], [{ transform: 'translate(-50%, -50%) scale(1, .985)' }, { transform: 'translate(-50%, -50%) scale(1, 1)' }], { duration: 260, easing: 'ease-out' });
    }
    activeAnimations.forEach(animation => animation.cancel());
    activeAnimations = [];
    busy = false;
    destination = null;
    updateAccessibleScenes();
  }

  if (adjusting) {
    viewport.dataset.adjusting = 'true';
    // This API exists only in the temporary editor; normal visits use the committed layout.
    window.estomagoPositionEditor = {
      read: () => resting.map(({ x, groundY, groundOffsets, xOffsets, bodySizes, rotations, frontAnimal }) => ({
        x, groundY, groundOffsets: [...groundOffsets], xOffsets: [...xOffsets], bodySizes: [...bodySizes],
        rotations: [...rotations], frontAnimal,
      })),
      update(configs) {
        configs.forEach((config, index) => Object.assign(resting[index], config));
        layout();
      },
      select(season) {
        current = season;
        pairs.forEach(pair => { pair.hidden = false; });
        world.style.transform = cameraTransform(current);
        updateAccessibleScenes();
      },
      preview(mode) {
        viewport.classList.toggle('editor-phone', mode === 'phone');
        layout();
      },
      dimensions: () => ({ panelWidth, height }),
    };
  }

  const petals = Array.from({ length: 23 }, (_, i) => ({ x: (i * .381966) % 1, y: (i * .618034) % 1, speed: .012 + (i % 5) * .002, phase: i * 1.7 }));
  const lights = Array.from({ length: 33 }, (_, i) => ({ x: .10 + ((i * .618034) % .82), y: .40 + ((i * .381966) % .49), phase: i * 2.3 }));
  const stars = Array.from({ length: 28 }, (_, i) => ({ x: .13 + ((i * .381966) % .73), y: .035 + ((i * .618034) % .38), phase: i * 1.3 }));
  function drawAtmosphere(time) {
    ctx.clearRect(0, 0, width, height);
    const visible = season => isDesktop() || season === current || (busy && season === destination);
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
      ctx.rect(3.04 * panelWidth, height * .22, panelWidth * .25, height * .27);
      ctx.clip();
      for (let i = 0; i < 15; i++) {
        const sx = (3.04 + ((i * .618034 + Math.sin(time * .3 + i) * .01) % .25)) * panelWidth;
        const sy = (.22 + ((i * .381966 + time * .023) % .27)) * height;
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
