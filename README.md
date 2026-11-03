# Human Being

A Chrome extension that rewrites anything like **“I am a human”** to **“I am a human being”** — in page text, in code identifiers, and in what you see in DevTools.

| Before | After |
| --- | --- |
| I am a human | I am a human being |
| I’m only human | I’m only a human being |
| I AM A HUMAN | I AM A HUMAN BEING |
| Are you human? | Are you a human being? |
| We’re all humans | We’re all human beings |
| `iAmAHuman` / `IAmAHuman` | `iAmAHumanBeing` / `IAmAHumanBeing` |
| `i_am_a_human` / `I_AM_A_HUMAN` | `i_am_a_human_being` / `I_AM_A_HUMAN_BEING` |
| `i-am-a-human` / `iamahuman` | `i-am-a-human-being` / `iamahumanbeing` |

It keeps your casing, handles curly apostrophes and HTML entities (`I&rsquo;m`), and leaves alone things that only look similar: “human resources”, “human rights”, “humane”, “humanoid”, anything already saying “human being”, and URLs (so links keep working).

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.
3. Reload any tabs that were already open.

The toolbar badge counts how many rewrites were made on the current page.

## Two modes

**Standard** rewrites everything you can *see*: text (even when split across elements, like `I am a <b>human</b>`), titles, tooltips, `alt`/`placeholder`/`aria-*` text, form values, comments, open and closed shadow DOM, canvas text, `alert`/`confirm`/`prompt`, and **console output** (`console.log`, objects, errors, `%s` format strings). It also hooks `textContent`, `innerHTML`, `createTextNode` and similar, so the page’s own code reads back “human being”.

**Deep** (on by default) also rewrites the page’s HTML, JavaScript, CSS and JSON *as they download*, using `chrome.debugger`. That way variables, function names, class names, the **Elements**, **Sources** and **Network** panels, and anything you inspect in the **console** all show “human being”, and it all stays consistent: a CSS rule for `.i-am-a-human` and the element that uses it are renamed together, so nothing breaks.

Chrome shows a “Human Being started debugging this browser” bar while Deep mode is on. That’s expected. Clicking **Cancel** on it switches Deep mode off. To hide the bar, start Chrome with `--silent-debugger-extension-api`.

## Good to know

- **What you type into the console is echoed as you typed it.** If you evaluate the literal `"I am a human"`, DevTools shows your input. Anything that came from the page (DOM, variables, logged values, network responses) shows “human being”.
- **Deep mode renames identifiers in data the page sends, too.** If a page’s JavaScript posts `{ "iAmAHuman": true }` to its server, it will now post `iAmAHumanBeing`. Turn Deep mode off for sites where that matters.
- Scripts protected by Subresource Integrity or CSP hashes are blocked by Chrome if they contained the phrase and got rewritten.
- Chrome doesn’t let extensions run on `chrome://` pages or the Chrome Web Store.
- If Deep mode attaches too late to catch a page (for example the first page typed into a fresh New Tab), the extension reloads that page once so it’s rewritten from the source.
- Text you type into inputs and editable areas is rewritten when you leave the field, never mid-keystroke.

## How it works

- `src/rewriter.js` is the matching engine. Every rewrite is an *insertion* (“being”, plus “a” for “I am human”), never a deletion, which is what lets one phrase be fixed across several DOM nodes.
- `src/page.js` runs in each page’s own JavaScript world at `document_start`. It does the DOM, hook and console work.
- `src/bridge.js` passes counts from the page to the extension.
- `src/background.js` registers the page scripts and, in Deep mode, intercepts text responses with the DevTools Protocol `Fetch` domain (including out-of-process iframes and workers) and fulfils them with the rewritten body.

The page layer deliberately never renames *structural* identifiers itself (class names, `<script>` code, HTML strings). Renaming only one copy of an identifier would break the page. Deep mode renames all the copies together at the network layer.

## Development

```sh
npm test            # rewriting engine unit tests (Node 18+)
npm run test:e2e    # loads the extension into Chromium via Playwright
npm run package     # builds human-being.zip
```
