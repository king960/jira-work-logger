// Runs synchronously at the top of <body> so the popup never flashes the classic look.
// popup.js remains the source of truth (chrome.storage.sync) and corrects this cached value.
// The key matches THEME_CACHE_KEY in theme-settings.js; unknown values simply match no CSS.
try {
  const cached = localStorage.getItem("worklogTheme");
  if (/^[a-z]{1,20}$/.test(cached || "")) document.body.dataset.theme = cached;
} catch { /* storage may be blocked */ }
