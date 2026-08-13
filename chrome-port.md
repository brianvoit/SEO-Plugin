# Chrome/Edge support — plan and status

Marketing Inspector was Firefox-only through v1.106: loaded from the repo root,
no build step, signed as an unlisted `.xpi` via AMO, and verified by hand. v2.0
adds Chrome and Edge support, a per-browser build, and a release test suite.

**Status: everything below is implemented and on `main` except Milestone 2
step 9 (Chrome Web Store publishing), which is blocked on store account setup
rather than code.** Outstanding verification is listed at the end.

---

## Milestone 1 — Infrastructure ✅

No user-facing change. `dist/firefox/manifest.json` was diffed against the
manifest that shipped in v1.106 and is semantically identical.

### 1. Manifest split ✅

`manifest.json` became three files, deep-merged at build time:

- `manifest.base.json` — shared keys
- `manifest.firefox.json` — `browser_specific_settings` (the `gecko.id` is
  **required** for `--channel=unlisted` AMO signing), `sidebar_action`,
  `background.scripts`, `commands._execute_sidebar_action`, `menus` +
  `webRequestBlocking`
- `manifest.chrome.json` — `background.service_worker`, `side_panel`,
  `sidePanel` + `contextMenus`, a custom `commands` entry replacing
  `_execute_sidebar_action`, `minimum_chrome_version`

`background` is replace-merged, not deep-merged: combining Firefox's
`{scripts}` with Chrome's `{service_worker}` would emit both and break both.

**Two deviations from the original plan**, both deliberate:

- **No `key` in `manifest.chrome.json`.** The plan called for one to pin the
  extension ID. Chrome actually derives an unpacked extension's ID from its
  folder path, and the build always writes to `dist/chrome`, so the ID is
  already stable — a `key` would mean managing a private key for no benefit.
  (The Web Store assigns its own ID on publish regardless.)
- **Firefox keeps the `menus` permission** rather than unifying on
  `contextMenus`, which both browsers accept. Keeping the original name is what
  makes the Firefox manifest provably unchanged; only the JS namespace is
  aliased.

### 2. Build script ✅ — `scripts/build.mjs`

Merges base + target into `dist/<browser>/manifest.json` and copies the shipped
file set. Driven by an explicit **allowlist**, not an ignore list — the old
`web-ext --ignore-files` approach packaged anything it hadn't been told to
exclude, which is how `README.md`, `LICENSE` and `ai-action-plan-design.md`
ended up inside the `.xpi`.

Development now loads `dist/firefox/` or `dist/chrome/`, not the repo root.

### 3. Test suite ✅ — `npm test`

All static; no browser is launched. 121 tests.

| File | Catches |
|---|---|
| `syntax` | A parse error in any source file — only 8 of 24 were ever checked by hand |
| `manifest` | Firefox-only keys leaking into the Chrome build, and vice versa |
| `version` | `manifest.base.json` drifting from the git tag |
| `assets` | A `<script src>` in `popup.html` with no file behind it |
| `globals` | Two popup scripts declaring the same top-level name — a `SyntaxError` at load, since all 22 share one scope |
| `compat` | New Chrome-incompatible API use, against a recorded baseline |
| `polyfill` | The polyfill failing to load first in any of Chrome's three contexts |
| `redirect-queue` | Lost updates and stalls in the per-tab redirect queue |
| `side-panel-command` | Alt+M losing the user gesture — asserts `sidePanel.open()` runs inline off the event, which is the one property reading the code can't confirm |
| `branded-term` | The quick-add failing to reach the Client record, or its pattern not projecting across the client's other domains |
| `client-prefill` | `+ Client` guessing the wrong name — pins the og → schema.org → title → domain order and the tagline reject rules |
| `lint-firefox` | `web-ext lint` on `dist/firefox` — still 0 errors / 0 warnings / 0 notices |

The last three were added after v2.0 to close out items previously listed as
needing a human at a browser; see *Outstanding verification* below for what
that did and didn't retire.

### 4. Compat linter and baseline ✅

`tests/compat.test.mjs` greps for constructs that break on Chrome.
`tests/compat-baseline.json` records the known ones. The test fails on any
violation **not** in the baseline, and on any baseline entry that no longer
matches — so the list cannot rot.

Every entry is now `intentional`: the Firefox-only constructs necessarily
remain in the source as one arm of a capability check. The linter detects
presence, not correctness, so each entry carries a reason explaining the guard.

### 5. CI ✅

- `test.yml` — runs on every push and PR. There was no PR check before.
- `sign-and-release.yml` — gates on the suite, signs `dist/firefox` via
  `--source-dir`, packages `dist/chrome` as a zip, attaches both.

**Release ergonomics changed:** CI no longer patches the version into the
manifest from the tag, which silently hid drift between the committed manifest
and what shipped. `manifest.base.json` must be bumped **before** tagging; the
release fails loudly otherwise.

---

## Milestone 2 — The port

### 1. `runtime.onMessage` → `sendResponse` ✅

Firefox resolves a Promise returned from a listener; Chrome ignores it and
requires `sendResponse` + `return true`. All ~110 handlers would have resolved
to `undefined`. The switch is now `routeMessage()` and the listener adapts it,
using the form both browsers accept. A `NOT_HANDLED` sentinel distinguishes
"no case matched" from "handler resolved to undefined".

*Verified live: the DNS tab returns real data on Chrome.*

### 2. `webextension-polyfill` ✅

~360 `browser.*` call sites, and Chrome has no such global. The polyfill is
injected **at build time into the Chrome build only** — a generated `sw.js`
that `importScripts` it ahead of `background.js`, first in `content_scripts`,
and a `<script>` prepended to `popup.html`. Firefox never sees it.

*Verified live: the panel renders on Chrome.*

### 3. Service-worker state durability ✅

Chrome terminates an idle worker after ~30s, emptying `redirectByTab`. The five
webRequest/webNavigation listeners read it synchronously and bailed on a miss,
silently dropping redirect chains. Rehydrating at top level doesn't help —
Chrome runs module code *before* dispatching the event that woke the worker.

All five now go through `withRedirectEntry()`, which keeps the **warm path
fully synchronous** (so Firefox's blocking `onHeadersReceived` is never made to
wait during page load), rehydrates on a miss, and serializes per tab so
concurrent misses can't each mutate their own deserialized copy.

`checkLinkStatuses` holds the worker open with an interval ping, since a sweep
can run for minutes and the content script waits with no timeout of its own.
`linkStatusCache` is deliberately **not** persisted — a pure 5-minute-TTL cache
where a restart costs a re-probe, never correctness.

### 4. `webRequest` ✅

`d.originUrl || d.initiator` and either extension scheme — matching only the
Firefox pair meant every Chrome trace timed out at 12s. `'blocking'` and
`getSecurityInfo` are behind one `CAN_READ_TLS` check, since the listener is
only blocking so `getSecurityInfo` can run inside it.

**TLS/certificate detail is a permanent Chrome feature gap** — Chrome has no
`getSecurityInfo` at all. It degrades to the existing `#tls-note` fallback.

*Verified live: DNS and Redirect tabs both clean on Chrome.*

### 5. `sidePanel` ✅

`setPanelBehavior({openPanelOnActionClick})` hands toolbar-click behaviour to
Chrome itself — the only way to keep the user gesture, since opening from
`action.onClicked` loses it across the awaited storage read. Panel detection
uses the `?view=sidepanel` marker rather than `extension.getViews({type:'sidebar'})`,
which is Firefox-only.

The `sidePanel` namespace is reached by bracket notation: addons-linter reports
any static `browser.sidePanel.*` reference as `UNSUPPORTED_API`, which would
put the Firefox build at 2 warnings and block signing.

### 6. OAuth redirect ✅

The two browsers need **different Google Cloud client types**:

| | Client type | Redirect URI |
|---|---|---|
| Firefox | Desktop app | `http://127.0.0.1/mozoauth2/<uuid>` |
| Chrome / Edge | Web application | `https://<extension-id>.chromiumapp.org/` |

`getGoogleRedirectUri()` branches on the extension URL scheme. No manifest or
storage-schema change was needed — each browser keeps its own
`browser.storage.local`, so the same Settings fields hold a different client per
browser. The Setup screen's copy is chosen per browser, because following
Firefox's instructions on Chrome fails only as an opaque consent-screen error.

*Verified live: full OAuth connect on Chrome, multiple services.*

### 7. Context menus ✅

Calls go through a `browser.menus || browser.contextMenus` alias.
`onShown`/`refresh` are Firefox-only and stay on that path; Chrome pushes
checkmark state eagerly from `storage.onChanged`, plus a resync when a toggle's
`sendMessage` fails (the browser ticks the checkbox optimistically and Chrome
has no `onShown` to correct it).

### 8. Chrome-only UI trims ✅

The Page Access grant is hidden on Chromium — `*://*/*` is a *required*
permission there, so `permissions.request()` throws and the button could only
ever fail. The update checker is hidden because the stores update extensions
themselves and prohibit self-update mechanisms.

### 9. Chrome Web Store publishing ⏳ **NOT DONE**

The CI step is written and wired but **self-skips** until `CWS_EXTENSION_ID` is
set. Completing it needs store account setup, not code:

1. A **manual first submission** to create the listing — the API can only
   update an existing one
2. Four repo secrets: `CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`,
   `CWS_REFRESH_TOKEN`
3. **Edge** consumes the identical `-chrome.zip` but has a separate Partner
   Center API — manual for now

**Consequence to plan for:** the Web Store assigns its own extension ID, so the
OAuth redirect URI changes on first publish. Add
`https://<store-id>.chromiumapp.org/` as an additional Authorized redirect URI
on the same Web application client; the local-dev entry stays.

---

## Outstanding verification

Static checks pass and several areas are confirmed live on Chrome, but two
gaps remain — both needing a human at a browser.

**Firefox regression pass — the main open risk.** Every v2.0 commit touched
shared code, and two commits landed after the v2.0 tag: the redirect-queue
rewrite (all five listeners) and the Setup-screen copy change. Load
`dist/firefox/` and exercise each tab, sidebar and pop-out modes, and
Settings → OAuth Client.

**Chrome checks not yet done:**

- **The Ads tab against API v25** — a four-version jump, never seen live data.
  Nothing static can cover this: it needs a connected account. This is now the
  only item on the list with no automated coverage at all.
- **Alt+M** — the handler is now covered by `side-panel-command`, which pins
  the actual failure mode (the call must not be deferred past an await; the
  test fails against the pre-fix handler). That retires the code question, not
  the platform one — only a real Chrome can confirm it accepts the gesture.
- **Redirect chains surviving a worker restart** — `redirect-queue` covers the
  rehydrate-and-serialize logic. A live pass is still worth doing once: load a
  page, kill the service worker from `chrome://extensions`, then navigate to a
  redirecting URL.
- **Branded-term write-through and `+ Client` prefill** — covered by
  `branded-term` and `client-prefill`. Both are ordinary popup→background
  logic with no platform-specific behaviour, so these are considered closed.

Writing those tests turned up one latent defect, now fixed:
`clientRegistryAddBrandedTerm` stripped `www.` *before* lowercasing, so an
uppercase `WWW.` host would have been keyed where nothing else looks. Every
caller passes a host already normalised out of `URL.hostname`, so it was never
reachable from the UI — but it was inconsistent with `clientRegistryAddDomain`
directly above it. Two other raw-string normalisers carry the same ordering
(`getDomainAge`, and `norm` inside `webceoAggregateCompetitorMetrics`); both
were left alone as out of scope, and neither is known to be reachable.
