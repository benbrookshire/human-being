/*
 * This Is Not a Joke — "not a robot" highlighter (isolated world).
 *
 *  - Checkboxes labelled "I am a human", "I'm not a robot", "I am not joking"
 *    and similar are outlined, scrolled into view and given keyboard focus,
 *    so pressing Space ticks the box.
 *  - The button that goes with them ("Continue", "Continue shopping",
 *    "Submit", …) gets a pulsing outline so it's obvious where to click next.
 *    This also works on check pages with no checkbox at all ("make sure
 *    you're not a robot … [Continue shopping]").
 *
 * It never ticks, clicks or sends keys itself: the person always does that.
 * It doesn't run inside third-party verification widgets either; for those it
 * only outlines the widget's frame from the page that holds it.
 */
(() => {
  'use strict';
  if (/(^|\.)(recaptcha\.net|hcaptcha\.com)$|^challenges\.cloudflare\.com$/.test(location.hostname)) return;
  if (location.hostname.endsWith('google.com') && location.pathname.includes('/recaptcha/')) return;

  // Label of a checkbox to highlight.
  const PHRASE = /\bi\s*(?:am|['’]?m)\b[^.!?\n]{0,40}?\b(?:human|bot|robot)\b|\bi am not joking\b/i;
  // Page text that means "this is a human check", for pages with no checkbox.
  const CHECK_TEXT = /\bnot a (?:ro)?bot\b|\b(?:verify|confirm|prove|make sure|check)\b[^.!?\n]{0,40}?\b(?:human|(?:ro)?bot)\b|\bare you (?:a )?(?:human|(?:ro)?bot)\b|\bi am not joking\b/i;
  // Labels of the button that goes with it.
  const BUTTON_TEXT = /\b(?:continue|submit|verify|proceed|next|confirm|done|ok|okay|go|start|try again|let me in|enter|i'?m not a robot)\b/i;
  const NOT_BUTTON_TEXT = /\b(?:cancel|back|close|sign out|log out|delete|remove)\b/i;
  const BUTTONS = 'button, input[type=submit], input[type=button], input[type=image], [role=button], a[class*="button" i]';
  const WIDGET_FRAMES = [
    'iframe[title*="recaptcha" i]',
    'iframe[src*="/recaptcha/"][src*="anchor"]',
    'iframe[src*="hcaptcha.com"][src*="checkbox"]',
    'iframe[src*="challenges.cloudflare.com"]',
  ].join(',');

  const MARK = 'data-not-a-joke-highlight';
  const BUTTON_MARK = 'data-not-a-joke-button';
  const BOX_STYLE = [
    ['outline', '3px solid #f5b400'],
    ['outline-offset', '3px'],
    ['box-shadow', '0 0 0 8px rgba(245, 180, 0, 0.35)'],
  ];
  const CSS = `
    @keyframes not-a-joke-pulse {
      0%, 100% { box-shadow: 0 0 0 4px rgba(245, 180, 0, 0.6); }
      50% { box-shadow: 0 0 0 12px rgba(245, 180, 0, 0.15); }
    }
    [${BUTTON_MARK}] {
      outline: 3px solid #f5b400 !important;
      outline-offset: 3px !important;
      animation: not-a-joke-pulse 1.4s ease-in-out infinite !important;
    }
    @media (prefers-reduced-motion: reduce) {
      [${BUTTON_MARK}] { animation: none !important; box-shadow: 0 0 0 8px rgba(245, 180, 0, 0.35) !important; }
    }`;

  let enabled = true;
  let timer = 0;
  let scrolled = false;
  const marked = new Set(); // { box, target }
  const markedButtons = new Set();
  const clickedButtons = new WeakSet();

  // ---- helpers -------------------------------------------------------------

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && getComputedStyle(el).opacity !== '0' && getComputedStyle(el).visibility !== 'hidden';
  };

  function nothingFocused() {
    const a = document.activeElement;
    return !a || a === document.body || a === document.documentElement;
  }

  function scrollOnce(el) {
    if (scrolled) return;
    scrolled = true;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function ensureStyles() {
    if (document.getElementById('not-a-joke-style')) return;
    const style = document.createElement('style');
    style.id = 'not-a-joke-style';
    style.textContent = CSS;
    (document.head || document.documentElement).append(style);
  }

  // ---- checkboxes ----------------------------------------------------------

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

  // Styled checkboxes often hide the real <input>; outline what's visible.
  function outlineTarget(el) {
    if (el.localName === 'iframe' || isVisible(el)) return el;
    return (el.labels && el.labels[0]) || el.parentElement || el;
  }

  function markBox(box, focus) {
    if (box.hasAttribute(MARK)) return;
    box.setAttribute(MARK, '');
    const target = outlineTarget(box);
    for (const [prop, value] of BOX_STYLE) target.style.setProperty(prop, value, 'important');
    marked.add({ box, target });
    scrolled = false; // the box is what the person needs to see first
    scrollOnce(target);
    // Never steal focus from something the person is already typing in.
    if (focus && nothingFocused()) box.focus({ preventScroll: true });
  }

  function unmarkBox(entry) {
    for (const [prop] of BOX_STYLE) entry.target.style.removeProperty(prop);
    entry.box.removeAttribute(MARK);
    marked.delete(entry);
  }

  // ---- buttons -------------------------------------------------------------

  function buttonText(b) {
    return (b.innerText || b.value || b.getAttribute('aria-label') || b.title || b.alt || '').replace(/\s+/g, ' ').trim();
  }

  function usableButtons(root) {
    return [...root.querySelectorAll(BUTTONS)].filter((b) => !b.disabled && isVisible(b) && !NOT_BUTTON_TEXT.test(buttonText(b)));
  }

  const continueLike = (list) => list.find((b) => BUTTON_TEXT.test(buttonText(b)));

  // The button that goes with `el`: its form's continue/submit button, else
  // the nearest continue-like button around it.
  function findButton(el) {
    const form = el.form || (el.closest && el.closest('form'));
    if (form) {
      const list = usableButtons(form);
      if (form.id) list.push(...usableButtons(document).filter((b) => b.getAttribute('form') === form.id));
      const pick = continueLike(list) || list.find((b) => (b.type || '').toLowerCase() === 'submit');
      if (pick) return pick;
    }
    let node = el.parentElement;
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      const pick = continueLike(usableButtons(node));
      if (pick) return pick;
    }
    return null;
  }

  function markButton(b) {
    if (!b || b.hasAttribute(BUTTON_MARK) || clickedButtons.has(b)) return;
    ensureStyles();
    b.setAttribute(BUTTON_MARK, '');
    markedButtons.add(b);
    scrollOnce(b);
  }

  function unmarkButton(b) {
    b.removeAttribute(BUTTON_MARK);
    markedButtons.delete(b);
  }

  // Check pages without a checkbox: find the message, then its button.
  function scanCheckText() {
    const body = document.body;
    const all = body.textContent;
    if (all.length > 200000 || !CHECK_TEXT.test(all)) return;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let n;
    let seen = 0;
    while ((n = walker.nextNode()) && seen++ < 5000) {
      const parent = n.parentElement;
      if (!parent || /^(script|style|noscript|template)$/i.test(parent.localName)) continue;
      if (CHECK_TEXT.test(n.data) || CHECK_TEXT.test(parent.textContent.length < 300 ? parent.textContent : '')) {
        markButton(findButton(parent));
      }
    }
  }

  // ---- scan ----------------------------------------------------------------

  function scan() {
    timer = 0;
    if (!enabled || !document.body) return;
    for (const box of document.querySelectorAll('input[type=checkbox], [role=checkbox]')) {
      if (box.hasAttribute(MARK) || box.disabled || box.checked || box.getAttribute('aria-checked') === 'true') continue;
      if (PHRASE.test(labelText(box))) {
        markBox(box, true);
        markButton(findButton(box));
      }
    }
    for (const frame of document.querySelectorAll(WIDGET_FRAMES)) {
      if (frame.hasAttribute(MARK) || !isVisible(frame)) continue;
      markBox(frame, false);
      markButton(findButton(frame));
    }
    scanCheckText();
  }

  const schedule = () => { if (!timer) timer = setTimeout(scan, 250); };

  function clearAll() {
    for (const entry of [...marked]) unmarkBox(entry);
    for (const b of [...markedButtons]) unmarkButton(b);
  }

  // Once the person has ticked a box, take the highlight off it.
  document.addEventListener('change', (e) => {
    for (const entry of [...marked]) if (entry.box === e.target && e.target.checked) unmarkBox(entry);
  }, true);
  // Once they've clicked the button, take the highlight off that too.
  document.addEventListener('click', (e) => {
    for (const b of [...markedButtons]) {
      if (b.contains(e.target)) { clickedButtons.add(b); unmarkButton(b); }
    }
  }, true);

  new MutationObserver(schedule).observe(document, { childList: true, subtree: true, characterData: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
  else schedule();

  try {
    chrome.storage.local.get({ highlight: true }).then((s) => {
      enabled = s.highlight !== false;
      if (enabled) schedule();
      else clearAll();
    }).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.highlight) return;
      enabled = changes.highlight.newValue !== false;
      if (enabled) schedule();
      else clearAll();
    });
  } catch (_) { /* extension reloaded */ }
})();
