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
  const pageParams = new URLSearchParams(location.search);
  if (pageParams.get('preview') === 'phone') viewport.classList.add('editor-phone');
  const adjusting = pageParams.get('adjust') === '1';
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
    otter: { prone: .845, sit: .876, awake: .786284, peek: .850056 },
    raccoon: { prone: .797, sit: .840, awake: .773525, peek: .841037 },
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
    peek: { image: '/home/assets/seasons/autumn-peek.png', columns: 1, column: 0 },
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
    {"x": 0.4933, "groundY": 0.7754, "groundOffsets": [0.026, 0.0167], "xOffsets": [0.2673, -0.3213], "bodySizes": [1.2495, 1.31], "rotations": [0, 11], "frontAnimal": "raccoon", "pose": "awake"},
    {"x": 0.4552, "groundY": 0.8608, "groundOffsets": [-0.117, -0.0817], "xOffsets": [0.1209, 0.006], "bodySizes": [1.0815, 1.03], "rotations": [0, 0], "frontAnimal": "raccoon", "pose": "sit"},
    {"x": 0.5, "groundY": 0.72, "groundOffsets": [0, 0.018], "xOffsets": [0.015, -0.015], "bodySizes": [1.06, 1], "rotations": [0, 0], "frontAnimal": "raccoon", "pose": "peek"},
    {"x": 0.53, "groundY": 0.83, "groundOffsets": [-0.0982, -0.0947], "xOffsets": [0.0036, -0.0551], "bodySizes": [0.93, 0.89], "rotations": [0, 0], "frontAnimal": "raccoon", "pose": "prone"},
  ];
  const actions = [
    [
      { action: 'calendar', label: '日历与记忆', x: .50, y: .24, w: .96, h: .46, target: 'blossoms' },
      { action: 'chat', label: '樱花图标，进入聊天', x: .16, y: .50, w: .32, h: .92, target: 'signature-chat', signature: true },
      { action: 'calendar', label: 'mariposa en el estomago，进入日历', x: .665, y: .50, w: .67, h: .92, target: 'signature-calendar', signature: true },
    ],
    [
      { action: 'wishes', label: '许愿星', x: (783 - 426.5) / 426.5, y: 23 / 922, guide: 'star', target: 'stars' },
      { action: 'album', label: '相册', x: (692 - 426.5) / 426.5, y: 782 / 922, guide: 'firefly', target: 'fireflies' },
      { action: 'anniversaries', label: '纪念日', x: .24, y: .89, w: .31, h: .10, target: 'flowers' },
    ],
    [{ action: 'moments', label: '朋友圈', x: (1231 - 853) / 426.5, y: 150 / 922, point: true, target: 'maple-leaf' }],
    [
      { action: 'reading', label: '共读', x: (1563 - 1279.5) / 426.5, y: .31, w: .14, h: .22, target: 'bookshelf' },
      { action: 'voice', label: '语音深听', x: (1412 - 1279.5) / 426.5, y: 292 / 922, w: 124 / 426.5, h: 124 / 922, target: 'snow-window' },
      { action: 'upstairs', label: '二楼', x: .41, y: .17, w: .14, h: .13, target: 'red-thread' },
    ],
  ];
  const requestedSeason = seasonNames.indexOf(pageParams.get('season'));
  let current = requestedSeason < 0 ? 0 : requestedSeason;
  let destination = null;
  let busy = false;
  let width = 0;
  let height = 0;
  let panelWidth = 0;
  let cameraY = 0;
  let activeAnimations = [];
  let windowTransition = null;
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
      backgroundPosition: `${sheet.columns === 1 ? 0 : column * 100 / (sheet.columns - 1)}% ${kind === 'raccoon' ? '100%' : '0%'}`,
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
    const signature = season === 0 ? document.createElement('nav') : null;
    if (signature) {
      signature.className = 'spring-signature';
      signature.setAttribute('aria-label', '春天水彩导航');
      const image = document.createElement('img');
      image.src = '/home/assets/seasons/spring-mariposa-signature.png';
      image.alt = '';
      image.width = 2172;
      image.height = 724;
      image.draggable = false;
      signature.append(image);
      scene.append(signature);
    }
    for (const detail of actions[season]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = detail.guide ? 'scene-hotspot guide-hotspot' : detail.point ? 'scene-hotspot point-hotspot' : 'scene-hotspot';
      if (detail.guide) button.dataset.guide = detail.guide;
      button.dataset.action = detail.action;
      button.dataset.target = detail.target;
      button.setAttribute('aria-label', detail.label);
      Object.assign(button.style, { left: `${detail.x * 100}%`, top: `${detail.y * 100}%`, width: (detail.guide || detail.point) ? '44px' : `${detail.w * 100}%`, height: (detail.guide || detail.point) ? '44px' : `${detail.h * 100}%` });
      button.addEventListener('click', () => {
        if (busy || adjusting) return;
        const payload = { action: detail.action, season: seasonNames[season], target: detail.target };
        if (detail.subject) payload.subject = detail.subject;
        document.dispatchEvent(new CustomEvent('home:action', { detail: payload, bubbles: true, cancelable: true }));
      });
      (detail.signature ? signature : scene).append(button);
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
      windowTransition?.remove();
      windowTransition = null;
      pairs[current].hidden = false;
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
    pairs[from].hidden = from !== 3;
    pairs[to].hidden = true;
    travelLayer.dataset.journey = seasonNames[from];
    activeAnimations = [];
    const duration = [4200, 5200, 8800, 5200][from];
    const journeys = [];
    let revealVeil = false;

    if (from === 3) {
      const portal = document.createElement('div');
      portal.id = 'window-transition';
      portal.setAttribute('aria-hidden', 'true');
      portal.inert = true;
      const outside = document.createElement('div');
      outside.className = 'window-spring-world';
      Object.assign(outside.style, { width: `${width}px`, height: `${height}px`, transform: cameraTransform(0) });
      const painting = panorama.cloneNode();
      painting.removeAttribute('id');
      painting.className = 'window-panorama';
      const springScenes = sceneLayer.cloneNode(true);
      springScenes.removeAttribute('id');
      springScenes.className = 'window-scene-layer';
      springScenes.querySelectorAll('.scene-hotspot').forEach(node => node.remove());
      springScenes.querySelectorAll('.animal-pair').forEach((pair, index) => {
        pair.hidden = index === 0 ? false : index === 3 ? true : pairs[index].hidden;
        pair.tabIndex = -1;
      });
      outside.append(painting, springScenes);
      for (const id of ['field-foreground', 'bedding-foreground']) {
        const foreground = document.getElementById(id).cloneNode(true);
        foreground.removeAttribute('id');
        foreground.querySelector('defs').remove();
        foreground.style.zIndex = id === 'field-foreground' ? '5' : '3';
        outside.append(foreground);
      }
      portal.append(outside);
      viewport.append(portal);
      windowTransition = portal;

      // The six clear panes preserve the painted curtain, snow sill and mullions as foreground.
      const panes = [
        [[1382, 126], [1405, 131], [1408, 212], [1360, 209]],
        [[1420, 136], [1475, 145], [1478, 221], [1421, 215]],
        [[1352, 231], [1407, 236], [1408, 304], [1353, 302]],
        [[1421, 241], [1477, 248], [1479, 309], [1421, 307]],
        [[1353, 324], [1408, 327], [1409, 421], [1353, 417]],
        [[1422, 332], [1480, 333], [1481, 424], [1423, 425]],
      ];
      const focus = { x: width * 1380 / 1706, y: height * 267 / 922 };
      const through = Math.max(viewport.clientWidth / (width * 48 / 1706), viewport.clientHeight / (height * 58 / 922)) * 1.18;
      const cameras = [
        { offset: 0, scale: 1, x: cameraX(from), y: cameraY, easing: 'ease-in-out' },
        ...Array.from({ length: 11 }, (_, index) => {
          const progress = index / 10;
          const scale = 2.15 * (through / 2.15) ** progress;
          return { offset: .26 + .50 * progress, scale, x: viewport.clientWidth / 2 - focus.x * scale, y: viewport.clientHeight / 2 - focus.y * scale, easing: index === 10 ? 'ease-in-out' : 'linear' };
        }),
        { offset: 1, scale: through, x: viewport.clientWidth / 2 - focus.x * through, y: viewport.clientHeight / 2 - focus.y * through },
      ];
      const easing = 'linear';
      journeys.push(animate(world, cameras.map(camera => ({
        offset: camera.offset, easing: camera.easing, transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})`,
        filter: camera.offset >= .72 ? 'blur(1.2px)' : 'blur(0px)',
      })), { duration, easing }));
      journeys.push(animate(portal, cameras.map(camera => ({
        offset: camera.offset, easing: camera.easing,
        clipPath: `path("${panes.map(pane => pane.map(([x, y], index) => `${index ? 'L' : 'M'}${camera.x + x / 1706 * width * camera.scale} ${camera.y + y / 922 * height * camera.scale}`).join(' ') + ' Z').join(' ')}")`,
      })), { duration, easing }));
      journeys.push(animate(portal, [{ opacity: 0 }, { offset: .22, opacity: 0 }, { offset: .46, opacity: 1 }, { opacity: 1 }], { duration, easing: 'ease-in-out' }));
      journeys.push(animate(outside, cameras.map(camera => {
        const left = Math.max(0, camera.x + 1352 / 1706 * width * camera.scale);
        const right = Math.min(viewport.clientWidth, camera.x + 1481 / 1706 * width * camera.scale);
        const top = Math.max(0, camera.y + 126 / 922 * height * camera.scale);
        const bottom = Math.min(viewport.clientHeight, camera.y + 425 / 922 * height * camera.scale);
        const scale = Math.max((right - left) / panelWidth, (bottom - top) / height) * 1.1;
        const x = (left + right) / 2 - panelWidth * .5 * scale;
        const y = (top + bottom) / 2 - height * .5 * scale;
        return {
          offset: camera.offset, easing: camera.easing,
          transform: camera.offset === 1 ? cameraTransform(0) : `translate3d(${x}px, ${y}px, 0) scale(${scale})`,
          filter: camera.offset === 0 ? 'blur(1px)' : 'blur(0px)',
        };
      }), { duration, easing }));
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
          const startX = start.x + startOffset;
          const distance = 1 + finish.x + finishOffset - startX;
          frames = [0, .24, .50, .76, .96, 1].map(offset => {
            const progress = Math.min(offset / .96, 1);
            const lane = Math.sin(progress * Math.PI) * (index ? .025 : -.025);
            return { offset, transform: groundPoint(from, startX + distance * progress, startGround + (finishGround - startGround) * progress + lane) };
          });
          poses = [[0, start.pose], [.92, finish.pose], [1, finish.pose]];
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
          poses = [[0, start.pose], [.94, finish.pose], [1, finish.pose]];
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
          poses = [[0, start.pose], [1, start.pose]];
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
    pairs[from].hidden = true;
    pairs[to].hidden = false;
    world.style.transform = cameraTransform(current);
    activeAnimations.forEach(animation => animation.cancel());
    activeAnimations = [];
    travelLayer.replaceChildren();
    delete travelLayer.dataset.journey;
    if (windowTransition) {
      await animate(windowTransition, [{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: 'ease-out' });
      windowTransition?.remove();
      windowTransition = null;
    } else if (revealVeil) {
      await animate(veil, [{ opacity: 1 }, { opacity: 0 }], { duration: 650, easing: 'ease-out' });
    } else if (from === 2) {
      await animate(pairs[to], [{ opacity: 0 }, { opacity: 1 }], { duration: 650, easing: 'ease-out' });
    } else if (from !== 3) {
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
  const lights = Array.from({ length: 33 }, (_, i) => ({ x: .10 + ((i * .618034) % .82), y: .40 + ((i * .381966) % .37), phase: i * 2.3 }));
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
      const x = 3.98 * panelWidth;
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
      ctx.rect(3.19 * panelWidth, height * .22, panelWidth * .25, height * .27);
      ctx.clip();
      for (let i = 0; i < 15; i++) {
        const sx = (3.19 + ((i * .618034 + Math.sin(time * .3 + i) * .01) % .25)) * panelWidth;
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
