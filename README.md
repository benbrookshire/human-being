# This Is Not a Joke

A Chrome extension that rewrites **“I am a human”**, **“I am a bot”** and **“I am not a bot”** to **“I am not joking”**. It works in page text, in code identifiers, and in what you see in DevTools, including text that JavaScript adds or changes after the page has loaded.

| Before | After |
| --- | --- |
| I am a human / I am a bot / I am not a bot | I am not joking |
| I’m not a robot / I’m only human / I am a human being | I am not joking |
| I AM A BOT | I AM NOT JOKING |
| I Am A Human | I Am Not Joking |
| `iAmABot` / `IAmAHuman` / `iAmNotABot` | `iAmNotJoking` / `IAmNotJoking` / `iAmNotJoking` |
| `i_am_a_bot` / `I_AM_A_HUMAN` / `i-am-a-robot` | `i_am_not_joking` / `I_AM_NOT_JOKING` / `i-am-not-joking` |

Phrases about other people still get the original treatment: “Are you human?” → “Are you a human being?”, `weAreHumans` → `weAreHumanBeings`.

It handles curly apostrophes and HTML entities (`I&rsquo;m not a robot`). It leaves alone things that only look similar: “human resources”, “bot developer”, “robot vacuum”, “humanoid”, `robots.txt`, and URLs, so links keep working.

## Install

1. **Get the files.** On [the GitHub page](https://github.com/benbrookshire/human-being), click **Code → Download ZIP** and unzip it. You get a folder like `human-being-main`. Or clone it: `git clone https://github.com/benbrookshire/human-being.git`.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (switch in the top-right corner).
4. Click **Load unpacked** and choose the folder that contains `manifest.json` (e.g. `human-being-main`).
5. Optional: click the puzzle-piece icon in the toolbar and pin **This Is Not a Joke**.
6. Reload any tabs that were already open.

Keep the folder where it is: Chrome loads the extension from it each time. To update later, replace the folder’s contents (or `git pull`), then click the ↻ reload icon on the extension’s card in `chrome://extensions`.

The toolbar badge counts how many rewrites were made on the current page. Click the icon to pause the extension or switch Deep mode off.

## Text that loads later

The extension keeps watching the page for as long as it’s open. Text added by timers, `fetch`/XHR results, `innerHTML`, `append()`, attribute changes, closed shadow DOM and late-added iframes is rewritten as it appears. It’s also rewritten when part of a phrase arrives separately (`I am a ` now, `<b>bot</b>` a second later).

Frameworks like React often render “I am a {kind}” as two text nodes and later update just one of them. The extension remembers what each text node originally said, so the phrase is re-checked with the page’s real text on every update. If it no longer matches (“I am a cat”), the original wording comes back.

## “Not a robot” checkboxes

When a page shows a checkbox labelled “I’m not a robot”, “I am a human” or similar, the extension outlines it, scrolls it into view and puts keyboard focus on it. Press **Space** to tick it. It works for boxes that appear after the page loads, and for custom-styled boxes (the visible part is outlined).

The button that goes with it gets a pulsing outline, so it’s obvious where to click next. That’s the form’s “Continue”, “Continue shopping”, “Submit”, “Verify” or similar, never “Cancel” or “Back”. This also works on check pages with no checkbox at all, like “Sorry, we just need to make sure you’re not a robot… [Continue shopping]”. Ordinary pages with a Continue button are left alone.

- It **never ticks, clicks or presses anything for you**. Ticking the box and clicking the button are always your own actions. Each highlight goes away once you’ve used it.
- It won’t move focus away from a field you’re typing in. The box is still outlined; press **Tab** to reach it.
- For verification widgets that live in their own frame (reCAPTCHA, hCaptcha, Cloudflare Turnstile), it only outlines the widget. Click it, or **Tab** into it and press **Space**.
- Turn it off with **Highlight “not a robot” boxes** in the popup.

## Two modes

**Standard** rewrites everything you can *see*: text (even when split across elements, like `I am a <b>bot</b>`), titles, tooltips, `alt`/`placeholder`/`aria-*` text, form values, comments, open and closed shadow DOM, canvas text, `alert`/`confirm`/`prompt`, and **console output** (`console.log`, objects, errors, `%s` format strings). It also hooks `textContent`, `innerHTML`, `createTextNode` and similar, so the page’s own code reads back the rewritten text.

**Deep** (on by default) also rewrites the page’s HTML, JavaScript, CSS and JSON *as they download*, using `chrome.debugger`. That way variables, function names, class names, the **Elements**, **Sources** and **Network** panels, and anything you inspect in the **console** all show the rewritten text. It also stays consistent: a CSS rule for `.i-am-a-bot` and the element that uses it are both renamed to `i-am-not-joking`, so nothing breaks.

Chrome shows a “This Is Not a Joke started debugging this browser” bar while Deep mode is on. That’s expected. Clicking **Cancel** on it switches Deep mode off. To hide the bar, start Chrome with `--silent-debugger-extension-api`.

## Good to know

- **What you type into the console is echoed as you typed it.** If you evaluate the literal `"I am a bot"`, DevTools shows your input. Anything that came from the page (DOM, variables, logged values, network responses) is rewritten.
- **Deep mode renames identifiers in data the page sends, too.** If a page’s JavaScript posts `{ "iAmABot": true }` to its server, it will now post `iAmNotJoking`. Turn Deep mode off for sites where that matters.
- Scripts protected by Subresource Integrity or CSP hashes are blocked by Chrome if they contained the phrase and got rewritten.
- Chrome doesn’t let extensions run on `chrome://` pages or the Chrome Web Store.
- If Deep mode attaches too late to catch a page (for example the first page typed into a fresh New Tab), the extension reloads that page once so it’s rewritten from the source.
- Text you type into inputs and editable areas is rewritten when you leave the field, never mid-keystroke.

## How it works

- `src/rewriter.js` is the matching engine. Every rewrite is a list of edits (“replace these characters with this text”). That’s what lets one phrase be fixed across several DOM nodes. First-person matches (“I am not joking”) take priority over the “human being” rule where they overlap.
- `src/page.js` runs in each page’s own JavaScript world at `document_start` and stays active for the life of the page. It does the DOM, hook and console work.
- `src/bridge.js` passes counts from the page to the extension.
- `src/highlight.js` outlines and focuses “not a robot” checkboxes and outlines the button that goes with them.
- `src/background.js` registers the page scripts. In Deep mode it also intercepts text responses with the DevTools Protocol `Fetch` domain (including out-of-process iframes and workers) and fulfils them with the rewritten body.

The page layer deliberately never renames *structural* identifiers itself (class names, identifiers in `<script>` code, HTML strings). Renaming only one copy of an identifier would break the page. Deep mode renames all the copies together at the network layer.

## Development

```sh
npm test            # rewriting engine unit tests (Node 18+)
npm run test:e2e    # loads the extension into Chromium via Playwright
npm run package     # builds this-is-not-a-joke.zip
```
