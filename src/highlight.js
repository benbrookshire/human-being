/*
 * This Is Not a Joke — checkbox highlighter (isolated world).
 *
 * Finds checkboxes labelled "I am a human", "I'm not a robot", "I am not
 * joking" and similar, outlines them, scrolls them into view and gives them
 * keyboard focus, so pressing Space ticks the box.
 *
 * It never ticks, clicks or sends keys itself: the person always does that.
 * It doesn't run inside third-party verification widgets either; for those it
 * only outlines the widget's frame from the page that holds it.
 */
(() => {
  'use strict';
  if (/(^|\.)(recaptcha\.net|hcaptcha\.com)$|^challenges\.cloudflare\.com$/.test(location.hostname)) return;
  if (location.hostname.endsWith('google.com') && location.pathname.includes('/recaptcha/')) return;

  const PHRASE = /\bi\s*(?:am|['’]?m)\b[^.!?\n]{0,40}?\b(?:human|bot|robot)\b|\bi am not joking\b/i;
  const WIDGET_FRAMES = [
    'iframe[title*="recaptcha" i]',
    'iframe[src*="/recaptcha/"][src*="anchor"]',
    'iframe[src*="hcaptcha.com"][src*="checkbox"]',
    'iframe[src*="challenges.cloudflare.com"]',
  ].join(',');
  const MARK = 'data-not-a-joke-highlight';
  const STYLE = [
    ['outline', '3px solid #f5b400'],
    ['outline-offset', '3px'],
    ['box-shadow', '0 0 0 8px rgba(245, 180, 0, 0.35)'],
  ];

  let enabled = true;
  let timer = 0;
  const marked = new Set(); // { box, target }

  function labelText(el) {
    const parts = [el.getAttribute('aria-label') || ''];
    if (el.labels) for (const l of el.labels) parts.push(l.textContent);
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const n = document.getElementById(id);
      if (n) parts.push(n.textContent);
    }
    if (el.getAttribute('role') === 'checkbox') parts.push(el.textContent);
    // Text right next to the box, for markup without a proper <label>.
    const p = el.parentElement;
    if (p && p.textContent.length < 200) parts.push(p.textContent);
    return parts.join(' ').replace(/\s+/g, ' ');
  }

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && getComputedStyle(el).opacity !== '0';
  };

  // Styled checkboxes often hide the real <input>; outline what's visible.
  function outlineTarget(el) {
    if (el.localName === 'iframe' || isVisible(el)) return el;
    return (el.labels && el.labels[0]) || el.parentElement || el;
  }

  function nothingFocused() {
    const a = document.activeElement;
    return !a || a === document.body || a === document.documentElement;
  }

  function mark(box, focus) {
    if (box.hasAttribute(MARK)) return;
    box.setAttribute(MARK, '');
    const target = outlineTarget(box);
    for (const [prop, value] of STYLE) target.style.setProperty(prop, value, 'important');
    marked.add({ box, target });
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // check the box too
    if (!box.checked && !box.disabled) box.click();
    // Never steal focus from something the person is already typing in.
    if (focus && nothingFocused()) box.focus({ preventScroll: true });
  }

  function unmark(entry) {
    for (const [prop] of STYLE) entry.target.style.removeProperty(prop);
    entry.box.removeAttribute(MARK);
    marked.delete(entry);
  }

  function scan() {
    timer = 0;
    if (!enabled || !document.body) return;
    for (const box of document.querySelectorAll('input[type=checkbox], [role=checkbox]')) {
      if (box.hasAttribute(MARK) || box.disabled || box.checked || box.getAttribute('aria-checked') === 'true') continue;
      if (PHRASE.test(labelText(box))) mark(box, true);
    }
    for (const frame of document.querySelectorAll(WIDGET_FRAMES)) mark(frame, false);
  }

  const schedule = () => { if (!timer) timer = setTimeout(scan, 250); };

  // Once the person has ticked a box, take the highlight off it.
  document.addEventListener('change', (e) => {
    for (const entry of [...marked]) if (entry.box === e.target && e.target.checked) unmark(entry);
  }, true);

  new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
  else schedule();

  try {
    chrome.storage.local.get({ highlight: true }).then((s) => {
      enabled = s.highlight !== false;
      if (enabled) schedule();
    }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.highlight) return;
      enabled = changes.highlight.newValue !== false;
      if (enabled) schedule();
      else for (const entry of [...marked]) unmark(entry);
    });
  } catch (_) { /* extension reloaded */ }
})();
