(() => {
  const previews = ['calendar', 'reading', 'anniversaries', 'moments', 'album', 'voice', 'upstairs'];
  document.addEventListener('home:action', event => {
    if (event.defaultPrevented) return;
    const { action, subject, season } = event.detail ?? {};
    let route;
    if (action === 'chat') route = '/chat';
    else if (action === 'wishes') route = '/wishstar';
    else if (previews.includes(action)) {
      route = `/home/feature.html?feature=${action}`;
      if (action === 'calendar' && season === 'summer') route += '&season=summer';
      if (action === 'album' && ['otter', 'raccoon', 'cat'].includes(subject)) route += `&subject=${subject}`;
    }
    if (route) {
      event.preventDefault();
      window.top.location.assign(route);
    }
  });
})();
