<p align="center">
  <img src="icons/icon-128.png" width="96" alt="SEO Inspector icon" />
</p>

<h1 align="center">SEO Inspector</h1>

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
| Search Console / Analytics / Ads / Drive | Your own Google OAuth client ID + secret (Settings → Setup) |
| Google Ads | Additionally a Google Ads developer token |
| Web CEO | API key + base URL (Agency Unlimited accounts) |
| PageSpeed Insights | A free [PSI API key](https://developers.google.com/speed/docs/insights/v5/get-started) |
| AI features | An Anthropic (Claude) API key |

## Development

```bash
# Load unsigned, for local testing:
#   about:debugging → This Firefox → Load Temporary Add-on → pick manifest.json

node --check background.js      # syntax-check any changed JS
web-ext lint --source-dir=.     # must stay 0 errors / 0 warnings / 0 notices
```

Releases are cut by tagging `v*` — a GitHub Action signs the extension with AMO and
attaches the `.xpi` to the release.

## License

Proprietary — see [LICENSE](LICENSE). All rights reserved.
