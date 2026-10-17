/* Hand-drawn cels and thread compositing. Shared by the browser and video export. */
(function (root) {
  'use strict';
  const cord = typeof module !== 'undefined' && module.exports ? require('./cord.js') : root.PinkyCord;
  const introDuration = 1.5;
  const originalDuration = 5.2;
  const duration = introDuration + originalDuration;
  const cells = [
    { x: 0, y: 0, w: 485, h: 385, dx: 0, dy: 0 },
    { x: 491, y: 0, w: 479, h: 385, dx: 0, dy: 0 },
    { x: 977, y: 0, w: 479, h: 385, dx: 0, dy: 0 },
    { x: 1463, y: 0, w: 479, h: 385, dx: 0, dy: 0 },
    { x: 0, y: 405, w: 485, h: 385, dx: 0, dy: 0 },
    { x: 491, y: 405, w: 479, h: 385, dx: 0, dy: 0 },
    { x: 977, y: 405, w: 479, h: 385, dx: 0, dy: 0 },
    { x: 1463, y: 405, w: 479, h: 385, dx: 0, dy: 0 },
  ];
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const ease = n => { n = clamp(n, 0, 1); return n * n * n * (n * (n * 6 - 15) + 10); };
  function poseAt(t) {
    t = clamp(t - introDuration, 0, originalDuration);
    if (t < 1.7) return { index: 0, entrance: 1 - ease((t - .45) / 1.25), settle: 0 };
    if (t < 1.87) return { index: 1, entrance: 0, settle: 0 };
    if (t < 2.02) return { index: 2, entrance: 0, settle: 0 };
    if (t < 2.18) return { index: 3, entrance: 0, settle: 0 };
    if (t < 2.36) return { index: 4, entrance: 0, settle: 0 };
    if (t < 2.53) return { index: 5, entrance: 0, settle: 0 };
    if (t < 2.70) return { index: 6, entrance: 0, settle: 0 };
    return { index: 7, entrance: 0, settle: ease((t - 2.70) / .55) };
  }
  function framing(width, height) {
    const portrait = height > width * 1.12;
    // On a phone, crop only the lower forearms so their edges exit the screen.
    // The entire contact area and every fingertip remain in frame.
    const sourceWidth = portrait ? 404 : Math.min(485, Math.max(425, width / height * 255));
    const scale = width / sourceWidth;
    const sourceLeft = portrait ? 62 : (485 - sourceWidth) / 2;
    const targetHookY = portrait ? height * .455 : height * .47;
    const y = Math.max(targetHookY - 154 * scale, height * .065 - 24 * scale);
    return { scale, x: -sourceLeft * scale, y, portrait };
  }
  function drawCel(ctx, sheet, index, clip, translateX = 0, translateY = 0) {
    const c = cells[index];
    ctx.save();
    ctx.translate(translateX + c.dx, translateY + c.dy);
    if (clip) { ctx.beginPath(); ctx.rect(clip[0], clip[1], clip[2], clip[3]); ctx.clip(); }
    // Blend the original cel's white paper into the page without resampling the asset.
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(sheet, c.x, c.y, c.w, c.h, 0, 0, 485, 385);
    ctx.restore();
  }
  function render(ctx, sheet, width, height, time) {
    const p = poseAt(time);
    const originalTime = clamp(time - introDuration, 0, originalDuration);
    const remaining = 1 - ease(time / introDuration);
    const maleOffsetX = -340 * remaining;
    const maleOffsetY = 100 * remaining;
    const f = framing(width, height);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#f8f4ed'; ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.translate(f.x, f.y); ctx.scale(f.scale, f.scale);
    // A shared, restrained settling movement; no skeletal morphing or finger stretching.
    const bob = p.index === 7 ? -1.8 * Math.sin(p.settle * Math.PI) : 0;
    ctx.translate(0, bob);
    const offsetX = p.entrance * 300;
    const offsetY = p.entrance * 22;
    if (p.index === 0) {
      drawCel(ctx, sheet, 0, [0, 0, 307, 385], maleOffsetX, maleOffsetY);
      drawCel(ctx, sheet, 0, [308, 0, 177, 385], offsetX, offsetY);
    } else drawCel(ctx, sheet, p.index);

    // Move the left wraps with the unchanged hand; keep the right end offscreen.
    // Once the intro ends these transforms are zero and the old timeline resumes.
    ctx.save();
    if (time < introDuration) {
      const visibleLeft = -f.x / f.scale;
      ctx.globalAlpha = ease((281 + maleOffsetX - visibleLeft) / 24);
    }
    ctx.translate(maleOffsetX, maleOffsetY);
    cord.draw(ctx, p, originalTime, offsetX - maleOffsetX, offsetY - maleOffsetY);
    ctx.restore();
    ctx.restore();
  }
  const api = { duration, introDuration, cells, poseAt, framing, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PinkyScene = api;
})(typeof window !== 'undefined' ? window : globalThis);
