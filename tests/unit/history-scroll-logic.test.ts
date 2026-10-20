import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureMessageAnchor, restoreMessageAnchor } from '../../apps/web/src/history-scroll-logic.js';

function viewport() {
  const positions = [{ id: 'a', top: 0, height: 100 }, { id: 'b', top: 100, height: 140 }, { id: 'c', top: 240, height: 200 }];
  const box = {
    scrollTop: 120, scrollHeight: 600,
    getBoundingClientRect: () => ({ top: 40, bottom: 340 }),
    querySelectorAll: () => positions.map((item) => ({ dataset: { messageId: item.id }, getBoundingClientRect: () => ({ top: 40 + item.top - box.scrollTop, bottom: 40 + item.top + item.height - box.scrollTop }) })),
  };
  return { box, positions };
}

test('prepend variable-height messages preserves the first visible message and its offset', () => {
  const { box, positions } = viewport();
  const anchor = captureMessageAnchor(box);
  assert.equal(anchor.id, 'b');
  assert.equal(anchor.offset, -20);
  positions.forEach((item) => { item.top += 267; });
  box.scrollHeight += 267;
  restoreMessageAnchor(box, anchor);
  assert.equal(box.scrollTop, 387);
  assert.equal(captureMessageAnchor(box).offset, -20);
});

test('native browser anchor compensation is not applied a second time', () => {
  const { box, positions } = viewport();
  const anchor = captureMessageAnchor(box);
  positions.forEach((item) => { item.top += 180; });
  box.scrollHeight += 180;
  box.scrollTop += 180;
  restoreMessageAnchor(box, anchor);
  assert.equal(box.scrollTop, 300);
});

test('reader movement during loading can refresh the anchor without jumping back', () => {
  const { box, positions } = viewport();
  captureMessageAnchor(box);
  box.scrollTop = 260;
  const current = captureMessageAnchor(box);
  assert.equal(current.id, 'c');
  positions.forEach((item) => { item.top += 90; });
  box.scrollHeight += 90;
  restoreMessageAnchor(box, current);
  assert.equal(box.scrollTop, 350);
});

test('if the anchored item disappears, height-difference fallback keeps the reading position', () => {
  const { box, positions } = viewport();
  const anchor = captureMessageAnchor(box);
  positions.splice(1, 1);
  box.scrollHeight += 75;
  restoreMessageAnchor(box, anchor);
  assert.equal(box.scrollTop, 195);
});
