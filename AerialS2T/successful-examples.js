(() => {
  const cards = [...document.querySelectorAll('.example-card')];
  const videos = cards.map(card => card.querySelector('video'));
  cards.forEach(card => {
    const video = card.querySelector('video');
    const button = card.querySelector('.example-play');
    const label = button.querySelector('.example-play-label');
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      label.textContent = 'Loading…';
      videos.forEach(other => { if (other !== video) other.pause(); });
      if (!video.getAttribute('src')) {
        const compact = matchMedia('(max-width:700px)').matches || navigator.connection?.saveData;
        video.poster = card.querySelector('img').currentSrc || card.querySelector('img').src;
        video.src = compact ? video.dataset.exampleMobile : video.dataset.exampleSrc;
      }
      video.hidden = false;
      try { await video.play(); button.hidden = true; }
      catch { label.textContent = 'Retry video'; }
      finally { button.disabled = false; }
    });
    video.addEventListener('play', () => {
      videos.forEach(other => { if (other !== video) other.pause(); });
      button.hidden = true;
    });
    video.addEventListener('error', () => {
      label.textContent = 'Retry video';
      button.disabled = false;
      button.hidden = false;
      video.removeAttribute('src');
      video.load();
    });
  });
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (!entry.isIntersecting) entry.target.pause(); });
    });
    videos.forEach(video => observer.observe(video));
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) videos.forEach(video => video.pause());
  });
})();
