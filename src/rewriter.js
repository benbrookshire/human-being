/*
 * This Is Not a Joke — core rewriting engine.
 *
 * 1. First person: "I am a human", "I am a bot", "I'm not a robot", "I am a
 *    human being" … all become "I am not joking". Identifiers follow suit:
 *    `iAmABot` → `iAmNotJoking`, `I_AM_A_HUMAN` → `I_AM_NOT_JOKING`.
 * 2. Everyone else: "Are you human?" → "Are you a human being?",
 *    `weAreHumans` → `weAreHumanBeings`.
 *
 * Every rewrite is expressed as a list of edits on the original string:
 * { index, length, text } = "replace `length` chars at `index` with `text`"
 * (length 0 is a pure insertion). That lets the DOM layer apply a single
 * rewrite across several text nodes, e.g. "I am a <b>bot</b>".
 *
 * Runs unchanged in a page (MAIN world), the extension service worker, and
 * Node (for tests).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__notAJokeRewriter = api;
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
    // "I am a bot developer", "I'm a robot vacuum"…
    'developer', 'developers', 'builder', 'builders', 'maker', 'makers',
    'account', 'accounts', 'farm', 'owner', 'owners', 'detector',
    'detection', 'framework', 'army', 'network', 'traffic', 'wars', 'war',
    'fight', 'battle', 'competition', 'kit', 'arm', 'vacuum', 'cleaner',
    'lawnmower', 'enthusiast', 'engineer', 'engineers', 'designer',
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

  // First person, human or bot, with or without "not" → "I am not joking".
  const JOKE_SOURCE =
    `\\b(?:i(?:${SP}am|${APOS}m)|im)` + // I am / I'm / Im
    `(?:(?:,?${SP}${ADV})+,?)?` + // not / just / , after all,
    SP +
    `(?:an?${SP})?` +
    `(?:${ADJ}${SP}){0,2}` +
    `(?:human(?:${SP}being)?|bot|robot)` +
    "(?![\\w\\u00c0-\\u024f]|[-'\\u2019]\\w)" +
    `(?!${SP}${STOP}\\b)`;
  const JOKE_RE = new RegExp(JOKE_SOURCE, 'gi');

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

  const HUMAN_RE = /human|bot/i;
  const TOKEN_RE = /[A-Za-z0-9_$]+(?:-[A-Za-z0-9_$]+)*/g;
  const WORD_RE = /([_$-]+)|([A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+)/g;

  // Subject/verb word sequences recognised inside identifiers.
  const ID_FIRST_PERSON = [['i', 'am'], ['im'], ['iam']];
  const ID_OTHER_SUBJECTS = [
    ['you', 'are'], ['youre'], ['we', 'are'], ['they', 'are'], ['theyre'],
    ['he', 'is'], ['she', 'is'], ['am', 'i'], ['are', 'you'], ['are', 'we'],
    ['are', 'they'], ['is', 'he'], ['is', 'she'],
  ];
  const ID_ADVERBS = new Set(['not', 'just', 'only', 'also', 'still', 'really', 'truly', 'definitely', 'actually', 'totally']);
  const ID_JOKE_NOUNS = new Set(['human', 'humans', 'bot', 'robot']);
  const ID_GLUED_JOKE_RE = /^(?:iam|im)(?:not|just|only|also|still|really|truly|definitely|actually|totally)?(?:an?)?(?:humanbeing|humans?|bot|robot)$/i;
  const ID_GLUED_RE = /^(?:youare|youre|weare|theyare|areyou|ami)(?:not)?(?:an?)?(humans?)$/i;

  const isUpper = (s) => s.length > 1 && s === s.toUpperCase() && s !== s.toLowerCase();
  const isCap = (s) => s[0] !== s[0].toLowerCase();
  const capitalize = (w) => w[0].toUpperCase() + w.slice(1);
  const JOKE_WORDS = ['i', 'am', 'not', 'joking'];

  // "I am not joking" in the casing of the phrase it replaces.
  function jokeProse(match) {
    const plain = match.replace(/&#?\w+;|\\u[0-9a-f]{4}/gi, ' ');
    const words = (plain.match(/[A-Za-z]+/g) || []).filter((w) => w !== 'm' && w !== 'M');
    const letters = words.join('');
    if (isUpper(letters)) return 'I AM NOT JOKING';
    if (words.length > 1 && words.every((w) => isCap(w))) return 'I Am Not Joking';
    return (match[0] === 'i' ? 'i' : 'I') + ' am not joking';
  }

  // "I am not joking" in the style of the identifier words it replaces.
  function jokeIdentifier(ws) {
    const span = ws.map((w) => w.text).join('');
    const upper = isUpper(span);
    if (ws.length === 1) return upper ? 'IAMNOTJOKING' : (isCap(span) ? 'Iamnotjoking' : 'iamnotjoking');
    const sepWord = ws.slice(1).find((w) => /^[_-]+$/.test(w.sep));
    const sep = sepWord ? sepWord.sep : '';
    if (upper) return JOKE_WORDS.map((w) => w.toUpperCase()).join(sep);
    if (sep) {
      const title = ws.every((w) => isCap(w.text));
      return JOKE_WORDS.map((w) => (title ? capitalize(w) : w)).join(sep);
    }
    return (isCap(ws[0].text) ? 'I' : 'i') + 'AmNotJoking';
  }

  function styled(word, model) {
    if (isUpper(model)) return word.toUpperCase();
    if (isCap(model)) return word[0].toUpperCase() + word.slice(1);
    return word;
  }

  // ---- Prose -------------------------------------------------------------

  function jokeEdits(str, base, out) {
    JOKE_RE.lastIndex = 0;
    let m;
    while ((m = JOKE_RE.exec(str))) {
      const text = jokeProse(m[0]);
      if (text !== m[0]) out.push({ index: base + m.index, length: m[0].length, text, count: 1 });
    }
  }

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
        out.push({ index: base + nounStart + 5, length: 0, text: ' ' + being, count: 1 });
      } else if (g.art) {
        out.push({ index: base + nounStart + 5, length: 0, text: ' ' + being, count: 1 });
      } else if (plural) {
        out.push({ index: base + nounStart + 5, length: 0, text: ' ' + being + styled('s', noun), count: 1 });
      } else {
        // "I am human" → "I am a human being"
        const at = g.adj ? m.indices.groups.adj[0] : nounStart;
        const prevWord = (str.slice(0, at).match(/([A-Za-z]+)\W*$/) || [])[1] || '';
        let article = 'a';
        if (isUpper(noun)) article = 'A';
        else if (isCap(noun) && prevWord && isCap(prevWord) && prevWord.toLowerCase() !== 'i') article = 'A';
        out.push({ index: base + at, length: 0, text: article + ' ', count: 0 });
        out.push({ index: base + nounStart + 5, length: 0, text: ' ' + being, count: 1 });
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

  const matchSeq = (words, j, seqs) => seqs.find((seq) => seq.every((w, i) => words[j + i] && words[j + i].lower === w));

  // Skips an optional adverb and article; returns the index of the next word.
  function afterSubject(words, k) {
    if (words[k] && ID_ADVERBS.has(words[k].lower)) k++;
    if (words[k] && (words[k].lower === 'a' || words[k].lower === 'an')) k++;
    return k;
  }

  function identifierEdits(str, base, jokes, others) {
    TOKEN_RE.lastIndex = 0;
    let t;
    while ((t = TOKEN_RE.exec(str))) {
      const token = t[0];
      if (!HUMAN_RE.test(token)) continue;
      const tStart = t.index;
      const tEnd = tStart + token.length;
      // Leave URL/file paths alone: /api/i-am-a-human, ./i-am-a-bot/...
      if (str[tStart - 1] === '/' || str[tEnd] === '/') continue;

      const words = splitWords(token);
      const stopAfter = (idx) => words[idx + 1] && STOP_SET.has(words[idx + 1].lower);

      for (let j = 0; j < words.length; j++) {
        // 1. First person → "iAmNotJoking"
        let last = -1;
        if (ID_GLUED_JOKE_RE.test(words[j].text)) {
          last = j;
        } else if (matchSeq(words, j, ID_FIRST_PERSON)) {
          const k = afterSubject(words, j + matchSeq(words, j, ID_FIRST_PERSON).length);
          if (words[k] && ID_JOKE_NOUNS.has(words[k].lower)) {
            last = words[k].lower === 'human' && words[k + 1] && words[k + 1].lower === 'being' ? k + 1 : k;
          }
        }
        if (last >= 0) {
          if (stopAfter(last)) continue;
          const ws = words.slice(j, last + 1);
          const text = jokeIdentifier(ws);
          const from = words[j].start;
          const to = words[last].end;
          if (token.slice(from, to) !== text) {
            jokes.push({ index: base + tStart + from, length: to - from, text, count: 1 });
          }
          j = last;
          continue;
        }

        // 2. Other subjects → "areYouHumanBeing"
        let nounIdx = -1;
        const glued = ID_GLUED_RE.exec(words[j].text);
        if (glued) {
          nounIdx = j;
        } else {
          const seq = matchSeq(words, j, ID_OTHER_SUBJECTS);
          if (seq) {
            const k = afterSubject(words, j + seq.length);
            if (words[k] && (words[k].lower === 'human' || words[k].lower === 'humans')) nounIdx = k;
          }
        }
        if (nounIdx < 0 || stopAfter(nounIdx)) continue;

        const w = words[nounIdx];
        const model = glued ? glued[1] : w.text;
        const sep = !glued && /^[_-]+$/.test(w.sep) ? w.sep : '';
        const insertAt = /s$/i.test(model) ? w.end - 1 : w.end;
        others.push({ index: base + tStart + insertAt, length: 0, text: sep + styled('being', model), count: 1 });
        j = nounIdx;
      }
    }
  }

  // ---- Public API --------------------------------------------------------

  const FULL = Object.freeze({ prose: true, identifiers: true });

  /**
   * Returns the sorted, non-overlapping edits ({ index, length, text, count })
   * that rewrite `str`. Empty when nothing needs to change.
   */
  function findEdits(str, opts) {
    if (typeof str !== 'string' || !HUMAN_RE.test(str)) return [];
    opts = opts || FULL;
    const jokes = [];
    const others = [];
    const scan = (segment, base) => {
      if (!HUMAN_RE.test(segment)) return;
      if (opts.prose !== false) {
        jokeEdits(segment, base, jokes);
        proseInsertions(segment, base, others);
      }
      if (opts.identifiers !== false) identifierEdits(segment, base, jokes, others);
    };
    PROTECT_RE.lastIndex = 0;
    let last = 0;
    let p;
    while ((p = PROTECT_RE.exec(str))) {
      scan(str.slice(last, p.index), last);
      last = p.index + p[0].length;
    }
    scan(str.slice(last), last);

    // "I am a human" is matched by both rules; the "I am not joking" one wins.
    const out = jokes.concat(others.filter((e) => !jokes.some((j) => e.index >= j.index && e.index <= j.index + j.length)));
    return out.sort((a, b) => a.index - b.index);
  }

  function applyEdits(str, edits) {
    if (!edits.length) return str;
    let res = '';
    let last = 0;
    for (const e of edits) {
      res += str.slice(last, e.index) + e.text;
      last = e.index + (e.length || 0);
    }
    return res + str.slice(last);
  }

  const countOf = (edits) => edits.reduce((n, e) => n + (e.count === undefined ? 1 : e.count), 0);

  /** Returns { text, count }. */
  function rewrite(str, opts) {
    const edits = findEdits(str, opts);
    if (!edits.length) return { text: str, count: 0 };
    return { text: applyEdits(str, edits), count: countOf(edits) };
  }

  /** Convenience: returns just the rewritten string. */
  function rewriteText(str, opts) {
    return rewrite(str, opts).text;
  }

  return {
    findEdits,
    applyEdits,
    countOf,
    rewrite,
    rewriteText,
    mightMatch: (s) => typeof s === 'string' && HUMAN_RE.test(s),
    FULL,
    PROSE_ONLY: Object.freeze({ prose: true, identifiers: false }),
  };
});
