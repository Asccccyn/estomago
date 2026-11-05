/* Only existing pages navigate here. Other home:action events remain available
   to the calendar, reading, anniversary, moments, album, voice and upstairs integrations. */
(() => {
  document.addEventListener('home:action', event => {
    if (event.defaultPrevented) return;
    const action = event.detail?.action;
    if (action === 'chat') { event.preventDefault(); window.top.location.assign('/chat'); }
    if (action === 'wishes') { event.preventDefault(); window.top.location.assign('/wishstar'); }
  });
})();
