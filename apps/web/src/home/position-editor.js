(() => {
  'use strict';
  const api = window.estomagoPositionEditor;
  if (!api) return;
  const storageKey = 'estomago-position-draft-v1';
  const names = ['spring', 'summer', 'autumn', 'winter'];
  const labels = ['春天', '夏天', '秋天', '冬天'];
  const defaults = api.read();
  let positions = structuredClone(defaults);
  let season = 0;
  let target = 'together';
  let preview = 'phone';
  let savedMessage = '拖动小动物，调整后点“保存位置”。';
  const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey));
    if (stored) {
      const valid = stored.version === 1 && Array.isArray(stored.seasons) && stored.seasons.length === 4 && stored.seasons.every(item =>
        item && inRange(item.x, .05, .95) && inRange(item.groundY, .15, .95) &&
        ['groundOffsets', 'xOffsets', 'bodySizes'].every(key => Array.isArray(item[key]) && item[key].length === 2 &&
          item[key].every(value => inRange(value, key === 'bodySizes' ? .5 : -.4, key === 'bodySizes' ? 1.7 : .4))));
      if (valid) {
        positions = stored.seasons.map(({ x, groundY, groundOffsets, xOffsets, bodySizes }) => ({ x, groundY, groundOffsets, xOffsets, bodySizes }));
        savedMessage = '已恢复这个浏览器中保存的位置。';
      } else savedMessage = '旧的位置格式不适用，已显示当前主页位置。';
    }
  } catch { savedMessage = '未能读取本地草稿，可以调整后复制位置。'; }
  const panel = document.createElement('aside');
  panel.id = 'position-editor';
  panel.setAttribute('aria-label', '小动物位置调整');
  panel.innerHTML = `
    <header><strong>摆一摆小动物</strong><button type="button" id="position-fold" aria-expanded="true">收起</button></header>
    <div id="position-controls">
      <div class="position-row" aria-label="预览画面"><button type="button" data-preview="phone" aria-pressed="true">手机</button><button type="button" data-preview="desktop" aria-pressed="false">全景</button></div>
      <div class="position-row" aria-label="选择季节">${labels.map((label, index) => `<button type="button" data-season-index="${index}" aria-pressed="false">${label}</button>`).join('')}</div>
      <div class="position-row" aria-label="移动对象"><button type="button" data-target="otter" aria-pressed="false">水獭</button><button type="button" data-target="raccoon" aria-pressed="false">小浣熊</button><button type="button" data-target="together" aria-pressed="true">一起</button></div>
      <div class="position-row position-nudge"><span>微调</span><button type="button" data-dx="-2" data-dy="0" aria-label="向左微调">←</button><button type="button" data-dx="0" data-dy="-2" aria-label="向上微调">↑</button><button type="button" data-dx="0" data-dy="2" aria-label="向下微调">↓</button><button type="button" data-dx="2" data-dy="0" aria-label="向右微调">→</button></div>
      <label class="position-size"><span id="position-scale-label">一起缩放</span> <input id="position-scale" type="range" min="50" max="160" step="1" value="100"><output id="position-scale-value">100%</output></label>
      <div class="position-row"><button type="button" id="position-reset">恢复本季</button><button type="button" id="position-save">保存位置</button></div>
      <p id="position-status" role="status"></p>
      <details id="position-export"><summary>复制位置给我</summary><textarea id="position-data" aria-label="四季位置数据" readonly spellcheck="false"></textarea><button type="button" id="position-copy">复制位置数据</button></details>
    </div>`;
  document.body.append(panel);
  document.documentElement.dataset.positionEditor = 'true';
  const status = panel.querySelector('#position-status');
  const data = panel.querySelector('#position-data');
  const slider = panel.querySelector('#position-scale');
  const clamp = (number, low, high) => Math.max(low, Math.min(high, number));
  const round = value => Math.round(value * 10000) / 10000;
  function render(message) {
    api.update(positions);
    panel.querySelectorAll('[data-season-index]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.seasonIndex) === season)));
    panel.querySelectorAll('[data-target]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.target === target)));
    panel.querySelectorAll('[data-preview]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preview === preview)));
    const relativeSizes = positions[season].bodySizes.map((size, index) => size / defaults[season].bodySizes[index]);
    const scale = target === 'together' ? Math.sqrt(relativeSizes[0] * relativeSizes[1]) : relativeSizes[target === 'otter' ? 0 : 1];
    const percent = Math.round(scale * 100);
    panel.querySelector('#position-scale-label').textContent = target === 'together' ? '一起缩放' : target === 'otter' ? '水獭大小' : '小浣熊大小';
    slider.value = percent;
    panel.querySelector('#position-scale-value').textContent = `${percent}%`;
    data.value = JSON.stringify({ version: 1, seasons: positions }, null, 2);
    if (message) status.textContent = message;
  }
  function move(dx, dy, start = positions[season]) {
    const next = structuredClone(start);
    if (target === 'together') {
      next.x = round(clamp(start.x + dx, .05, .95));
      next.groundY = round(clamp(start.groundY + dy, .15, .95));
    } else {
      const index = target === 'otter' ? 0 : 1;
      next.xOffsets[index] = round(clamp(start.xOffsets[index] + dx, -.4, .4));
      next.groundOffsets[index] = round(clamp(start.groundOffsets[index] + dy, -.4, .4));
    }
    positions[season] = next;
    render('位置已调整，还没有保存。');
  }
  panel.querySelectorAll('[data-preview]').forEach(button => button.addEventListener('click', () => {
    preview = button.dataset.preview;
    api.preview(preview);
    render();
  }));
  panel.querySelectorAll('[data-season-index]').forEach(button => button.addEventListener('click', () => {
    season = Number(button.dataset.seasonIndex);
    api.select(season);
    render();
  }));
  panel.querySelectorAll('[data-target]').forEach(button => button.addEventListener('click', () => {
    target = button.dataset.target;
    render();
  }));
  panel.querySelectorAll('[data-dx]').forEach(button => button.addEventListener('click', () => {
    const { panelWidth, height } = api.dimensions();
    move(Number(button.dataset.dx) / panelWidth, Number(button.dataset.dy) / height);
  }));
  slider.addEventListener('input', () => {
    const scale = Number(slider.value) / 100;
    const sizes = positions[season].bodySizes;
    if (target === 'together') {
      const relativeSizes = sizes.map((size, index) => size / defaults[season].bodySizes[index]);
      const currentScale = Math.sqrt(relativeSizes[0] * relativeSizes[1]);
      const ratio = clamp(scale / currentScale, Math.max(...relativeSizes.map(size => .5 / size)), Math.min(...relativeSizes.map(size => 1.6 / size)));
      positions[season].bodySizes = sizes.map(size => round(size * ratio));
    } else {
      const index = target === 'otter' ? 0 : 1;
      sizes[index] = round(defaults[season].bodySizes[index] * scale);
    }
    render('大小已调整，还没有保存。');
  });
  panel.querySelector('#position-reset').addEventListener('click', () => {
    positions[season] = structuredClone(defaults[season]);
    render('本季已恢复，点保存可更新草稿。');
  });
  panel.querySelector('#position-save').addEventListener('click', () => {
    try {
      localStorage.setItem(storageKey, data.value);
      status.textContent = '已保存在此浏览器。告诉我“调好了”，我再写回主页。';
    } catch { status.textContent = '此浏览器无法保存，请展开下方数据并复制给我。'; }
  });
  panel.querySelector('#position-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(data.value);
      status.textContent = '位置已复制，可以粘贴到聊天里。';
    } catch {
      data.focus();
      data.select();
      status.textContent = '数据已选中，请长按复制或按 ⌘C / Ctrl+C。';
    }
  });
  panel.querySelector('#position-fold').addEventListener('click', event => {
    const controls = panel.querySelector('#position-controls');
    controls.hidden = !controls.hidden;
    event.currentTarget.textContent = controls.hidden ? '展开' : '收起';
    event.currentTarget.setAttribute('aria-expanded', String(!controls.hidden));
  });
  document.querySelectorAll('.animal-pair .animal').forEach(node => {
    let drag = null;
    node.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      season = names.indexOf(node.closest('.season-scene').dataset.season);
      if (target !== 'together') target = node.dataset.animal;
      api.select(season);
      drag = { x: event.clientX, y: event.clientY, start: structuredClone(positions[season]), ...api.dimensions() };
      node.setPointerCapture(event.pointerId);
      render();
    });
    node.addEventListener('pointermove', event => {
      if (drag) move((event.clientX - drag.x) / drag.panelWidth, (event.clientY - drag.y) / drag.height, drag.start);
    });
    node.addEventListener('pointerup', () => { drag = null; });
    node.addEventListener('pointercancel', () => { drag = null; });
    node.addEventListener('lostpointercapture', () => { drag = null; });
  });
  document.addEventListener('click', event => {
    if (event.target.closest('.animal-pair')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (event.target.matches('input, textarea, select')) return;
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const { panelWidth, height } = api.dimensions();
    const step = event.shiftKey ? 10 : 2;
    move(direction[0] * step / panelWidth, direction[1] * step / height);
  });
  api.preview(preview);
  api.select(0);
  render(savedMessage);
})();
