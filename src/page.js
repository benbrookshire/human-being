/*
 * Human Being — page-world layer (runs in the page's MAIN world at
 * document_start, in every frame).
 *
 *  1. Hooks the DOM write paths (textContent, innerHTML, nodeValue,
 *     createTextNode, setAttribute, document.write, input.value, …) so text
 *     is rewritten *before* it lands in the page — no flicker, and code that
 *     reads it back sees "human being".
 *  2. Walks the DOM (incl. open/closed shadow roots) with a MutationObserver
 *     to catch everything parsed from HTML, including phrases split across
 *     elements ("I am a <b>human</b>").
 *  3. Patches console.* so logged strings, objects and errors show
 *     "human being" in DevTools.
 *  4. Patches canvas text, alert/confirm/prompt and document.title.
 *
 * This layer never renames *structural* identifiers (class/id attributes,
 * code inside <script>/<style>, HTML strings handed to innerHTML): renaming
 * one copy of an identifier without the others breaks pages. Deep mode
 * renames those at the network layer, where every file is rewritten
 * together. Text nodes, readable attributes and console output get the full
 * treatment (prose + identifiers) in every mode.
 */
(() => {
  'use strict';
  const INSTALLED = Symbol.for('human-being.installed');
  if (window[INSTALLED]) return;

  const R = globalThis.__humanBeingRewriter;
  try { delete globalThis.__humanBeingRewriter; } catch (_) { /* ignore */ }
  if (!R) return;
  Object.defineProperty(window, INSTALLED, { value: true });

  const FULL = R.FULL;
  const HTML_OPTS = R.PROSE_ONLY; // text nodes inside get identifiers via the walker
  const CODE_OPTS = R.PROSE_ONLY;

  // ---- bookkeeping -------------------------------------------------------

  let pending = 0;
  let flushTimer = 0;
  let parserCount = 0; // rewrites applied to parser-created content before DOMContentLoaded
  let loaded = document.readyState !== 'loading';

  const emit = (type, detail) => {
    try { document.dispatchEvent(new CustomEvent('human-being:' + type, { detail })); } catch (_) { /* ignore */ }
  };
  const bump = (n, fromParser) => {
    if (!n) return;
    if (fromParser && !loaded) parserCount += n;
    pending += n;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = 0;
        emit('count', pending);
        pending = 0;
      }, 300);
    }
  };

  const rw = (v, opts) => {
    if (typeof v !== 'string' || !R.mightMatch(v)) return v;
    const r = R.rewrite(v, opts);
    bump(r.count);
    return r.text;
  };

  // ---- capture natives before hooking -----------------------------------

  const desc = (proto, prop) => (proto ? Object.getOwnPropertyDescriptor(proto, prop) : undefined);
  const nativeDataSet = desc(CharacterData.prototype, 'data').set;
  const nativeTextContent = desc(Node.prototype, 'textContent');
  const nativeSetAttribute = Element.prototype.setAttribute;
  const nativeValue = {
    input: desc(HTMLInputElement.prototype, 'value'),
    textarea: desc(HTMLTextAreaElement.prototype, 'value'),
  };
  const nativeAttachShadow = Element.prototype.attachShadow;

  // ---- classification ----------------------------------------------------

  const INLINE = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn', 'em',
    'font', 'i', 'ins', 'kbd', 'mark', 'nobr', 'q', 's', 'samp', 'small', 'span',
    'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr', 'label',
    'tspan', 'textpath',
  ]);
  const CODE_ELEMENTS = new Set(['script', 'style']);
  const URL_ATTRS = new Set([
    'href', 'src', 'srcset', 'action', 'formaction', 'poster', 'cite', 'background',
    'data', 'ping', 'xlink:href', 'codebase', 'longdesc', 'usemap', 'manifest',
    'itemtype', 'itemid', 'profile', 'integrity', 'nonce', 'style',
  ]);
  const READABLE_ATTRS = new Set([
    'title', 'alt', 'placeholder', 'aria-label', 'aria-description', 'aria-roledescription',
    'aria-placeholder', 'aria-valuetext', 'label', 'summary', 'content', 'data-tooltip',
    'data-title', 'data-original-title', 'data-label', 'data-placeholder', 'tooltip',
  ]);
  const NO_VALUE_TYPES = new Set(['hidden', 'password', 'checkbox', 'radio', 'file']);

  const isCodeElement = (el) => !!el && el.nodeType === 1 && CODE_ELEMENTS.has(el.localName);

  function attrEligible(el, name) {
    name = name.toLowerCase();
    if (URL_ATTRS.has(name)) return false;
    if (el.localName === 'input' && name === 'value') {
      return !NO_VALUE_TYPES.has((el.getAttribute('type') || 'text').toLowerCase());
    }
    return READABLE_ATTRS.has(name);
  }

  const textOptsFor = (node) => {
    const el = node && node.nodeType === 1 ? node : node && node.parentNode;
    return isCodeElement(el) ? CODE_OPTS : FULL;
  };

  // ---- DOM walker --------------------------------------------------------

  const deferredEditing = new Set();

  function editingHost(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.isContentEditable) return null;
    let host = el;
    while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
    return host;
  }

  function isBeingEdited(node) {
    const host = editingHost(node);
    if (!host) return false;
    const active = document.activeElement;
    if (active && (active === host || host.contains(active))) {
      deferredEditing.add(host);
      return true;
    }
    return false;
  }

  // Apply one rewrite across a run of adjacent text nodes.
  function processRun(nodes, fromParser) {
    if (!nodes.length) return;
    const texts = nodes.map((n) => n.data);
    const joined = texts.join('');
    if (!R.mightMatch(joined)) return;
    const ins = R.findInsertions(joined, FULL);
    if (!ins.length) return;
    if (isBeingEdited(nodes[0])) return;

    const starts = [];
    let pos = 0;
    for (const t of texts) { starts.push(pos); pos += t.length; }
    const perNode = new Map();
    for (const i of ins) {
      let idx = 0;
      for (let k = 0; k < texts.length; k++) {
        if (texts[k].length && starts[k] < i.index && i.index <= starts[k] + texts[k].length) { idx = k; break; }
        if (i.index === 0 && texts[k].length) { idx = k; break; }
      }
      if (!perNode.has(idx)) perNode.set(idx, []);
      perNode.get(idx).push({ index: i.index - starts[idx], text: i.text });
    }
    let count = 0;
    for (const [idx, list] of perNode) {
      nativeDataSet.call(nodes[idx], R.applyInsertions(texts[idx], list));
      count += list.filter((i) => !/^an?\s$/i.test(i.text)).length;
    }
    bump(count, fromParser);
  }

  function collectText(node, out) {
    if (node.nodeType === 3) out.push(node);
    else if (node.nodeType === 1 && INLINE.has(node.localName)) {
      for (let c = node.firstChild; c; c = c.nextSibling) collectText(c, out);
    }
  }

  const isRunMember = (n) => n.nodeType === 3 || n.nodeType === 8 || (n.nodeType === 1 && INLINE.has(n.localName));

  function containerOf(node) {
    let top = node;
    let parent = node.parentNode;
    while (parent && parent.nodeType === 1 && INLINE.has(parent.localName) && parent.parentNode) {
      top = parent;
      parent = parent.parentNode;
    }
    return { parent, top };
  }

  // Process the inline run (text + inline elements) that `node` belongs to.
  function processRunAround(node, fromParser) {
    const { parent, top } = containerOf(node);
    if (!parent) return;
    if (isCodeElement(parent)) return processCode(parent, fromParser);
    if (!isRunMember(top)) return;
    let start = top;
    while (start.previousSibling && isRunMember(start.previousSibling)) start = start.previousSibling;
    const nodes = [];
    for (let n = start; n && isRunMember(n); n = n.nextSibling) collectText(n, nodes);
    processRun(nodes, fromParser);
  }

  // Process all direct inline runs of a block-level container.
  function processContainer(el, fromParser) {
    if (isCodeElement(el)) return processCode(el, fromParser);
    let run = [];
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (isRunMember(c)) collectText(c, run);
      else { processRun(run, fromParser); run = []; }
    }
    processRun(run, fromParser);
  }

  function processCode(el, fromParser) {
    const text = nativeTextContent.get.call(el);
    if (!R.mightMatch(text)) return;
    const r = R.rewrite(text, CODE_OPTS);
    if (r.count) {
      nativeTextContent.set.call(el, r.text);
      bump(r.count, fromParser);
    }
  }

  function processComment(node) {
    const r = R.rewrite(node.data, FULL);
    if (r.count) { nativeDataSet.call(node, r.text); bump(r.count); }
  }

  function processAttr(el, name, fromParser) {
    const value = el.getAttribute(name);
    if (!R.mightMatch(value) || !attrEligible(el, name)) return;
    const r = R.rewrite(value, FULL);
    if (r.count) {
      nativeSetAttribute.call(el, name, r.text);
      bump(r.count, fromParser);
    }
  }

  function processAttrs(el, fromParser) {
    const attrs = el.attributes;
    if (!attrs) return;
    for (let i = 0; i < attrs.length; i++) {
      if (R.mightMatch(attrs[i].value)) processAttr(el, attrs[i].name, fromParser);
    }
  }

  const observedRoots = new WeakSet();

  function scanSubtree(root, fromParser) {
    if (root.nodeType === 3) return processRunAround(root, fromParser);
    if (root.nodeType === 8) return processComment(root);
    if (root.nodeType !== 1 && root.nodeType !== 11 && root.nodeType !== 9) return;
    if (root.nodeType === 1) {
      if (INLINE.has(root.localName)) processRunAround(root, fromParser);
      else processContainer(root, fromParser);
      processAttrs(root, fromParser);
      if (root.shadowRoot) observeRoot(root.shadowRoot);
    } else {
      processContainer(root, fromParser);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 8) { processComment(n); continue; }
      if (!INLINE.has(n.localName)) processContainer(n, fromParser);
      processAttrs(n, fromParser);
      if (n.shadowRoot) observeRoot(n.shadowRoot);
    }
  }

  function handleMutations(records) {
    const fromParser = !loaded;
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) scanSubtree(n, fromParser);
      } else if (r.type === 'characterData') {
        if (r.target.nodeType === 8) processComment(r.target);
        else processRunAround(r.target, fromParser);
      } else if (r.type === 'attributes') {
        processAttr(r.target, r.attributeName, fromParser);
      }
    }
  }

  const observer = new MutationObserver(handleMutations);
  const OBSERVE = {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: [...READABLE_ATTRS, 'value'],
  };

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, OBSERVE);
    scanSubtree(root, !loaded);
  }

  // ---- hooks: rewrite on the way in -------------------------------------

  function hookSetter(proto, prop, transform) {
    const d = desc(proto, prop);
    if (!d || !d.set || !d.configurable) return;
    Object.defineProperty(proto, prop, {
      ...d,
      set(v) { return d.set.call(this, transform(this, v)); },
    });
  }

  function hookMethod(proto, name, wrap) {
    const orig = proto && proto[name];
    if (typeof orig !== 'function') return;
    const wrapped = wrap(orig);
    Object.defineProperty(wrapped, 'name', { value: name });
    Object.defineProperty(proto, name, { value: wrapped, writable: true, configurable: true, enumerable: false });
  }

  const textTransform = (self, v) => {
    if (self && self.nodeType === 2) return self.ownerElement && !attrEligible(self.ownerElement, self.name) ? v : rw(v, FULL);
    return rw(v, textOptsFor(self));
  };
  const htmlTransform = (self, v) => rw(v, isCodeElement(self) ? CODE_OPTS : HTML_OPTS);

  hookSetter(Node.prototype, 'textContent', textTransform);
  hookSetter(Node.prototype, 'nodeValue', textTransform);
  hookSetter(CharacterData.prototype, 'data', textTransform);
  hookSetter(HTMLElement.prototype, 'innerText', textTransform);
  hookSetter(HTMLElement.prototype, 'outerText', textTransform);
  hookSetter(Element.prototype, 'innerHTML', htmlTransform);
  hookSetter(Element.prototype, 'outerHTML', htmlTransform);
  hookSetter(ShadowRoot.prototype, 'innerHTML', htmlTransform);
  hookSetter(Document.prototype, 'title', (_s, v) => rw(v, FULL));

  hookMethod(Document.prototype, 'createTextNode', (orig) => function (data) {
    return orig.call(this, rw(data, FULL));
  });
  hookMethod(Document.prototype, 'createComment', (orig) => function (data) {
    return orig.call(this, rw(data, FULL));
  });
  for (const m of ['write', 'writeln']) {
    hookMethod(Document.prototype, m, (orig) => function (...args) {
      return orig.apply(this, args.map((a) => rw(a, HTML_OPTS)));
    });
  }
  hookMethod(Element.prototype, 'insertAdjacentHTML', (orig) => function (pos, html) {
    return orig.call(this, pos, rw(html, HTML_OPTS));
  });
  hookMethod(Element.prototype, 'insertAdjacentText', (orig) => function (pos, text) {
    return orig.call(this, pos, rw(text, FULL));
  });
  for (const proto of [Element.prototype, ShadowRoot.prototype]) {
    hookMethod(proto, 'setHTMLUnsafe', (orig) => function (html, ...rest) {
      return orig.call(this, rw(html, HTML_OPTS), ...rest);
    });
  }
  hookMethod(Range.prototype, 'createContextualFragment', (orig) => function (html) {
    return orig.call(this, rw(html, HTML_OPTS));
  });
  hookMethod(DOMParser.prototype, 'parseFromString', (orig) => function (str, type) {
    return orig.call(this, rw(str, HTML_OPTS), type);
  });
  hookMethod(Element.prototype, 'setAttribute', (orig) => function (name, value) {
    if (typeof value === 'string' && R.mightMatch(value) && attrEligible(this, String(name))) value = rw(value, FULL);
    return orig.call(this, name, value);
  });
  hookMethod(Element.prototype, 'setAttributeNS', (orig) => function (ns, name, value) {
    if (typeof value === 'string' && R.mightMatch(value) && attrEligible(this, String(name))) value = rw(value, FULL);
    return orig.call(this, ns, name, value);
  });

  // Form values set from script.
  for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
    hookSetter(proto, 'value', (self, v) => {
      if (NO_VALUE_TYPES.has(self.type)) return v;
      return rw(v, FULL);
    });
  }

  // Values the user typed: rewrite once they're done (change/blur), never mid-keystroke.
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || NO_VALUE_TYPES.has(el.type)) return;
    const d = el.localName === 'input' ? nativeValue.input : el.localName === 'textarea' ? nativeValue.textarea : null;
    if (!d) return;
    const v = d.get.call(el);
    const r = R.rewrite(v, FULL);
    if (r.count) { d.set.call(el, r.text); bump(r.count); }
  }, true);
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      for (const host of [...deferredEditing]) {
        const active = document.activeElement;
        if (active && (active === host || host.contains(active))) continue;
        deferredEditing.delete(host);
        if (host.isConnected) scanSubtree(host, false);
      }
    }, 0);
  }, true);

  // Shadow roots — including closed ones, which only this hook can see.
  if (nativeAttachShadow) {
    hookMethod(Element.prototype, 'attachShadow', () => function (init) {
      const root = nativeAttachShadow.call(this, init);
      try { observeRoot(root); } catch (_) { /* ignore */ }
      return root;
    });
  }

  // Canvas text.
  for (const proto of [
    window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype,
    window.OffscreenCanvasRenderingContext2D && OffscreenCanvasRenderingContext2D.prototype,
  ]) {
    if (!proto) continue;
    for (const m of ['fillText', 'strokeText', 'measureText']) {
      hookMethod(proto, m, (orig) => function (text, ...rest) {
        return orig.call(this, rw(text, FULL), ...rest);
      });
    }
  }

  // Dialogs.
  for (const m of ['alert', 'confirm', 'prompt']) {
    const orig = window[m];
    if (typeof orig !== 'function') continue;
    const wrapped = function (...args) { return orig.apply(this, args.map((a) => rw(a, FULL))); };
    Object.defineProperty(wrapped, 'name', { value: m });
    window[m] = wrapped;
  }

  // ---- console -----------------------------------------------------------

  const isPlain = (v) => {
    if (!v || typeof v !== 'object') return false;
    if (Array.isArray(v)) return true;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
  };

  function containsMatch(v, depth, seen) {
    if (typeof v === 'string') return R.mightMatch(v) && R.findInsertions(v).length > 0;
    if (!isPlain(v) || depth > 5 || seen.has(v)) return false;
    seen.add(v);
    for (const k of Object.keys(v)) {
      if (containsMatch(k, depth + 1, seen) || containsMatch(v[k], depth + 1, seen)) return true;
    }
    return false;
  }

  function cloneRewritten(v, depth, seen) {
    if (typeof v === 'string') return rw(v, FULL);
    if (!isPlain(v) || depth > 5) return v;
    if (seen.has(v)) return seen.get(v);
    const out = Array.isArray(v) ? [] : Object.create(Object.getPrototypeOf(v));
    seen.set(v, out);
    for (const k of Object.keys(v)) out[Array.isArray(v) ? k : rw(k, FULL)] = cloneRewritten(v[k], depth + 1, seen);
    return out;
  }

  function consoleArg(v) {
    if (typeof v === 'string') return rw(v, FULL);
    if (v instanceof Error) {
      const msg = String(v.message);
      const stack = typeof v.stack === 'string' ? v.stack : '';
      if (!R.mightMatch(msg) && !R.mightMatch(stack)) return v;
      const copy = new Error(rw(msg, FULL));
      Object.setPrototypeOf(copy, Object.getPrototypeOf(v));
      if (stack) Object.defineProperty(copy, 'stack', { value: rw(stack, FULL), configurable: true, writable: true });
      return copy;
    }
    if (isPlain(v) && containsMatch(v, 0, new Set())) return cloneRewritten(v, 0, new Map());
    return v;
  }

  const isPrimitive = (v) => v === null || (typeof v !== 'object' && typeof v !== 'function' && typeof v !== 'symbol');

  // console.log('I am a', 'human') and console.log('I am a %s', 'human') render
  // as one line, so rewrite them as one line.
  function joinIfPrimitive(args) {
    if (args.length < 2 || !args.every(isPrimitive) || typeof args[0] !== 'string') return null;
    let rest = args.slice(1);
    let first = args[0];
    if (/%[oOc]/.test(first)) return null;
    first = first.replace(/%([%sdif])/g, (m, f) => {
      if (f === '%') return '%';
      if (!rest.length) return m;
      const a = rest.shift();
      if (f === 's') return String(a);
      if (f === 'f') return String(Number(a));
      return String(parseInt(a, 10));
    });
    const joined = [first, ...rest.map(String)].join(' ');
    return R.findInsertions(joined).length ? [rw(joined, FULL)] : null;
  }

  const CONSOLE_METHODS = [
    'log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table',
    'group', 'groupCollapsed', 'assert', 'count', 'countReset', 'time', 'timeEnd', 'timeLog',
  ];
  for (const m of CONSOLE_METHODS) {
    const orig = console[m];
    if (typeof orig !== 'function') continue;
    const wrapped = function (...args) {
      try {
        if (m === 'assert') {
          const [cond, ...rest] = args;
          args = [cond, ...(joinIfPrimitive(rest) || rest.map(consoleArg))];
        } else {
          args = joinIfPrimitive(args) || args.map(consoleArg);
        }
      } catch (_) { /* never break logging */ }
      return orig.apply(this, args);
    };
    Object.defineProperty(wrapped, 'name', { value: m });
    console[m] = wrapped;
  }

  // ---- start -------------------------------------------------------------

  observeRoot(document);

  if (!loaded) {
    document.addEventListener('DOMContentLoaded', () => {
      loaded = true;
      scanSubtree(document, false);
      // Raw (un-rewritten) HTML reached the parser: Deep mode missed this
      // document, so let the background decide whether to reload it.
      if (window === window.top && parserCount > 0) emit('raw', parserCount);
    }, { once: true });
  }
})();
