'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rewriter.js');

const rw = (s, o) => R.rewriteText(s, o);
const check = (cases) => {
  for (const [input, expected] of Object.entries(cases)) assert.equal(rw(input), expected, input);
};
const same = (list) => {
  for (const s of list) assert.equal(rw(s), s, s);
};

test('first person, human or bot → "I am not joking"', () => {
  check({
    'I am a bot': 'I am not joking',
    'I am a human': 'I am not joking',
    'I am not a bot': 'I am not joking',
    'I am not a human': 'I am not joking',
    'I am a human being': 'I am not joking',
    'I am a robot': 'I am not joking',
    "I'm not a robot": 'I am not joking',
    'I’m a bot!': 'I am not joking!',
    'Im a bot': 'I am not joking',
    'I am human.': 'I am not joking.',
    "I'm only human": 'I am not joking',
    'I am just a real human': 'I am not joking',
    'I am, after all, a bot': 'I am not joking',
    'I am 100% human': 'I am not joking',
    'I am a\nbot': 'I am not joking',
    'Hello! I am a bot, nice to meet you.': 'Hello! I am not joking, nice to meet you.',
  });
});

test('"I am not joking" keeps the casing', () => {
  check({
    'i am a bot': 'i am not joking',
    'I AM A BOT': 'I AM NOT JOKING',
    "I'M NOT A ROBOT": 'I AM NOT JOKING',
    'I Am A Human': 'I Am Not Joking',
    'I am a Human': 'I am not joking',
  });
});

test('raw HTML / JS source forms', () => {
  check({
    'I&#39;m a bot': 'I am not joking',
    'I&rsquo;m&nbsp;not&nbsp;a&nbsp;robot': 'I am not joking',
    "'I\\'m a bot'": "'I am not joking'",
    '"I am a human"': '"I am not joking"',
  });
});

test('other people still get "human being"', () => {
  check({
    'Are you human?': 'Are you a human being?',
    'Am I a human?': 'Am I a human being?',
    'You are a fellow human': 'You are a fellow human being',
    "We're all humans": "We're all human beings",
    'We are human': 'We are human beings',
    "She's a human": "She's a human being",
    'We are humans. I am a bot.': 'We are human beings. I am not joking.',
  });
});

test('leaves non-matches alone', () => {
  same([
    'I am not joking',
    'I AM NOT JOKING',
    'Are you a human being?',
    'I am a human resources manager',
    'I am a bot developer',
    "I'm a robot vacuum owner",
    'I work in human rights',
    'I am humane',
    'I am a humanoid robot',
    'I am a human-made machine',
    'I am a bottle',
    'robots.txt',
    'both of us',
    'Hi am a bot',
    'It is a bot',
    'Are you a bot?',
    'Who are you, human?',
  ]);
});

test('idempotent', () => {
  for (const s of ['I am human', 'I am a bot', 'We are human', 'Are you human?', 'iAmABot i_am_a_human areYouHuman']) {
    const once = rw(s);
    assert.equal(rw(once), once, s);
  }
});

test('identifiers: first person → iAmNotJoking, in every casing convention', () => {
  check({
    iAmABot: 'iAmNotJoking',
    iAmAHuman: 'iAmNotJoking',
    iAmNotABot: 'iAmNotJoking',
    iAmAHumanBeing: 'iAmNotJoking',
    IAmARobot: 'IAmNotJoking',
    iAmHuman: 'iAmNotJoking',
    imABot: 'iAmNotJoking',
    i_am_a_bot: 'i_am_not_joking',
    i_am_not_a_bot: 'i_am_not_joking',
    I_AM_A_HUMAN: 'I_AM_NOT_JOKING',
    I_AM_A_HUMAN_BEING: 'I_AM_NOT_JOKING',
    'i-am-a-robot': 'i-am-not-joking',
    'I-Am-A-Bot': 'I-Am-Not-Joking',
    iamabot: 'iamnotjoking',
    IAMAHUMAN: 'IAMNOTJOKING',
    isIAmABotFlag: 'isIAmNotJokingFlag',
    user_i_am_a_human_2: 'user_i_am_not_joking_2',
    $iAmABot: '$iAmNotJoking',
  });
});

test('identifiers: other subjects still get "Being"', () => {
  check({
    areYouHuman: 'areYouHumanBeing',
    weAreHumans: 'weAreHumanBeings',
    we_are_humans: 'we_are_human_beings',
    youAreAHuman: 'youAreAHumanBeing',
  });
});

test('identifiers: leaves non-matches alone', () => {
  same(['iAmNotJoking', 'iAmABotDeveloper', 'iAmAHumanResources', 'isBot', 'isHuman', 'robotFactory', 'piAmBot', 'areYouHumanBeing']);
});

test('identifiers inside code', () => {
  assert.equal(
    rw('function iAmABot() { return I_AM_A_HUMAN; } obj.i_am_not_a_bot = iAmABot();'),
    'function iAmNotJoking() { return I_AM_NOT_JOKING; } obj.i_am_not_joking = iAmNotJoking();'
  );
  assert.equal(rw('.i-am-a-human { color: red }'), '.i-am-not-joking { color: red }');
  assert.equal(rw('{"iAmABot":true,"msg":"I am a bot"}'), '{"iAmNotJoking":true,"msg":"I am not joking"}');
  // Minified code must never be broken by the prose matcher.
  same(['function(i,am,bot){return i+am+bot}', 'function(i,am,human){return i+am+human}']);
});

test('protected regions: URLs and paths are untouched', () => {
  same([
    'https://example.com/i-am-a-bot',
    '<a href="i-am-a-human.html">link</a>',
    "<img src='iAmABot.png'>",
    'fetch("/api/i-am-a-bot")',
    'background: url(img/i-am-a-human.png)',
  ]);
  assert.equal(
    rw('<a href="/i-am-a-bot" title="I am a bot">I am a human</a>'),
    '<a href="/i-am-a-bot" title="I am not joking">I am not joking</a>'
  );
  // An identifier glued to a URL key in minified code is NOT masked.
  assert.equal(rw('{data:iAmABot}'), '{data:iAmNotJoking}');
});

test('prose-only mode skips identifiers', () => {
  assert.equal(rw('I am a bot; iAmABot', R.PROSE_ONLY), 'I am not joking; iAmABot');
});

test('edits are replace-or-insert on the original string', () => {
  assert.deepEqual(R.findEdits('Hi, I am a bot!'), [{ index: 4, length: 10, text: 'I am not joking', count: 1 }]);
  assert.deepEqual(R.findEdits('Are you human?'), [
    { index: 8, length: 0, text: 'a ', count: 0 },
    { index: 13, length: 0, text: ' being', count: 1 },
  ]);
});

test('rewrite() reports a count', () => {
  assert.deepEqual(R.rewrite('I am a bot. iAmAHuman. Are you human?'), {
    text: 'I am not joking. iAmNotJoking. Are you a human being?',
    count: 3,
  });
  assert.deepEqual(R.rewrite('nope'), { text: 'nope', count: 0 });
});
