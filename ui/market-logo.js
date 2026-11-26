// Both market views share the same local PNG. Inspect a thumbnail once per feed
// and ticker so monochrome symbols can sit directly on the dark dashboard.

function surface(image) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 24;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 'paper';
  ctx.drawImage(image, 0, 0, 24, 24);
  const {data} = ctx.getImageData(0, 0, 24, 24);
  let clear = 0, visible = 0, dark = 0, chromatic = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = data.subarray(i, i + 4);
    if (a < 32) clear++;
    if (a < 128) continue;
    visible++;
    if (.213*r + .715*g + .072*b < 90) dark++;
    if (Math.max(r,g,b) - Math.min(r,g,b) > 30) chromatic++;
  }
  if (!visible) return 'paper';
  if (clear < 24) return chromatic > visible*.85 && dark < visible*.1 ? 'dark' : 'paper';
  if (dark > visible*.94 && chromatic < visible*.02) return 'reverse';
  return dark > visible*.22 ? 'paper' : 'dark';
}

export function marketLogo(symbol) {
  const badge = document.createElement('span');
  badge.className = 'mw-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = symbol.slice(0, 2);
  badge.style.setProperty('--hue', String([...symbol].reduce((n,c) => n*3+c.charCodeAt(0), 0)%360));
  return badge;
}

export function showMarketLogo(badge, symbol, feed, available, cache) {
  if (!feed || !available) return;
  const src = '/widget-view/'+encodeURIComponent(feed)+'/logos/'+encodeURIComponent(symbol)+'.png';
  if (badge.dataset.src === src) return;
  badge.dataset.src = src;
  const img = new Image();
  img.alt = '';
  img.onload = () => {
    if (badge.dataset.src !== src) return;
    let treatment = cache.get(src);
    if (!treatment) {
      try { treatment = surface(img); } catch { treatment = 'paper'; }
      cache.set(src, treatment);
    }
    badge.dataset.surface = treatment;
    badge.classList.toggle('wide', img.naturalWidth > img.naturalHeight*1.9);
    badge.replaceChildren(img);
  };
  img.src = src;
}
