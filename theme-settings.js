// Shared by the workspace page and the toolbar popup so both always offer the same looks.
export const THEME_IDS = ["classic", "ledger", "bartek", "xp", "minecraft", "audiophile", "macos", "yellow", "cyberpunk"];

// Extension pages share one origin, so a localStorage copy lets the popup paint with the right
// theme before the asynchronous chrome.storage read completes. Keep in sync with popup-theme.js.
export const THEME_CACHE_KEY = "worklogTheme";

export function normalizeTheme(value) {
  return THEME_IDS.includes(value) ? value : "classic";
}

export function cacheTheme(theme) {
  try { localStorage.setItem(THEME_CACHE_KEY, theme); } catch { /* storage may be blocked; the cache is optional */ }
}
