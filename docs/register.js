if (window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch((error) => {
    console.warn('Super Yatzy could not prepare offline play.', error);
  });
}
