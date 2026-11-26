(() => {
  const previews = ['calendar', 'reading', 'anniversaries', 'voice', 'upstairs'];
  document.addEventListener('home:action', event => {
    if (event.defaultPrevented) return;
    const { action, season } = event.detail ?? {};
    let route;
    if (action === 'chat') route = '/chat';
    else if (action === 'wishes') route = '/wishstar';
    else if (action === 'album') route = '/home/album';
    else if (action === 'moments') route = '/home/moments';
    else if (previews.includes(action)) {
      route = `/home/feature.html?feature=${action}`;
      if (action === 'calendar' && season === 'summer') route += '&season=summer';
    }
    if (route) {
      event.preventDefault();
      window.top.location.assign(route);
    }
  });
})();
