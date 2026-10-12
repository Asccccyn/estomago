/* Independent red-cord layer. All coordinates are in the unchanged cel space. */
(function (root) {
  'use strict';
  const anchors = [
    { left: [281, 163], right: [340, 158], wrist: [442, 279], leftWrist: [118, 263] },
    { left: [281, 163], right: [338, 158], wrist: [439, 281], leftWrist: [115, 265] },
    { left: [283, 163], right: [286.5, 160], wrist: [425, 270], leftWrist: [117, 265] },
    { left: [283, 163], right: [289.5, 161], wrist: [423, 266], leftWrist: [115, 265] },
    { left: [286, 161], right: [301, 161], wrist: [419, 279], leftWrist: [122, 261] },
    { left: [286, 161], right: [288.5, 155], wrist: [406, 291], leftWrist: [120, 263] },
    { left: [280, 151], right: [287.5, 142], wrist: [407, 283], leftWrist: [120, 262] },
    { left: [280, 165], right: [287.5, 155.5], wrist: [409, 295], leftWrist: [120, 263] },
  ];
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const smooth = n => { n = clamp(n, 0, 1); return n * n * (3 - 2 * n); };

  // Rounded, softly shaded crimson silk: no shadow blur or light emission.
  function stroke(ctx, draw, width = 3.1) {
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.shadowBlur = 0;
    ctx.beginPath(); draw(ctx);
    ctx.lineWidth = width + .65; ctx.strokeStyle = '#90242f'; ctx.stroke();
    ctx.lineWidth = width; ctx.strokeStyle = '#ba3946'; ctx.stroke();
    ctx.save();
    ctx.translate(0, -.30);
    ctx.beginPath(); draw(ctx);
    ctx.lineWidth = .62; ctx.strokeStyle = 'rgba(238, 142, 138, .35)'; ctx.stroke();
    ctx.restore(); ctx.restore();
  }

  function geometry(pose, time, offsetX, offsetY) {
    const a = anchors[pose.index];
    const left = a.left;
    const right = [a.right[0] + offsetX, a.right[1] + offsetY];
    const wrist = [a.wrist[0] + offsetX, a.wrist[1] + offsetY];
    const gap = Math.max(0, right[0] - left[0]);
    const close = smooth((105 - gap) / 88);
    const age = Math.max(0, time - 2.70);
    const damp = Math.exp(-age * 2.8);
    const sway = Math.sin((time - .45) * 5.4) * (2.2 + 3.8 * (1 - pose.entrance)) * damp;
    const drop = 48 + close * 12 + Math.sin(time * 5.4 + .6) * 2.5 * damp;
    return { left, right, wrist, leftWrist: a.leftWrist, gap, close, sway, drop };
  }

  function draw(ctx, pose, time, offsetX, offsetY) {
    const g = geometry(pose, time, offsetX, offsetY);
    const [lx, ly] = g.left, [rx, ry] = g.right, [wx, wy] = g.wrist;
    // The side strands meet their existing painted wraps without detached tips.
    stroke(ctx, c => {
      c.moveTo(g.leftWrist[0], g.leftWrist[1]);
      c.bezierCurveTo(164, 278, lx - 44, ly + 49, lx, ly);
    }, 2.9);
    stroke(ctx, c => {
      c.moveTo(rx, ry);
      c.bezierCurveTo(rx + 14, ry + 46, wx - 53, wy + 5, wx, wy);
    }, 2.9);
    // A long drape gathers into a soft loop in the space below the linked pinkies.
    // Swing decays after contact; endpoints remain attached to the original poses.
    stroke(ctx, c => {
      c.moveTo(lx, ly);
      c.bezierCurveTo(
        lx + g.gap * .23 - g.close * 15 + g.sway,
        ly + g.drop,
        rx - g.gap * .23 + g.close * 24 + g.sway,
        ry + g.drop,
        rx, ry
      );
    }, 3.2);
  }
  const api = { draw, geometry, anchors };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PinkyCord = api;
})(typeof window !== 'undefined' ? window : globalThis);
