/*
 * Human Being — core rewriting engine.
 *
 * Turns phrases like "I am a human" into "I am a human being", and code
 * identifiers like `iAmAHuman`, `i_am_a_human`, `I-AM-A-HUMAN` into
 * `iAmAHumanBeing`, `i_am_a_human_being`, `I-AM-A-HUMAN-BEING`.
 *
 * Every rewrite is expressed as a set of pure *insertions* into the original
 * string (we never delete characters). That lets the DOM layer apply a single
 * rewrite across several text nodes, e.g. "I am a <b>human</b>".
 *
 * Runs unchanged in a page (MAIN world), the extension service worker, and
 * Node (for tests).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__humanBeingRewriter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Words that, directly after "human", mean the phrase is something else
  // ("I am a human resources manager") or is already done ("human being").
  const STOP_WORDS = [
    'being', 'beings', 'resource', 'resources', 'right', 'rights', 'nature',
    'race', 'error', 'errors', 'interest', 'interests', 'life', 'lives',
    'body', 'bodies', 'touch', 'trafficking', 'trafficker', 'shield',
    'element', 'factor', 'factors', 'capital', 'development', 'service',
    'services', 'geography', 'genome', 'condition', 'experience',
    'behavior', 'behaviour', 'brain', 'brains', 'eye', 'eyes', 'voice',
    'user', 'users', 'scale', 'spirit', 'species', 'anatomy', 'evolution',
    'history', 'psychology', 'physiology', 'relations', 'relationship',
    'face', 'faces', 'form', 'forms', 'figure', 'figures', 'skin', 'mind',
    'minds', 'cell', 'cells', 'sacrifice', 'subject', 'subjects', 'trial',
    'trials', 'tissue', 'chain', 'wall', 'torch', 'cannonball',
    'calculator', 'computer', 'pyramid', 'review', 'reviewer', 'reviewers',
    'operator', 'operators', 'agent', 'agents', 'player', 'players',
    'intervention', 'oversight', 'readable', 'centered', 'centred',
  ];
  const STOP_SET = new Set(STOP_WORDS);

  const ADVERBS = [
    'not', 'just', 'only', 'also', 'still', 'really', 'truly', 'definitely',
    'actually', 'merely', 'simply', 'literally', 'certainly', 'indeed',
    'totally', 'completely', 'absolutely', 'probably', 'clearly',
    'obviously', 'surely', 'basically', 'honestly', 'proudly', 'too',
    'all', 'both', 'but', 'always', 'after\\s+all', '100\\s*%', 'a\\s+hundred\\s+percent',
  ];
  const ADJECTIVES = [
    'real', 'actual', 'fellow', 'living', 'ordinary', 'normal', 'regular',
    'genuine', 'true', 'mere', 'simple', 'verified', 'live', 'little', 'good',
    'decent', 'young', 'old', 'imperfect', 'flawed', 'whole', 'complete',
    'flesh-and-blood', 'warm-blooded', 'carbon-based', 'kind', 'nice',
  ];

  // Whitespace as it may appear in text, raw HTML, or JS/JSON source.
  const SP = '(?:\\s|&nbsp;|&#0*160;|&#x0*a0;)+';
  // Apostrophes: plain, curly, modifier letter, HTML entities, JS escapes.
  const APOS = "(?:\\\\?['\\u2019\\u02bc]|&#0*39;|&#x0*27;|&apos;|&rsquo;|&#0*8217;|&#x0*2019;|\\\\u2019)";
  const SUBJ = 'i|you|we|they|he|she';
  const VERB = `am|are|is|ain${APOS}t|aren${APOS}t|isn${APOS}t`;
  const ADV = `(?:${ADVERBS.join('|')})`;
  const ADJ = `(?:${ADJECTIVES.join('|')})`;
  const STOP = `(?:${STOP_WORDS.join('|')})`;

  const PROSE_SOURCE =
    '\\b(?:' +
      `(?<s1>${SUBJ})(?:${SP}(?:${VERB})|${APOS}(?:m|re|s))` + // I am / I'm / you're
      '|(?<s2>i)m' + // Im
      `|(?:${VERB})${SP}(?<s3>${SUBJ})` + // am I / are you
    ')' +
    `(?<adv>(?:,?${SP}${ADV})+,?)?` + // not / just / , after all,
    SP +
    `(?:(?<art>an?)${SP})?` +
    `(?<adj>(?:${ADJ}${SP}){0,2})` +
    '(?<noun>humans?)' +
    "(?![\\w\\u00c0-\\u024f]|[-'\\u2019]\\w)" + // not humane / human-made / human's
    `(?!${SP}${STOP}\\b)`; // not "human being", "human resources"…

  const PROSE_RE = new RegExp(PROSE_SOURCE, 'gid');

  // Regions we never touch: URLs, URL-bearing attributes, CSS url().
  // Quoted forms only — masking an unquoted code identifier would desync it
  // from its other (rewritten) occurrences.
  const PROTECT_RE = new RegExp(
    [
      "\\b(?:https?|wss?|ftp|file|chrome-extension|moz-extension)://[^\\s\"'<>`(){}$\\\\]*",
      "\\bblob:https?://[^\\s\"'<>`(){}$\\\\]*",
      "\\bdata:[a-z]+/[a-z0-9.+-]+[;,][^\\s\"'<>`(){}$\\\\]*",
      "\\b(?:href|src|srcset|action|formaction|poster|xlink:href)\\s*=\\s*(?:\"[^\"]*\"|'[^']*')",
      "\\burl\\(\\s*(?:\"[^\"]*\"|'[^']*'|[^)\"'\\s]*[./][^)\"'\\s]*)\\s*\\)",
    ].join('|'),
    'gi'
  );

  const HUMAN_RE = /human/i;
  const TOKEN_RE = /[A-Za-z0-9_$]+(?:-[A-Za-z0-9_$]+)*/g;
  const WORD_RE = /([_$-]+)|([A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+)/g;

  // Subject/verb word sequences recognised inside identifiers.
  const ID_SUBJECTS = [
    ['i', 'am'], ['im'], ['iam'], ['you', 'are'], ['youre'], ['we', 'are'],
    ['they', 'are'], ['theyre'], ['he', 'is'], ['she', 'is'], ['am', 'i'],
    ['are', 'you'], ['are', 'we'], ['are', 'they'], ['is', 'he'], ['is', 'she'],
  ];
  const ID_ADVERBS = new Set(['not', 'just', 'only', 'also', 'still', 'really', 'truly', 'definitely', 'actually', 'totally']);
  const ID_GLUED_RE = /^(?:iam|im|youare|youre|weare|theyare|areyou|ami)(?:not)?(?:an?)?(humans?)$/i;

  const isUpper = (s) => s.length > 1 && s === s.toUpperCase() && s !== s.toLowerCase();
  const isCap = (s) => s[0] !== s[0].toLowerCase();

  function styled(word, model) {
    if (isUpper(model)) return word.toUpperCase();
    if (isCap(model)) return word[0].toUpperCase() + word.slice(1);
    return word;
  }

  // ---- Prose -------------------------------------------------------------

  function proseInsertions(str, base, out) {
    PROSE_RE.lastIndex = 0;
    let m;
    while ((m = PROSE_RE.exec(str))) {
      const g = m.groups;
      const nounStart = m.indices.groups.noun[0];
      const noun = g.noun;
      const subj = (g.s1 || g.s2 || g.s3 || '').toLowerCase();
      const plural = subj === 'we' || subj === 'they';
      const being = styled('being', noun);

      if (noun.length === 6) {
        // "humans" → "human beings"
        out.push({ index: base + nounStart + 5, text: ' ' + being });
      } else if (g.art) {
        out.push({ index: base + nounStart + 5, text: ' ' + being });
      } else if (plural) {
        out.push({ index: base + nounStart + 5, text: ' ' + being + styled('s', noun) });
      } else {
        // "I am human" → "I am a human being"
        const at = g.adj ? m.indices.groups.adj[0] : nounStart;
        const prevWord = (str.slice(0, at).match(/([A-Za-z]+)\W*$/) || [])[1] || '';
        let article = 'a';
        if (isUpper(noun)) article = 'A';
        else if (isCap(noun) && prevWord && isCap(prevWord) && prevWord.toLowerCase() !== 'i') article = 'A';
        out.push({ index: base + at, text: article + ' ' });
        out.push({ index: base + nounStart + 5, text: ' ' + being });
      }
    }
  }

  // ---- Identifiers -------------------------------------------------------

  function splitWords(token) {
    const words = [];
    let sep = '';
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(token))) {
      if (m[1]) sep += m[1];
      else {
        words.push({ text: m[2], lower: m[2].toLowerCase(), start: m.index, end: m.index + m[2].length, sep });
        sep = '';
      }
    }
    return words;
  }

  function identifierInsertions(str, base, out) {
    TOKEN_RE.lastIndex = 0;
    let t;
    while ((t = TOKEN_RE.exec(str))) {
      const token = t[0];
      if (!HUMAN_RE.test(token)) continue;
      const tStart = t.index;
      const tEnd = tStart + token.length;
      // Leave URL/file paths alone: /api/i-am-a-human, ./i-am-a-human/...
      if (str[tStart - 1] === '/' || str[tEnd] === '/') continue;

      const words = splitWords(token);
      for (let j = 0; j < words.length; j++) {
        let nounIdx = -1;

        const glued = ID_GLUED_RE.exec(words[j].text);
        if (glued) {
          nounIdx = j;
        } else {
          for (const seq of ID_SUBJECTS) {
            if (seq.every((w, i) => words[j + i] && words[j + i].lower === w)) {
              let k = j + seq.length;
              if (words[k] && ID_ADVERBS.has(words[k].lower)) k++;
              if (words[k] && (words[k].lower === 'a' || words[k].lower === 'an')) k++;
              if (words[k] && (words[k].lower === 'human' || words[k].lower === 'humans')) nounIdx = k;
              break;
            }
          }
        }
        if (nounIdx < 0) continue;

        const next = words[nounIdx + 1];
        if (next && STOP_SET.has(next.lower)) continue;

        const w = words[nounIdx];
        let model, sep, end;
        if (glued) {
          model = glued[1];
          sep = '';
          end = w.end;
        } else {
          model = w.text;
          sep = /^[_-]+$/.test(w.sep) ? w.sep : '';
          end = w.end;
        }
        const plural = /s$/i.test(model);
        const insertAt = plural ? end - 1 : end;
        out.push({ index: base + tStart + insertAt, text: sep + styled('being', model) });
        j = nounIdx;
      }
    }
  }

  // ---- Public API --------------------------------------------------------

  const FULL = Object.freeze({ prose: true, identifiers: true });

  /**
   * Returns the sorted list of insertions ({ index, text }) that turn `str`
   * into its "human being" form. Empty when nothing needs to change.
   */
  function findInsertions(str, opts) {
    if (typeof str !== 'string' || !HUMAN_RE.test(str)) return [];
    opts = opts || FULL;
    const out = [];
    const scan = (segment, base) => {
      if (!HUMAN_RE.test(segment)) return;
      if (opts.prose !== false) proseInsertions(segment, base, out);
      if (opts.identifiers !== false) identifierInsertions(segment, base, out);
    };
    PROTECT_RE.lastIndex = 0;
    let last = 0;
    let p;
    while ((p = PROTECT_RE.exec(str))) {
      scan(str.slice(last, p.index), last);
      last = p.index + p[0].length;
    }
    scan(str.slice(last), last);
    return out.sort((a, b) => a.index - b.index);
  }

  function applyInsertions(str, insertions) {
    if (!insertions.length) return str;
    let res = '';
    let last = 0;
    for (const ins of insertions) {
      res += str.slice(last, ins.index) + ins.text;
      last = ins.index;
    }
    return res + str.slice(last);
  }

  /** Returns { text, count }. */
  function rewrite(str, opts) {
    const ins = findInsertions(str, opts);
    if (!ins.length) return { text: str, count: 0 };
    // Article + noun insertions for one phrase count as one rewrite.
    const count = ins.filter((i) => !/^an?\s$/i.test(i.text)).length;
    return { text: applyInsertions(str, ins), count };
  }

  /** Convenience: returns just the rewritten string. */
  function rewriteText(str, opts) {
    return rewrite(str, opts).text;
  }

  return {
    findInsertions,
    applyInsertions,
    rewrite,
    rewriteText,
    mightMatch: (s) => typeof s === 'string' && HUMAN_RE.test(s),
    FULL,
    PROSE_ONLY: Object.freeze({ prose: true, identifiers: false }),
  };
});
