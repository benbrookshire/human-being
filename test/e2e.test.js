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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

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

    assert.equal(await page.title(), 'I am a human being');
    assert.equal(await text(page, '#h1'), 'I am a human being');
    assert.equal(await text(page, '#split'), 'Hello, I am a human being!');
    assert.equal(await page.$eval('#split b', (b) => b.textContent), 'human being');
    assert.equal(await text(page, '#contraction'), 'I’m only a human being, after all.');
    assert.equal(await text(page, '#caps'), 'I AM A HUMAN BEING');
    assert.equal(await text(page, '#code'), 'const iAmAHumanBeing = true; // i_am_a_human_being, I-AM-A-HUMAN-BEING');
    assert.equal(await page.$eval('#img', (e) => e.alt), 'I am a human being');
    assert.equal(await page.$eval('#input', (e) => e.placeholder), 'I am a human being');
    assert.equal(await page.$eval('#link', (e) => e.title), 'Are you a human being?');
    assert.equal(await page.$eval('#link', (e) => e.getAttribute('href')), '/i-am-a-human', 'URLs untouched');
    assert.equal(await text(page, '#dynamic'), 'We are human beings');
    assert.equal(await page.evaluate(() => window.__shadow()), 'I am a human being', 'closed shadow root');
    const comment = await page.evaluate(() => [...document.body.childNodes].find((n) => n.nodeType === 8).data);
    assert.equal(comment.trim(), 'I am a human being');
    assert.ok(!(await page.content()).match(/I am a human(?! being)/), 'serialized DOM fully rewritten');

    // Console output.
    assert.ok(logs.includes('I am a human being'), logs.join('\n'));
    assert.ok(logs.filter((l) => l === 'I am a human being').length >= 2, 'format-string log joined + rewritten');
    assert.ok(logs.some((l) => /Error: I am a human being/.test(l)), 'errors rewritten');
    // Typed into the console at runtime:
    const live = [];
    page.on('console', (m) => live.push(m.text()));
    await page.evaluate(() => console.log('i am human', 'iAmAHuman'));
    await page.waitForTimeout(50);
    assert.deepEqual(live, ['i am a human being iAmAHumanBeing']);

    // Standard mode deliberately leaves structural identifiers/JS alone.
    assert.equal(await page.$eval('#styled', (e) => e.className), 'i-am-a-human');
    assert.equal(await page.$eval('#styled', (e) => getComputedStyle(e).color), 'rgb(255, 0, 0)');
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
    assert.equal(await page.evaluate(() => window.msg), 'I am a human being');
    assert.equal(await page.evaluate(() => typeof iAmAHumanBeing), 'function');
    assert.equal(await page.evaluate(() => typeof window.iAmAHuman), 'undefined');
    assert.equal(await page.evaluate(() => window.I_AM_A_HUMAN_BEING), 'yes');
    assert.equal(await page.evaluate(() => window.fromApp), 'I am a human being');
    assert.equal(await page.evaluate(() => iAmAHumanBeing.toString()), 'function iAmAHumanBeing() { return "I am a human being"; }');
    assert.equal(await page.evaluate(() => window.fetched).then((t) => t.trim()), '{"iAmAHumanBeing": true, "message": "I am a human being"}');

    // Raw HTML source as the page sees it.
    const source = await page.evaluate(() => document.documentElement.outerHTML);
    assert.ok(!/I am a human(?! being)/.test(source));
    assert.ok(source.includes('href="/i-am-a-human"'), 'links still point to the original URL');

    // CSS and class names stay consistent with each other.
    assert.equal(await page.$eval('#styled', (e) => e.className), 'i-am-a-human-being');
    assert.equal(await page.$eval('#styled', (e) => getComputedStyle(e).color), 'rgb(255, 0, 0)');

    assert.ok(logs.includes('I am a human being'));
    assert.ok(!logs.some((l) => /I am a human(?! being)/.test(l)), logs.join('\n'));

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

test('disabled: nothing is touched', async () => {
  const { context, sw } = await launch();
  try {
    await setMode(sw, { enabled: false, deep: false });
    const { page } = await openFixture(context, base);
    assert.equal(await text(page, '#h1'), 'I am a human');
    assert.equal(await page.evaluate(() => window.msg), 'I am a human');
    await page.close();
  } finally {
    await context.close();
  }
});
