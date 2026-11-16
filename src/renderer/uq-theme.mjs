// uQ's theme: the vendored uq-tokens module validates uQ's tokens.json (read by the main process,
// uq-theme.js, through the preload's window.uqTokens) and sets --uq-* and data-uq-variant on
// <html>; uq-theme.css maps them onto GutCheck's colours. Without uQ, or outside the app, nothing
// is set and style.css applies as before.
import { watchTokens } from '../vendor/uq-tokens/uq-tokens.js';

// WCAG contrast ratio of two #rrggbb(aa) colours (alpha ignored), or null when either is not one.
const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/i;
function luminance(c) {
  const m = typeof c === 'string' && HEX.exec(c);
  if (!m) return null;
  const [r, g, b] = m.slice(1, 4).map((h) => { const v = parseInt(h, 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return x == null || y == null ? null : (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
// Text on each background it sits on must reach 3:1, and the warning and error colours 2:1. A pair
// with a colour missing is not judged.
const PAIRS = [['text', 'bg', 3], ['text', 'surface', 3], ['text', 'surface_alt', 3], ['error', 'bg', 2], ['warning', 'bg', 2], ['accent_text', 'accent', 2]];
export function readable(text) {
  let colors;
  try { colors = JSON.parse(text).colors; } catch { return true; } // not JSON: uq-tokens ignores it anyway
  if (!colors || typeof colors !== 'object') return true;
  return PAIRS.every(([fg, bg, min]) => { const c = contrast(colors[fg], colors[bg]); return c == null || c >= min; });
}

export function startUqTheme(win = globalThis.window, root) {
  const bridge = win && win.uqTokens;
  if (!bridge || typeof bridge.read !== 'function' || typeof bridge.subscribe !== 'function') return null;
  // A theme whose text cannot be told from its background is not applied (GutCheck's own colours
  // stay): it would hide the preview and the warnings of a confirm dialog.
  const read = () => Promise.resolve(bridge.read()).then((t) => (readable(t) ? t : null), () => null);
  const opts = { read, subscribe: bridge.subscribe };
  return watchTokens(root ? { ...opts, root } : opts);
}

if (globalThis.window && globalThis.document) startUqTheme();
