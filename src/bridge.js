/*
 * This Is Not a Joke — isolated-world bridge. The MAIN-world script can't talk to the
 * extension, so it fires DOM events that this script forwards to the
 * background service worker.
 */
(() => {
  'use strict';
  const send = (msg) => {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) { /* extension reloaded */ }
  };
  document.addEventListener('this-is-not-a-joke:count', (e) => {
    const n = Number(e.detail);
    if (n > 0 && n < 1e7) send({ type: 'count', n });
  });
  document.addEventListener('this-is-not-a-joke:raw', () => {
    if (window === window.top) send({ type: 'raw-found', url: location.href });
  });
})();
