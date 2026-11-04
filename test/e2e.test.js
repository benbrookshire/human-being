'use strict';
/*
 * Loads the unpacked extension into Chromium and checks a real page.
 * Requires Playwright (`require('playwright')`) and a Chromium build.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain' };

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(FIXTURES, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  // Wait for onInstalled to register the page scripts.
  for (let i = 0; i < 100; i++) {
    const n = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((s) => s.length));
    if (n === 2) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { context, sw };
}

async function setMode(sw, settings) {
  await sw.evaluate(async (s) => { await chrome.storage.local.set(s); await apply(); }, settings);
}

async function openFixture(context, url) {
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => typeof window.fetched === 'string');
  await page.waitForTimeout(200);
  return { page, logs };
}

const text = (page, sel) => page.$eval(sel, (el) => el.textContent);

let server, base;
test.before(async () => {
  server = await serve();
  base = `http://127.0.0.1:${server.address().port}/`;
});
test.after(() => server.close());

test('standard mode: visible text, attributes and console', async () => {
  const { context, sw } = await launch();
  try {
    await setMode(sw, { enabled: true, deep: false });
    const { page, logs } = await openFixture(context, base);

    const J = 'I am not joking';
    assert.equal(await page.title(), J);
    assert.equal(await text(page, '#h1'), J);
    assert.equal(await text(page, '#bot'), J + '.');
    assert.equal(await text(page, '#notbot'), J + '.');
    assert.equal(await text(page, '#split'), 'Hello, I am not joking!', 'phrase split across elements');
    assert.equal(await text(page, '#contraction'), J + ', after all.');
    assert.equal(await text(page, '#caps'), 'I AM NOT JOKING');
    assert.equal(await text(page, '#other'), 'Are you a human being?');
    assert.equal(await text(page, '#code'), 'const iAmNotJoking = true; // i_am_not_joking, I-AM-NOT-JOKING');
    assert.equal(await page.$eval('#img', (e) => e.alt), J);
    assert.equal(await page.$eval('#input', (e) => e.placeholder), J);
    assert.equal(await page.$eval('#input', (e) => e.value), J);
    assert.equal(await page.$eval('#link', (e) => e.title), J);
    assert.equal(await page.$eval('#link', (e) => e.getAttribute('href')), '/i-am-a-bot', 'URLs untouched');
    assert.equal(await text(page, '#dynamic'), J);
    assert.equal(await page.evaluate(() => window.__shadow()), J, 'closed shadow root');
    const comment = await page.evaluate(() => [...document.body.childNodes].find((n) => n.nodeType === 8).data);
    assert.equal(comment.trim(), J);
    assert.ok(!/I am (not )?a (human|bot)/.test(await page.evaluate(() => document.body.innerText)), 'visible text fully rewritten');

    // Console output.
    assert.ok(logs.filter((l) => l === J).length >= 2, 'plain + format-string logs: ' + logs.join(' | '));
    assert.ok(logs.some((l) => /Error: I am not joking/.test(l)), 'errors rewritten');
    const live = [];
    page.on('console', (m) => live.push(m.text()));
    await page.evaluate(() => console.log('i am a', 'bot', 'iAmAHuman'));
    await page.waitForTimeout(50);
    assert.deepEqual(live, ['i am not joking iAmNotJoking']);

    // Standard mode deliberately leaves structural identifiers/JS alone.
    assert.equal(await page.$eval('#styled', (e) => e.className), 'i-am-a-bot');
    assert.equal(await page.$eval('#styled', (e) => getComputedStyle(e).color), 'rgb(255, 0, 0)');
    // …but sentences inside scripts are rewritten (that's safe).
    assert.equal(await page.evaluate(() => typeof iAmAHuman), 'function');
    assert.equal(await page.evaluate(() => window.msg), J);
    await page.close();
  } finally {
    await context.close();
  }
});

test('deep mode: JS identifiers, variables, CSS and network data', async () => {
  const { context, sw } = await launch();
  try {
    await setMode(sw, { enabled: true, deep: true });
    const { page, logs } = await openFixture(context, base);

    // JS state as seen from the console.
    const J = 'I am not joking';
    assert.equal(await page.evaluate(() => window.msg), J);
    assert.equal(await page.evaluate(() => typeof iAmNotJoking), 'function');
    assert.equal(await page.evaluate(() => typeof window.iAmAHuman), 'undefined');
    assert.equal(await page.evaluate(() => window.I_AM_NOT_JOKING), 'yes');
    assert.equal(await page.evaluate(() => window.fromApp), J);
    assert.equal(await page.evaluate(() => iAmNotJoking.toString()), 'function iAmNotJoking() { return "I am not joking"; }');
    assert.equal(await page.evaluate(() => window.fetched).then((t) => t.trim()), '{"iAmNotJoking": true, "message": "I am not joking"}');

    // Raw HTML source as the page sees it.
    const source = await page.evaluate(() => document.documentElement.outerHTML);
    assert.ok(!/I am (not )?a (human|bot)/.test(source));
    assert.ok(source.includes('href="/i-am-a-bot"'), 'links still point to the original URL');

    // CSS and class names stay consistent with each other.
    assert.equal(await page.$eval('#styled', (e) => e.className), 'i-am-not-joking');
    assert.equal(await page.$eval('#styled', (e) => getComputedStyle(e).color), 'rgb(255, 0, 0)');

    assert.ok(logs.includes(J));
    assert.ok(!logs.some((l) => /I am (not )?a (human|bot)/.test(l)), logs.join('\n'));

    const status = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
      return { attached: tabs.get(tab.id)?.attached, net: tabs.get(tab.id)?.net };
    });
    assert.equal(status.attached, true);
    assert.ok(status.net > 0, 'network rewrites counted');
    await page.close();
  } finally {
    await context.close();
  }
});

for (const deep of [false, true]) {
  test(`late changes after page load (${deep ? 'deep' : 'standard'} mode)`, async () => {
    const { context, sw } = await launch();
    try {
      await setMode(sw, { enabled: true, deep });
      const page = await context.newPage();
      await page.goto(base + 'late.html');
      await page.waitForFunction(() => window.lateDone === true, null, { timeout: 10000 });
      await page.waitForTimeout(300);
      const J = 'I am not joking';

      assert.equal(await text(page, '#html'), 'Hello! I am not joking.', 'innerHTML set by a timer');
      assert.equal(await text(page, '#inplace'), J, 'existing text node changed in place');
      assert.equal(await text(page, '#append'), J, 'append(string)');
      assert.equal(await text(page, '#split'), J, 'phrase completed later by a new element');
      assert.equal(await page.$eval('#attr', (e) => e.title), J, 'attribute set via property');
      assert.equal(await text(page, '#fetched'), J, 'text fetched after load');
      assert.equal(await text(page, '#later'), 'Much later: I am not joking.', 'content added 2s after load');
      const frame = page.frames().find((f) => f !== page.mainFrame());
      await frame.waitForSelector('#in-frame');
      assert.equal(await frame.$eval('#in-frame', (e) => e.textContent), J, 'iframe added after load');

      // A framework keeps updating one of two text nodes in the phrase.
      const fw = () => text(page, '#framework');
      assert.equal(await fw(), J);
      await page.evaluate(() => fwStep('human'));
      await page.waitForTimeout(50);
      assert.equal(await fw(), J, 'still rewritten after the framework changes the noun');
      await page.evaluate(() => fwStep('cat'));
      await page.waitForTimeout(50);
      assert.equal(await fw(), 'I am a cat', 'restored when the phrase no longer matches');
      await page.evaluate(() => fwStep('bot'));
      await page.waitForTimeout(50);
      assert.equal(await fw(), J, 'rewritten again');
      await page.close();
    } finally {
      await context.close();
    }
  });
}

test('highlights "not a robot" checkboxes for keyboard use, never ticks them', async () => {
  const { context, sw } = await launch();
  try {
    await setMode(sw, { enabled: true, deep: false, highlight: true });
    const page = await context.newPage();
    const MARK = 'data-not-a-joke-highlight';

    await page.goto(base + 'checkbox.html');
    await page.waitForFunction((m) => document.getElementById('robot')?.hasAttribute(m), MARK, { timeout: 5000 });
    assert.equal(await page.$eval('#robot', (e) => e.checked), false, 'never ticked automatically');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'robot', 'has keyboard focus');
    assert.equal(await page.$eval('#robot', (e) => getComputedStyle(e).outlineStyle), 'solid');
    assert.equal(await page.$eval('#remember', (e) => e.hasAttribute('data-not-a-joke-highlight')), false, 'unrelated box ignored');
    await page.keyboard.press('Space');
    assert.equal(await page.$eval('#robot', (e) => e.checked), true, 'Space ticks it');
    await page.waitForTimeout(50);
    assert.equal(await page.$eval('#robot', (e) => e.style.outline), '', 'highlight removed once ticked');

    // A visually hidden, custom-styled checkbox: outline its label instead.
    await page.goto(base + 'checkbox.html?fancy');
    await page.waitForFunction((m) => document.getElementById('robot')?.hasAttribute(m), MARK, { timeout: 5000 });
    assert.equal(await page.$eval('#fancy-label', (e) => getComputedStyle(e).outlineStyle), 'solid');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'robot');

    // Never steal focus from a field the person is typing in.
    await page.goto(base + 'checkbox.html?typing');
    await page.waitForFunction((m) => document.getElementById('robot')?.hasAttribute(m), MARK, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'search');

    // Switched off in the popup: nothing happens.
    await setMode(sw, { enabled: true, deep: false, highlight: false });
    await page.goto(base + 'checkbox.html');
    await page.waitForFunction(() => window.ready);
    await page.waitForTimeout(600);
    assert.equal(await page.$eval('#robot', (e) => e.hasAttribute('data-not-a-joke-highlight')), false);
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'robot');
    await page.close();
  } finally {
    await context.close();
  }
});

test('highlights the matching continue/submit button, never clicks it', async () => {
  const { context, sw } = await launch();
  try {
    await setMode(sw, { enabled: true, deep: false, highlight: true });
    const page = await context.newPage();
    const BTN = 'data-not-a-joke-button';
    const marked = (sel) => page.$eval(sel, (e, m) => e.hasAttribute(m), BTN);
    const waitMarked = (sel) => page.waitForFunction(([s, m]) => document.querySelector(s)?.hasAttribute(m), [sel, BTN], { timeout: 5000 });

    // Checkbox without a form: the nearby "Continue" button.
    await page.goto(base + 'checkbox.html');
    await waitMarked('#continue');
    assert.equal(await page.$eval('#continue', (e) => getComputedStyle(e).outlineStyle), 'solid');
    assert.notEqual(await page.$eval('#continue', (e) => getComputedStyle(e).animationName), 'none', 'pulses');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'robot', 'focus stays on the checkbox');

    // Checkbox in a form: that form's "Verify" button, not "Cancel" or the outside "Continue".
    await page.goto(base + 'checkbox.html?form');
    await waitMarked('#verify');
    assert.equal(await marked('#cancel'), false);
    assert.equal(await marked('#continue'), false);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.submitted), undefined, 'never submitted automatically');
    await page.keyboard.press('Space');
    await page.click('#verify');
    assert.equal(await page.evaluate(() => window.submitted), true, 'the person can submit');
    assert.equal(await marked('#verify'), false, 'highlight removed once clicked');
    await page.waitForTimeout(400);
    assert.equal(await marked('#verify'), false, 'and not re-added');

    // Check page with no checkbox (Amazon-style): "Continue shopping".
    await page.goto(base + 'botcheck.html');
    await waitMarked('#shop');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.submitted), undefined, 'never clicked automatically');

    // An ordinary page with a Continue button is left alone.
    await page.goto(base + 'plain.html');
    await page.waitForTimeout(600);
    assert.equal(await marked('#continue'), false);

    // Switched off: no button highlight either.
    await setMode(sw, { enabled: true, deep: false, highlight: false });
    await page.goto(base + 'botcheck.html');
    await page.waitForTimeout(600);
    assert.equal(await marked('#shop'), false);
    await page.close();
  } finally {
    await context.close();
  }
});

test('disabled: nothing is touched', async () => {
  const { context, sw } = await launch();
  try {
    await setMode(sw, { enabled: false, deep: false });
    const { page } = await openFixture(context, base);
    assert.equal(await text(page, '#h1'), 'I am a human');
    assert.equal(await page.evaluate(() => window.msg), 'I am a bot');
    await page.close();
  } finally {
    await context.close();
  }
});
