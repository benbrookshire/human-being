'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rewriter.js');

const rw = (s, o) => R.rewriteText(s, o);

test('prose: the core phrase and its common variants', () => {
  const cases = {
    'I am a human': 'I am a human being',
    'I am a human.': 'I am a human being.',
    "I'm a human": "I'm a human being",
    'I’m a human!': 'I’m a human being!',
    'Im a human': 'Im a human being',
    'i am a human': 'i am a human being',
    'I AM A HUMAN': 'I AM A HUMAN BEING',
    'I Am A Human': 'I Am A Human Being',
    'I am human': 'I am a human being',
    "I'm only human": "I'm only a human being",
    'I am not a human': 'I am not a human being',
    'I am just a real human': 'I am just a real human being',
    'I am, after all, a human': 'I am, after all, a human being',
    'I am 100% human': 'I am 100% a human being',
    'Am I a human?': 'Am I a human being?',
    'Are you human?': 'Are you a human being?',
    'You are a fellow human': 'You are a fellow human being',
    "We're all humans": "We're all human beings",
    'We are human': 'We are human beings',
    'They are humans': 'They are human beings',
    "She's a human": "She's a human being",
    'I am a\nhuman': 'I am a\nhuman being',
    'Hello! I am a human, nice to meet you.': 'Hello! I am a human being, nice to meet you.',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(rw(input), expected, input);
});

test('prose: raw HTML / JS source forms', () => {
  assert.equal(rw('I&#39;m a human'), 'I&#39;m a human being');
  assert.equal(rw('I&rsquo;m&nbsp;a&nbsp;human'), 'I&rsquo;m&nbsp;a&nbsp;human being');
  assert.equal(rw("'I\\'m a human'"), "'I\\'m a human being'");
  assert.equal(rw('"I am a human"'), '"I am a human being"');
});

test('prose: leaves non-matches alone', () => {
  const same = [
    'I am a human being',
    'I am a Human Being',
    'I AM A HUMAN BEING',
    "I'm a human-being",
    'I am a human resources manager',
    'I work in human rights',
    'I am humane',
    'I am a humanoid robot',
    'I am a human-made machine',
    'Hi am a human',
    'It is a human',
    'human',
    'humanity is great',
    'nothing to see here',
    'Who are you, human?',
  ];
  for (const s of same) assert.equal(rw(s), s, s);
});

test('prose: idempotent', () => {
  for (const s of ['I am human', 'We are human', "I'm a HUMAN", 'Are you human?', 'iAmAHuman i_am_a_human']) {
    const once = rw(s);
    assert.equal(rw(once), once, s);
  }
});

test('identifiers: every casing convention', () => {
  const cases = {
    iAmAHuman: 'iAmAHumanBeing',
    IAmAHuman: 'IAmAHumanBeing',
    iAmHuman: 'iAmHumanBeing',
    imAHuman: 'imAHumanBeing',
    i_am_a_human: 'i_am_a_human_being',
    I_AM_A_HUMAN: 'I_AM_A_HUMAN_BEING',
    'i-am-a-human': 'i-am-a-human-being',
    iamahuman: 'iamahumanbeing',
    IAMAHUMAN: 'IAMAHUMANBEING',
    isIAmAHumanFlag: 'isIAmAHumanBeingFlag',
    user_i_am_a_human_2: 'user_i_am_a_human_being_2',
    areYouHuman: 'areYouHumanBeing',
    weAreHumans: 'weAreHumanBeings',
    we_are_humans: 'we_are_human_beings',
    iAmNotAHuman: 'iAmNotAHumanBeing',
    $iAmAHuman: '$iAmAHumanBeing',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(rw(input), expected, input);
});

test('identifiers: leaves non-matches alone', () => {
  const same = ['iAmAHumanBeing', 'i_am_a_human_being', 'iAmAHumanResources', 'isHuman', 'humanize', 'piAmHuman', 'IAMAHUMANBEING'];
  for (const s of same) assert.equal(rw(s), s, s);
});

test('identifiers inside code', () => {
  assert.equal(
    rw('function iAmAHuman() { return I_AM_A_HUMAN; } obj.i_am_a_human = iAmAHuman();'),
    'function iAmAHumanBeing() { return I_AM_A_HUMAN_BEING; } obj.i_am_a_human_being = iAmAHumanBeing();'
  );
  assert.equal(rw('.i-am-a-human { color: red }'), '.i-am-a-human-being { color: red }');
  assert.equal(rw('{"iAmAHuman":true,"msg":"I am a human"}'), '{"iAmAHumanBeing":true,"msg":"I am a human being"}');
  // Minified code must never be broken by the prose matcher.
  assert.equal(rw('function(i,am,human){return i+am+human}'), 'function(i,am,human){return i+am+human}');
});

test('protected regions: URLs and paths are untouched', () => {
  const same = [
    'https://example.com/i-am-a-human',
    '<a href="i-am-a-human.html">link</a>',
    "<img src='iAmAHuman.png'>",
    'fetch("/api/i-am-a-human")',
    'background: url(img/i-am-a-human.png)',
  ];
  for (const s of same) assert.equal(rw(s), s, s);
  assert.equal(
    rw('<a href="/i-am-a-human" title="I am a human">I am a human</a>'),
    '<a href="/i-am-a-human" title="I am a human being">I am a human being</a>'
  );
  // An identifier glued to a URL key in minified code is NOT masked.
  assert.equal(rw('{data:iAmAHuman}'), '{data:iAmAHumanBeing}');
});

test('prose-only mode skips identifiers', () => {
  assert.equal(rw('I am a human; iAmAHuman', R.PROSE_ONLY), 'I am a human being; iAmAHuman');
});

test('insertions work across split text (DOM-node friendly)', () => {
  const parts = ['I am a ', 'human', '!'];
  const ins = R.findInsertions(parts.join(''));
  assert.deepEqual(ins, [{ index: 12, text: ' being' }]);
});

test('rewrite() reports a count', () => {
  assert.deepEqual(R.rewrite('I am human. iAmAHuman.'), { text: 'I am a human being. iAmAHumanBeing.', count: 2 });
  assert.deepEqual(R.rewrite('nope'), { text: 'nope', count: 0 });
});
