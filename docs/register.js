if (window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then(() => navigator.serviceWorker.ready)
    .then(async (registration) => {
      const shell = await caches.match(new URL('index.html', registration.scope));
      const status = document.getElementById('offline-status');
      if (shell && status) status.hidden = false;
    }).catch((error) => {
      console.warn('Super Yatzy could not prepare offline play.', error);
    });
}
