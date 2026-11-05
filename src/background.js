/*
 * This Is Not a Joke — background service worker.
 *
 *  - Registers the page scripts according to the user's settings.
 *  - Deep mode: attaches chrome.debugger to tabs and rewrites response bodies
 *    (HTML, JS, CSS, JSON, XML, subtitles…) before the page ever sees them.
 *    That's what makes variables, function names, the Sources panel, the
 *    Network panel and the console all agree on the rewritten text.
 *  - Keeps a per-tab rewrite count on the toolbar badge.
 */
'use strict';
importScripts('rewriter.js');
const R = self.__notAJokeRewriter;

const DEFAULTS = { enabled: true, deep: true, highlight: true };
const PROTOCOL_VERSION = '1.3';
// Text-bearing resource types. Chrome versions differ in which names the Fetch
// filter accepts, so unknown ones are dropped at runtime (see enableFetch).
let resourceTypes = ['Document', 'Stylesheet', 'Script', 'XHR', 'Fetch', 'TextTrack', 'Manifest', 'Other'];
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
const MAX_BODY = 20 * 1024 * 1024;
const ATTACHABLE = /^(https?|file|about|data):/i;

// ---- state ---------------------------------------------------------------

const tabs = new Map();
function tabState(tabId) {
  let t = tabs.get(tabId);
  if (!t) {
    t = { attached: false, attaching: null, page: 0, net: 0, docUrls: new Set(), reloaded: new Map(), transition: '' };
    tabs.set(tabId, t);
  }
  return t;
}
const unreloadableOrigins = new Set();

const restored = chrome.storage.session.get({ attachedTabs: [] }).then(({ attachedTabs }) => {
  for (const id of attachedTabs) tabState(id).attached = true;
}).catch(() => {});

function persistAttached() {
  const attachedTabs = [...tabs].filter(([, t]) => t.attached).map(([id]) => id);
  chrome.storage.session.set({ attachedTabs }).catch(() => {});
}

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

const stripHash = (url) => String(url || '').split('#')[0];

// ---- configuration -------------------------------------------------------

const ID = 'auto-tick';

async function syncScripts() {
  const { patterns = [] } = await chrome.storage.sync.get('patterns');
  await chrome.scripting.unregisterContentScripts({ ids: [ID] }).catch(() => {});
  if (!patterns.length) return;

  await chrome.scripting.registerContentScripts([{
    id: ID,
    js: ['content.js'],
    matches: patterns,
    runAt: 'document_idle',
    allFrames: true
  }]);
}

chrome.runtime.onInstalled.addListener(syncScripts);
chrome.storage.onChanged.addListener(changes => {
  if (changes.patterns) syncScripts();
});

// ---- badge ---------------------------------------------------------------

function updateBadge(tabId) {
  const t = tabs.get(tabId);
  const n = t ? t.page + t.net : 0;
  const text = n ? (n > 999 ? '999+' : String(n)) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}
chrome.action.setBadgeBackgroundColor({ color: '#2f6f5e' }).catch(() => {});

// ---- content script registration -----------------------------------------

let lock = Promise.resolve();
const serialized = (fn) => (lock = lock.then(fn, fn));

async function syncContentScripts(s) {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((x) => x.id) });
  if (!s.enabled) return;
  const base = { matches: ['<all_urls>'], allFrames: true, matchOriginAsFallback: true, runAt: 'document_start', persistAcrossSessions: true };
  await chrome.scripting.registerContentScripts([
    { ...base, id: 'hb-main', world: 'MAIN', js: pageScripts() },
    { ...base, id: 'hb-bridge', js: ['src/bridge.js', 'src/highlight.js'] },
  ]);
}

const pageScripts = () => ['src/rewriter.js', 'src/page.js'];

function apply() {
  return serialized(async () => {
    const s = await getSettings();
    await syncContentScripts(s);
    if (s.enabled && s.deep) {
      const all = await chrome.tabs.query({});
      await Promise.all(all.filter((t) => ATTACHABLE.test(t.url || t.pendingUrl || '')).map((t) => ensureAttached(t.id)));
    } else {
      await detachAll();
    }
  });
}

// ---- debugger (Deep mode) --------------------------------------------------

const cmd = (target, method, params) => chrome.debugger.sendCommand(target, method, params);

async function enableFetch(target) {
  for (;;) {
    const patterns = resourceTypes.map((resourceType) => ({ urlPattern: '*', resourceType, requestStage: 'Response' }));
    try {
      return await cmd(target, 'Fetch.enable', { patterns });
    } catch (e) {
      const bad = /Unknown resource type in fetch filter: '(\w+)'/.exec(String(e && e.message));
      if (!bad || !resourceTypes.includes(bad[1])) throw e;
      resourceTypes = resourceTypes.filter((t) => t !== bad[1]);
    }
  }
}

async function ensureAttached(tabId) {
  await restored;
  const s = await getSettings();
  if (!s.enabled || !s.deep) return false;
  const t = tabState(tabId);
  if (t.attached) return true;
  if (t.attaching) return t.attaching;
  t.attaching = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    } catch (e) {
      // "Already attached" can be us, from before a service worker restart.
      if (!/already attached/i.test(String(e && e.message))) return false;
    }
    try {
      await enableFetch({ tabId });
    } catch (_) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      return false;
    }
    t.attached = true;
    persistAttached();
    // Out-of-process iframes and workers are separate targets.
    cmd({ tabId }, 'Target.setAutoAttach', AUTO_ATTACH).catch(() => {});
    return true;
  })().finally(() => { t.attaching = null; });
  return t.attaching;
}

async function detachAll() {
  await restored;
  await Promise.all([...tabs].filter(([, t]) => t.attached).map(async ([tabId, t]) => {
    t.attached = false;
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }));
  persistAttached();
}

chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (source.tabId == null) return;
  const t = tabState(source.tabId);
  t.attached = false;
  persistAttached();
  if (reason === 'canceled_by_user') {
    // The user dismissed Chrome's "started debugging" bar: respect that.
    await chrome.storage.local.set({ deep: false });
    apply();
  } else if (reason === 'target_closed') {
    // The renderer was swapped out (e.g. leaving about:blank); the tab lives on.
    const tab = await chrome.tabs.get(source.tabId).catch(() => null);
    if (tab) ensureAttached(source.tabId);
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Fetch.requestPaused') onRequestPaused(source, params);
  else if (method === 'Target.attachedToTarget') onChildTarget(source, params);
});

async function onChildTarget(source, { sessionId, waitingForDebugger }) {
  const child = { tabId: source.tabId, sessionId };
  await enableFetch(child).catch(() => {});
  await cmd(child, 'Target.setAutoAttach', AUTO_ATTACH).catch(() => {});
  if (waitingForDebugger) await cmd(child, 'Runtime.runIfWaitingForDebugger').catch(() => {});
}

const header = (headers, name) => {
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
};

function isTextual(contentType, resourceType) {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (!mime) return resourceType === 'Document' || resourceType === 'Script' || resourceType === 'Stylesheet';
  if (mime === 'text/event-stream' || mime === 'application/x-ndjson') return false; // streaming
  return /^text\//.test(mime) || /(javascript|ecmascript|json|xml|svg|manifest|vtt)/.test(mime);
}

function charsetOf(contentType) {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType);
  return m ? m[1] : '';
}

function decode(bytes, contentType, isDocument) {
  let label = charsetOf(contentType);
  if (!label && isDocument) {
    const head = String.fromCharCode.apply(null, bytes.subarray(0, 2048));
    const m = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
    if (m) label = m[1];
  }
  if (label) {
    try { return new TextDecoder(label).decode(bytes); } catch (_) { /* unknown label */ }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function withUtf8(contentType) {
  return /charset\s*=/i.test(contentType)
    ? contentType.replace(/charset\s*=\s*["']?[\w.:-]+["']?/i, 'charset=utf-8')
    : contentType + '; charset=utf-8';
}

async function onRequestPaused(source, p) {
  const target = source.sessionId ? { tabId: source.tabId, sessionId: source.sessionId } : { tabId: source.tabId };
  const { requestId } = p;
  const pass = () => cmd(target, 'Fetch.continueRequest', { requestId })
    .catch(() => cmd(target, 'Fetch.continueResponse', { requestId }).catch(() => {}));
  try {
    const status = p.responseStatusCode;
    if (p.responseErrorReason || !status || (status >= 300 && status < 400) || status === 204 || status === 304) return pass();

    const isDocument = p.resourceType === 'Document';
    if (isDocument) {
      const t = tabState(source.tabId);
      t.docUrls.add(stripHash(p.request.url));
      if (t.docUrls.size > 50) t.docUrls.delete(t.docUrls.values().next().value);
    }

    const headers = p.responseHeaders || [];
    const contentType = header(headers, 'content-type');
    if (!isTextual(contentType, p.resourceType)) return pass();
    if (Number(header(headers, 'content-length')) > MAX_BODY) return pass();

    const { body, base64Encoded } = await cmd(target, 'Fetch.getResponseBody', { requestId });
    let text;
    if (base64Encoded) {
      const bytes = base64ToBytes(body);
      if (bytes.length > MAX_BODY) return pass();
      text = decode(bytes, contentType, isDocument);
    } else {
      text = body;
    }
    if (!R.mightMatch(text)) return pass();
    const r = R.rewrite(text, R.FULL);
    if (!r.count) return pass();

    const responseHeaders = headers
      .filter((h) => !/^(content-length|content-encoding|transfer-encoding)$/i.test(h.name))
      .map((h) => (h.name.toLowerCase() === 'content-type' ? { name: h.name, value: withUtf8(h.value) } : h));
    await cmd(target, 'Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders,
      body: bytesToBase64(new TextEncoder().encode(r.text)),
      ...(p.responseStatusText ? { responsePhrase: p.responseStatusText } : {}),
    });
    const t = tabState(source.tabId);
    t.net += r.count;
    updateBadge(source.tabId);
  } catch (_) {
    pass();
  }
}

// Deep mode attached too late for this document (e.g. typed into a fresh
// New Tab page): reload it once so the network layer can rewrite it.
async function onRawFound(tabId, url) {
  const s = await getSettings();
  if (!s.enabled || !s.deep) return;
  const t = tabState(tabId);
  const key = stripHash(url);
  let origin = '';
  try { origin = new URL(key).origin; } catch (_) { return; }
  if (!/^https?:/.test(key) || t.docUrls.has(key) || t.transition === 'form_submit') return;
  if (unreloadableOrigins.has(origin)) return;
  if (t.reloaded.has(key)) {
    // Reloaded already and still not intercepted (service worker, cache…): give up on this origin.
    unreloadableOrigins.add(origin);
    return;
  }
  if (!(await ensureAttached(tabId))) return;
  t.reloaded.set(key, Date.now());
  chrome.tabs.reload(tabId).catch(() => {});
}

// ---- tab lifecycle -----------------------------------------------------------

chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0 || tabId < 0) return;
  const t = tabState(tabId);
  t.page = 0;
  t.net = 0;
  updateBadge(tabId);
  if (ATTACHABLE.test(url)) ensureAttached(tabId);
});

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, transitionType }) => {
  if (frameId === 0 && tabId >= 0) tabState(tabId).transition = transitionType;
});

chrome.tabs.onCreated.addListener((tab) => {
  if (ATTACHABLE.test(tab.pendingUrl || tab.url || '')) ensureAttached(tab.id);
});

chrome.tabs.onReplaced.addListener((added, removed) => {
  tabs.delete(removed);
  ensureAttached(added);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  persistAttached();
});

// ---- messages ------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  switch (msg && msg.type) {
    case 'count':
      if (tabId != null) {
        tabState(tabId).page += msg.n;
        updateBadge(tabId);
      }
      return false;
    case 'raw-found':
      if (tabId != null && sender.frameId === 0) onRawFound(tabId, sender.url || msg.url);
      return false;
    case 'get-status':
      (async () => {
        await restored;
        const t = tabs.get(msg.tabId);
        sendResponse({
          settings: await getSettings(),
          count: t ? t.page + t.net : 0,
          page: t ? t.page : 0,
          net: t ? t.net : 0,
          attached: !!(t && t.attached),
        });
      })();
      return true;
    case 'set-settings':
      (async () => {
        await chrome.storage.local.set(msg.settings);
        await apply();
        sendResponse({ ok: true, settings: await getSettings() });
      })();
      return true;
  }
  return false;
});

// ---- install / startup -------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.storage.local.set(await getSettings());
  await apply();
  if (reason !== 'install' && reason !== 'update') return;
  // Rewrite tabs that were already open (their next reload gets the full treatment).
  const s = await getSettings();
  if (!s.enabled) return;
  for (const tab of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file://*/*'] })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: 'MAIN', files: pageScripts() }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => apply());
