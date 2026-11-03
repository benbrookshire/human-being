'use strict';
const $ = (id) => document.getElementById(id);
let tab;
let initial;

function render(status) {
  const s = status.settings;
  $('enabled').checked = s.enabled;
  $('deep').checked = s.deep;
  $('deep').disabled = !s.enabled;
  $('count').textContent = status.count;
  $('count-label').textContent = status.count === 1 ? 'rewrite on this page' : 'rewrites on this page';
  let msg = '';
  if (!s.enabled) msg = 'Paused. Pages keep their original text.';
  else if (s.deep && status.attached) msg = 'Deep mode is active on this tab.';
  else if (s.deep) msg = 'Deep mode can’t run on this page (browser pages, the Web Store, or another debugger).';
  else msg = 'Standard mode: visible text and console only.';
  $('status').textContent = msg;
  const changed = initial && (initial.enabled !== s.enabled || initial.deep !== s.deep);
  $('reload').hidden = !changed;
}

async function refresh() {
  render(await chrome.runtime.sendMessage({ type: 'get-status', tabId: tab && tab.id }));
}

async function save() {
  await chrome.runtime.sendMessage({ type: 'set-settings', settings: { enabled: $('enabled').checked, deep: $('deep').checked } });
  refresh();
}

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const status = await chrome.runtime.sendMessage({ type: 'get-status', tabId: tab && tab.id });
  initial = status.settings;
  render(status);
  $('enabled').addEventListener('change', save);
  $('deep').addEventListener('change', save);
  $('reload').addEventListener('click', () => { if (tab) chrome.tabs.reload(tab.id); window.close(); });
})();
