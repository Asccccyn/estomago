/* Confirmed actions are handed to the existing authenticated host.
   wishes（她 2026-10-18）：跳站内许愿星页——页面她自己做，先占位。 */
(() => {
  document.addEventListener('home:action', event => {
    const action = event.detail?.action;
    if (action === 'chat') { event.preventDefault(); window.top.location.assign('/chat'); }
    if (action === 'wishes') { event.preventDefault(); window.top.location.assign('/wishstar'); }
  });
})();
