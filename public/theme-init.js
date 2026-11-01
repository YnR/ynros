// Runs before the page paints so the saved theme never flashes.
try {
  const t = localStorage.getItem('harness-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch { /* storage blocked */ }
