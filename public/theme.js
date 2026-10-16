// Runs before the page draws, so a dark-mode choice doesn't flash white first.
// "light" or "dark" is a choice made in TaskForge; no choice follows the computer's setting.
try {
  const theme = localStorage.getItem('tf-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* storage unavailable: follow the computer */ }
