/*
 * Human Being — isolated-world bridge. The MAIN-world script can't talk to the
 * extension, so it fires DOM events that this script forwards to the
 * background service worker.
 */
(() => {
  'use strict';
  const send = (msg) => {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) { /* extension reloaded */ }
  };
  document.addEventListener('human-being:count', (e) => {
    const n = Number(e.detail);
    if (n > 0 && n < 1e7) send({ type: 'count', n });
  });
  document.addEventListener('human-being:raw', () => {
    if (window === window.top) send({ type: 'raw-found', url: location.href });
  });
})();
