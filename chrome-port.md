# Chrome/Edge support — plan and status

Marketing Inspector was Firefox-only through v1.106: loaded from the repo root,
no build step, signed as an unlisted `.xpi` via AMO, and verified by hand. v2.0
added Chrome and Edge support, a per-browser build, and a release test suite.

**Status as of v2.7.5: the port is complete and every milestone below is on
`main` except Milestone 2 step 9 (Chrome Web Store publishing), which is
blocked on store and Google Cloud account setup rather than on code.**
Outstanding verification is listed at the end.

Two things changed after v2.0 in ways that reversed decisions recorded in
earlier versions of this document — the pinned Chromium extension id (v2.4.2)
and the bundled OAuth client (v2.4.0). Both are described in place below.

---

## Milestone 1 — Infrastructure ✅

No user-facing change at the time. `dist/firefox/manifest.json` was diffed
against the manifest that shipped in v1.106 and was semantically identical.

### 1. Manifest split ✅

`manifest.json` became three files, deep-merged at build time:

- `manifest.base.json` — shared keys, and the single source of truth for the
  version
- `manifest.firefox.json` — `browser_specific_settings` (the `gecko.id` is
  **required** for `--channel=unlisted` AMO signing), `sidebar_action`,
  `background.scripts`, `commands._execute_sidebar_action`, `menus` +
  `webRequestBlocking`
- `manifest.chrome.json` — `key`, `background.service_worker`, `side_panel`,
  `sidePanel` + `contextMenus`, a custom `commands` entry replacing
  `_execute_sidebar_action`, `minimum_chrome_version`

`background` is replace-merged, not deep-merged: combining Firefox's
`{scripts}` with Chrome's `{service_worker}` would emit both and break both.

**The `key` — reversing an earlier decision.** v2.0 deliberately shipped no
`key`, on the reasoning that Chrome derives an unpacked extension's id from its
folder path and the build always writes to `dist/chrome`, so the id was already
stable. That is true for one developer on one machine, and it misses the point:
the id is what the OAuth redirect URI is built from, so **without a pinned key
every install has a different redirect URI** and a shared OAuth client is
impossible — each user would have to register their own. v2.4.2 added the key
for exactly that reason.

This was breaking for existing Chromium installs: the id changed, so the
redirect URI changed with it and any live Google connection had to be
reconnected. One-time, and the price of ever having a stable id. Firefox is
unaffected — it pins its id through `browser_specific_settings.gecko.id` and
must **not** carry this key, which `tests/oauth-client.test.mjs` asserts in both
directions.

The private half of that keypair was not retained. It is only needed to sign a
self-hosted `.crx`, which Chrome no longer accepts on Windows or macOS. See
step 9 for what this means at publish time.

**Firefox keeps the `menus` permission** rather than unifying on
`contextMenus`, which both browsers accept. Keeping the original name is what
made the Firefox manifest provably unchanged; only the JS namespace is aliased.

### 2. Build script ✅ — `scripts/build.mjs`

Merges base + target into `dist/<browser>/manifest.json` and copies the shipped
file set. Driven by an explicit **allowlist**, not an ignore list — the old
`web-ext --ignore-files` approach packaged anything it hadn't been told to
exclude, which is how `README.md`, `LICENSE` and `ai-action-plan-design.md`
ended up inside the `.xpi`.

It also does two things that only matter for Chrome:

- generates `sw.js`, whose `importScripts` call lists the polyfill followed by
  `BACKGROUND_FILES` in load order
- rewrites `oauth-config.js` inside `dist/` from `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET` (see step 6)

Development loads `dist/firefox/` or `dist/chrome/`, never the repo root.

### 3. Test suite ✅ — `npm test`

All static; no browser is launched. **873 tests across 38 files** — the suite
now covers far more than the port, so the table below lists only the checks
that exist because of it.

| File | Catches |
|---|---|
| `syntax` | A parse error in any source file — only 8 of 24 were ever checked by hand |
| `manifest` | Firefox-only keys leaking into the Chrome build, and vice versa |
| `version` | `manifest.base.json` drifting from the git tag |
| `assets` | A `<script src>` in `popup.html` with no file behind it |
| `globals` | Two popup scripts declaring the same top-level name — a `SyntaxError` at load, since they share one scope |
| `background-split` | The background's load order drifting between `sw.js` and `manifest.firefox.json`, which declare it twice in different formats |
| `compat` | New Chrome-incompatible API use, against a recorded baseline |
| `polyfill` | The polyfill failing to load first in any of Chrome's three contexts |
| `redirect-queue` | Lost updates and stalls in the per-tab redirect queue |
| `redirect-listeners` | The webRequest listeners themselves, above the queue |
| `side-panel-command` | Alt+M losing the user gesture — asserts `sidePanel.open()` runs inline off the event, the one property reading the code can't confirm |
| `oauth-client` | The bundled-client resolution rules, and that the Chrome `key` never reaches Firefox |
| `lint-firefox` | `web-ext lint` on `dist/firefox` — still 0 errors / 0 warnings / 0 notices |

### 4. Compat linter and baseline ✅

`tests/compat.test.mjs` greps for constructs that break on Chrome.
`tests/compat-baseline.json` records the known ones — currently **10 entries**.
The test fails on any violation **not** in the baseline, and on any baseline
entry that no longer matches, so the list cannot rot.

Every entry is `intentional`: either a Firefox-only construct that necessarily
remains as one arm of a capability check, or a false positive. The linter
detects presence, not correctness, so each entry carries a reason explaining
the guard. New entries have been added since v2.0 as new code landed — the most
recent being `popup-inspector.js`'s fire-and-forget `overlayStateChanged`
listener, which correctly needs no `sendResponse`.

### 5. CI ✅

- `test.yml` — runs on every push and PR. There was no PR check before.
- `sign-and-release.yml` — gates on the suite, signs `dist/firefox` via
  `--source-dir`, packages `dist/chrome` as a zip, attaches both, and forwards
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` to the build. Those are
  **job-level, not step-level**, so `npm test`'s pretest build sees them too —
  otherwise the uploaded artifacts would be built from a different
  `oauth-config.js` than the suite verified.

**Release ergonomics changed:** CI no longer patches the version into the
manifest from the tag, which silently hid drift between the committed manifest
and what shipped. `manifest.base.json` must be bumped **before** tagging; the
release fails loudly otherwise.

---

## Milestone 2 — The port

### 1. `runtime.onMessage` → `sendResponse` ✅

Firefox resolves a Promise returned from a listener; Chrome ignores it and
requires `sendResponse` + `return true`. All ~110 handlers would have resolved
to `undefined`. The switch is `routeMessage()` (now in `bg-router.js`) and the
listener adapts it, using the form both browsers accept. A `NOT_HANDLED`
sentinel distinguishes "no case matched" from "handler resolved to undefined".

*Verified live: the DNS tab returns real data on Chrome.*

### 2. `webextension-polyfill` ✅

~360 `browser.*` call sites, and Chrome has no such global. The polyfill is
injected **at build time into the Chrome build only** — a generated `sw.js`
that `importScripts` it ahead of the background files, first in
`content_scripts`, and a `<script>` prepended to `popup.html`. Firefox never
sees it.

*Verified live: the panel renders on Chrome.*

Since v2.3.2 the background is ten `bg-*.js` files plus `oauth-config.js`
rather than one `background.js`, sharing one global scope. The order lives in
`BACKGROUND_FILES` in `scripts/build.mjs` and feeds both `sw.js` and Firefox's
`background.scripts`; `tests/background-split.test.mjs` keeps the two in sync.

### 3. Service-worker state durability ✅

Chrome terminates an idle worker after ~30s, emptying `redirectByTab`. The five
webRequest/webNavigation listeners read it synchronously and bailed on a miss,
silently dropping redirect chains. Rehydrating at top level doesn't help —
Chrome runs module code *before* dispatching the event that woke the worker.

All five go through `withRedirectEntry()` (in `bg-core.js`), which keeps the
**warm path fully synchronous** — so Firefox's blocking `onHeadersReceived` is
never made to wait during page load — rehydrates on a miss, and serializes per
tab so concurrent misses can't each mutate their own deserialized copy.

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
uses the `?view=sidepanel` marker rather than
`extension.getViews({type:'sidebar'})`, which is Firefox-only.

The `sidePanel` namespace is reached by bracket notation: addons-linter reports
any static `browser.sidePanel.*` reference as `UNSUPPORTED_API`, which would
put the Firefox build at 2 warnings and block signing.

### 6. OAuth ✅

The two browsers need **different Google Cloud client types**, because each
intercepts a different redirect URI:

| | Client type | Redirect URI |
|---|---|---|
| Firefox | Desktop app | `http://127.0.0.1/mozoauth2/<uuid>` |
| Chrome / Edge | Web application | `https://<extension-id>.chromiumapp.org/` |

`getGoogleRedirectUri()` branches on the extension URL scheme. Each browser
keeps its own `browser.storage.local`, so the same Settings fields hold a
different client per browser. The Setup screen's copy is chosen per browser,
because following Firefox's instructions on Chrome fails only as an opaque
consent-screen error.

*Verified live: full OAuth connect on Chrome, multiple services.*

**Bundled client (v2.4.0).** Onboarding originally required every user to build
a Google Cloud project, enable six APIs and create an OAuth client before
anything connected. The extension can now ship its own client, and **a
user-entered one always wins** — that is both the escape hatch for anyone
wanting their own Cloud project and the migration path once the shared client
hits Google's 100-user cap for unverified apps.

The repo is public, so credentials never enter source: `oauth-config.js` is
checked in with empty strings and the build rewrites it inside `dist/`. With
the env vars unset the build is byte-identical to before and the extension
behaves exactly as it always has, so the feature lands inert until the CI
secrets exist.

Two details worth keeping:

- `googleOAuthCredentials()` is deliberately **all-or-nothing** — a
  user-supplied id is used with the user's own secret, never crossed with the
  bundled one. Mixing halves of two clients fails at the token exchange with an
  opaque `invalid_client`. Refresh resolves through the same helper, so a token
  always presents the client it was issued to.
- A client secret shipped inside a distributed extension is extractable by
  anyone who installs it, and Google's guidance treats installed-app secrets as
  non-confidential. It is present because Google's "Web application" type — the
  only one whose redirect URI Chromium's `launchWebAuthFlow` can use — requires
  it, not because it protects anything. It gates nothing on its own: a third
  party holding it still cannot reach any user's data without that user
  completing a consent screen.

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
set. Completing it needs account setup, not code.

**Chrome Web Store:**

1. A **manual first submission** to create the listing — the API can only
   update an existing one
2. Four repo secrets: `CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`,
   `CWS_REFRESH_TOKEN`
3. **Replace the `key` in `manifest.chrome.json` with the store's own public
   key.** The store assigns its own id on first upload, which changes the
   extension id and therefore the OAuth redirect URI again. Add the new
   `https://<store-id>.chromiumapp.org/` to the Web application client's
   Authorized redirect URIs — a client can hold several, so the local-dev entry
   can stay.

**Google Cloud, for the bundled client to actually work:**

4. Set the client's publishing status to **"In production"**. Under "Testing",
   external users' refresh tokens expire after seven days — which would mean
   reconnecting four services every week.
5. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` as repository secrets. Until
   they exist, released builds ship the empty defaults and every user brings
   their own client.
6. Watch the **100-user cap** for unverified apps; passing it requires Google
   verification, or users fall back to their own client.

**Edge** consumes the identical `-chrome.zip` but has a separate Partner Centre
API — submission stays manual for now.

---

## Outstanding verification

The suite is now large (873 tests) and several areas are confirmed live on
Chrome, but static checks cannot cover everything.

**Firefox regression pass.** Never formally done, and now many releases behind
— the port landed at v2.0 and `main` is at v2.7.5. Much of the risk has since
been absorbed by the suite (`background-split`, `redirect-listeners`,
`redirect-queue`, `oauth-client` and `lint-firefox` all guard shared code from
the Firefox side), so this is lower risk than it was, but it is not zero: no
test loads the extension in Gecko. Worth one pass over each tab, sidebar and
pop-out modes, and Settings → OAuth Client.

**The Ads tab against API v25.** `bg-ads.js` targets `v25`. Nothing static can
cover this — it needs a connected account with live data. This remains the one
item with no automated coverage at all.

**Redirect chains surviving a worker restart.** `redirect-queue` and
`redirect-listeners` cover the rehydrate-and-serialize logic thoroughly. A live
pass is still worth doing once: load a page, kill the service worker from
`chrome://extensions`, then navigate to a redirecting URL.

**Alt+M** is covered by `side-panel-command`, which pins the actual failure
mode — the call must not be deferred past an await, and the test fails against
the pre-fix handler. That retires the code question, not the platform one: only
a real Chrome can confirm it accepts the gesture.

**Closed since v2.0:** branded-term write-through and `+ Client` prefill, both
now covered by tests (`branded-term`, `client-prefill`). Writing those turned up
a latent defect, since fixed: `clientRegistryAddBrandedTerm` stripped `www.`
*before* lowercasing, so an uppercase `WWW.` host would have been keyed where
nothing else looks. Every caller passes a host already normalised out of
`URL.hostname`, so it was never reachable from the UI.
