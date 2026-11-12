// uQ's theme: the vendored uq-tokens module validates uQ's tokens.json (read by the main process,
// uq-theme.js, through the preload's window.uqTokens) and sets --uq-* and data-uq-variant on
// <html>; uq-theme.css maps them onto GutCheck's colours. Without uQ, or outside the app, nothing
// is set and style.css applies as before.
import { watchTokens } from '../vendor/uq-tokens/uq-tokens.js';

export function startUqTheme(win = globalThis.window, root) {
  const bridge = win && win.uqTokens;
  if (!bridge || typeof bridge.read !== 'function' || typeof bridge.subscribe !== 'function') return null;
  const opts = { read: bridge.read, subscribe: bridge.subscribe };
  return watchTokens(root ? { ...opts, root } : opts);
}

if (globalThis.window && globalThis.document) startUqTheme();
