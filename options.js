const input = document.getElementById('patterns');
const status = document.getElementById('status');
const VALID = /^(\*|https?):\/\/(\*|(\*\.)?[^/*]+)\/.*$/;

chrome.storage.sync.get({ patterns: [] }).then(({ patterns }) => {
  input.value = patterns.join('\n');
});

document.getElementById('save').addEventListener('click', async () => {
  const patterns = input.value.split('\n').map(s => s.trim()).filter(Boolean);
  const invalid = patterns.find(p => !VALID.test(p));
  if (invalid) {
    status.textContent = `Invalid pattern: ${invalid}`;
    return;
  }

  // Permissions apply to the whole site, so remove any path.
  const origins = [...new Set(patterns.map(p =>
    p.replace(/^([^:]+:\/\/[^/]+)\/.*$/, '$1/*')
  ))];

  // Keep this before any other await so Chrome can show the prompt.
  const granted = !origins.length || await chrome.permissions.request({ origins });
  if (!granted) {
    status.textContent = 'Site access was not granted, so nothing changed.';
    return;
  }

  await chrome.storage.sync.set({ patterns });
  status.textContent = 'Saved. Reload any open tabs.';
});
