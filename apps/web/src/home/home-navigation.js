/* Only the confirmed chat action is handed to the existing authenticated host. */
(() => {
  document.addEventListener('home:action', event => {
    if (event.detail?.action !== 'chat') return;
    event.preventDefault();
    window.top.location.assign('/chat');
  });
})();
