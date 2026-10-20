// Preserve a visible message rather than assuming every prepended item has the
// same height. Native scroll anchoring may already have compensated: delta=0
// in that case, so it is never applied twice.
export function captureMessageAnchor(box) {
  const bounds = box.getBoundingClientRect();
  const message = [...box.querySelectorAll('[data-message-id]')].find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > bounds.top && rect.top < bounds.bottom;
  });
  return {
    id: message?.dataset.messageId ?? null,
    offset: message ? message.getBoundingClientRect().top - bounds.top : 0,
    scrollTop: box.scrollTop,
    scrollHeight: box.scrollHeight,
  };
}

export function restoreMessageAnchor(box, anchor) {
  if (!anchor) return;
  const message = [...box.querySelectorAll('[data-message-id]')].find((node) => node.dataset.messageId === anchor.id);
  if (message) {
    box.scrollTop += message.getBoundingClientRect().top - box.getBoundingClientRect().top - anchor.offset;
  } else {
    box.scrollTop = anchor.scrollTop + box.scrollHeight - anchor.scrollHeight;
  }
}
