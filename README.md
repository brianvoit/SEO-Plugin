<p align="center">
  <img src="icons/icon-128.png" width="96" alt="Marketing Inspector icon" />
</p>

<h1 align="center">Marketing Inspector</h1>

<p align="center">
  A Firefox extension that pulls on-page SEO, Search Console, Analytics, Google Ads,<br />
  rank tracking, backlinks and Core Web Vitals into a single panel — for the page you're on.
</p>

---

## Install

Grab the latest signed `.xpi` from the [Releases page](https://github.com/brianvoit/SEO-Plugin/releases/latest) and open it in Firefox.

Requires Firefox 142+. Runs as a popup, a sidebar, or a detached pop-out window (switchable in Settings).

## What it does

**Overview** — the page you're on, inspected live:
- Title, meta description and headings with character/pixel-width targets
- Canonical, indexability (noindex/nofollow, canonical mismatches) and hreflang
- Open Graph, X/Twitter cards and structured data (JSON-LD) — each downloadable as JSON
- Favicon checks, domain age, SSL and publish/modified dates
- Alt-text overlay and link-health overlay drawn directly on the page

**Core Web Vitals** — Lighthouse performance score plus LCP / INP / CLS from real-user
CrUX field data (with lab fallback), secondary lab metrics, and the top optimisation
opportunities. Mobile and desktop.

**Search** — Google Search Console queries for the page: clicks, impressions, CTR and
position, with charts, AI search-intent chips, branded-term filtering, regex search, and
Ads-sourced volume / CPC / difficulty. Exports to CSV or Google Sheets.

**Analytics** — GA4 sessions, channels and trends for the page, with annotations.

**Ads** — Google Ads campaigns, ad groups, keywords and search terms scoped to the page,
with cross-filtering, quality-score diagnostics, CSV/Sheets export, AI ad-copy generation,
AI negative-keyword refinement, and keyword adding written straight back to Google Ads.

**Tracked** — Web CEO rank tracking: positions per engine, movement since the last scan,
a visibility scorecard, striking-distance quick wins, URL-drift (cannibalisation) flags,
and keyword tags.

**Backlinks & Site Audit** — Web CEO referring domains, anchor text, lost and toxic links,
competitor comparison, plus a site-wide audit of crawl issues.

**DNS & Redirects** — DNS records over DoH, security headers, TLS details, and a full
redirect-chain tracer.

**Extras** — AI Action Plan (Claude), UTM builder, and per-domain branded-term lists.

## Setup

Everything is optional — connect only what you use. All keys and tokens are stored in
`browser.storage.local` on your machine and are never synced or sent anywhere except the
API they belong to.

| Integration | What you need |
|---|---|
| Search Console / Analytics / Ads / Drive | Your own Google OAuth client ID + secret (Settings → Setup → OAuth Client) |
| Google Ads | Additionally a Google Ads developer token |
| Web CEO | API key + base URL (Agency Unlimited accounts) |
| PageSpeed Insights | A free [PSI API key](https://developers.google.com/speed/docs/insights/v5/get-started) |
| AI features | An Anthropic (Claude) API key |

### The Google OAuth client is per-browser

The two browsers need **different OAuth client types**, because each intercepts a
different redirect URI. A client made for one will be rejected by the other, and the
failure shows up only as an opaque error on Google's consent screen — so make the
right one:

| | Client type | Redirect URI to register |
|---|---|---|
| **Firefox** | Desktop app | `http://127.0.0.1/mozoauth2/<uuid>` |
| **Chrome / Edge** | Web application | `https://<extension-id>.chromiumapp.org/` |

Don't type the redirect URI by hand — Settings → Setup → OAuth Client shows the exact
value for the browser you're in, with a copy button. Paste that into the client's
**Authorized redirect URIs** in [Google Cloud Console](https://console.cloud.google.com/apis/credentials).

Both clients can live in the same Cloud project. Credentials are stored in
`browser.storage.local`, which each browser keeps separately, so the two installs don't
interfere. The Web application client issues a secret and needs it; the Desktop app
client works without one.

Note that a Chrome extension's ID — and therefore its redirect URI — is derived from
the folder it's loaded from, so it changes if you move `dist/chrome`, and again when the
extension is published (the Web Store assigns its own ID). Add the new URI alongside the
old one when that happens; a client can hold several.

## Development

The extension source lives at the repo root (plain `*.js`, `popup.html`, `popup.css` —
no bundler, no modules). A small build step assembles a loadable directory per browser,
because Firefox and Chrome need different manifests.

```bash
npm ci             # one time
npm run build      # → dist/firefox/ and dist/chrome/
npm test           # builds, then runs the full verification suite
```

Load the built directory, not the repo root:

- **Firefox** — `about:debugging` → This Firefox → Load Temporary Add-on → `dist/firefox/manifest.json`
- **Chrome / Edge** — `chrome://extensions` → Developer mode → Load unpacked → `dist/chrome/`

### Manifests

`manifest.base.json` holds every shared key; `manifest.firefox.json` and
`manifest.chrome.json` add only what differs (sidebar vs side panel, event page vs
service worker). The build deep-merges base + target — so shared values like the
version and host permissions have exactly one home.

**`manifest.base.json` is the single source of truth for the version.** Bump it before
tagging: the release workflow asserts the tag matches rather than silently rewriting it.

### What `npm test` checks

All static — no browser is launched.

| Check | Catches |
|---|---|
| `syntax` | A parse error in any of the ~24 source files |
| `manifest` | Firefox-only keys leaking into the Chrome build, and vice versa |
| `version` | `manifest.base.json` drifting from the git tag |
| `assets` | A `<script src>` in `popup.html` with no file behind it |
| `globals` | Two popup scripts declaring the same top-level name — a `SyntaxError` at load, since all 22 share one scope |
| `compat` | New Chrome-incompatible API use (baselined in `tests/compat-baseline.json`) |
| `lint:firefox` | `web-ext lint` on `dist/firefox` — still 0 errors / 0 warnings / 0 notices |

### Releases

Tag `v*`. The workflow runs the suite, then signs `dist/firefox` via AMO and packages
`dist/chrome` as a zip, attaching both to the GitHub Release. Chrome Web Store
publishing runs automatically once its secrets are configured; Edge consumes the same
zip and is submitted manually.

## License

Proprietary — see [LICENSE](LICENSE). All rights reserved.
