# AI Action Plan — Synthesis Feature Design

A design write-up for extending the Claude integration in **SEO Inspector** (v1.35) to
synthesize on-page data and demand-side data into actionable, evidence-backed
recommendations.

---

## The core idea

Most SEO tools that bolt on an LLM feed it the page text and ask "make this better."
The result is generic because the model only sees the **supply side** — what's on the page.

This extension already collects the **demand side**, which is the part competitors don't have:

- **GSC** — the queries that actually drive impressions and clicks, and the positions you hold.
- **Google Ads** — what you bid on, and which search terms actually convert.
- **WebCEO** — the keywords you're deliberately tracking position for.
- **GA4** — how traffic behaves once it lands.

The whole value of the feature is in the **gap between demand and supply**: what people search
for versus what the page actually says. That delta is where the surgical, outsized wins live.

---

## Locked design decisions

Settled during the design review — build from these:

- **Placement:** Overview tab, immediately after the Sentiment/Intent row, before Headings
  (keeps all Claude-generated output contiguous).
- **Interaction:** a **nav row** styled like the Open Graph / Structured Data rows — label on the
  left, a `✦` glyph + `›` chevron on the right. Clicking the row opens a **detail panel** (its own
  screen with a Back button), mirroring `btn-og` / `btn-schema`. No inline generate button, no
  explainer/help text on the row or panel.
- **Generation trigger:** first open of the panel fires the API call; later opens render the
  cached result. A **Refresh** button re-runs it, with a **"generated X ago" timestamp** next to it
  so the user can judge staleness against shifting GSC data.
- **Output groups (three tiers):** **Quick wins** (surgical), **Recommended** (moderate), and
  **Heavy lift** (rewrite/reposition). Each rec carries the change, an evidence line, an effort tag,
  and an impact tag. A **Sources** badge row shows which integrations fed the plan.
- **Content-gap chips:** inert labels (not clickable) for this build.
- **AI-EO lens:** dropped for this build; revisit as a follow-up.

---

## 1. What we feed it — the synthesis prompt

This prompt is fundamentally different from the existing `generateField`. That one takes the
page (supply) and rewrites a single field. This one takes supply **and demand** and finds the
mismatch. The demand-side data is what makes the output non-generic.

### Context payload

**From the page (supply):**

- Title and meta description
- Full heading outline — the H1/H2/H3 *nesting*, not just text. Structure gaps are among the
  most surgical fixes available.
- Body excerpt and word count
- Schema types present
- The four insights already computed: intent, sentiment, readability, audience

**From GSC (demand — the most valuable input):**

- Top queries by impressions where **position is 5–20**. This is the gold: a query with
  thousands of impressions at position 11 means Google already thinks the page is relevant
  but it's stranded on page 2.
- Queries with **high impressions but low CTR** — a title/meta problem, not a content problem.
- Queries the page ranks for that **aren't reflected anywhere in the headings** — a content gap.

**From Ads:**

- Converting search terms. If you pay for a term that converts and the page doesn't organically
  target it, that's a direct "write this section" instruction backed by money.

**From WebCEO:**

- Tracked keywords and their trajectory, so the model knows what you're deliberately trying to win.

**From GA4 (behavior — what happens *after* the click):**

GSC/Ads/WebCEO describe demand and rankings; GA4 is the only source that says what the visitor
actually did once they landed. These are pre-computed in JS and passed as small derived signals,
not raw tables:

- **Engagement time vs. estimated read time** — actual avg engagement seconds against
  `wordCount / 200 wpm`. A large shortfall is a *scanability* problem (headings/bullets/TL;DR),
  not a content or keyword problem.
- **Bounce rate vs. GSC CTR** — strong impressions/CTR but high bounce means the page wins the
  click and loses the visitor: a content-expectation mismatch in the opening section.
- **Top next pages** — the page(s) users navigate to next. A heavy, consistent exit to one page
  (e.g. `/pricing`) is a behavior-confirmed content gap or a "surface/link this here" instruction.
- **Channel-specific engagement** — if organic bounces far worse than direct/email, the page
  serves returning visitors but fails first-time organic intent.

GA4 signals tend to produce **quick-win / recommended** structural fixes; an intent mismatch on the
opening can escalate to **heavy lift**.

### Design principle: pre-filter in JS, reason on deltas

Be selective rather than dumping everything. Pre-filter in JavaScript — the position 5–20 band,
the high-impression-low-CTR set — *before* the call, rather than making the model do arithmetic
on a giant table. A tight payload is cheaper, sharper, and keeps the model reasoning over the
deltas that matter.

---

## 2. What it returns — structured, not prose

Following the existing JSON-with-normalization pattern (`normalizeAiInsights`), the model returns
a structured object rather than an essay, so each recommendation renders as its own card with an
evidence line.

Each recommendation carries:

- **The change** — what to do
- **The evidence** — the specific query and its impressions/position behind it
- **Effort tag** — surgical / moderate / rewrite
- **Impact tag** — expected magnitude

Plus a short **"missing content"** list and a **"quick wins"** subset.

### The evidence line is the trust mechanism

> "Add an H2 on *bulk pricing*" — ignorable.
>
> "Add an H2 on *bulk pricing* — you rank #12 for it with 2,400 impressions/mo and it's a
> converting Ads term, but it appears nowhere in your headings" — acted on immediately.

Every recommendation should be traceable to a number we already have.

---

## 3. Where it lives

On the **Overview**, below the AI insights row, as a **collapsed "AI Recommendations" / "Action
Plan" card** with a generate button — mirroring how the title/meta generators sit there inert
until clicked.

It must be **click-to-run**, not automatic, for three reasons the existing code already anticipates:

1. It's a real billable call, larger than the others.
2. It needs GSC/Ads/WebCEO connected — the button's disabled/empty state explains what to connect
   for richer output.
3. It depends on multiple async data sources that won't all be loaded on first paint.

**Caching:** cache the result per-URL with a TTL, like `aiInsightsCache` — but use a notably
**shorter TTL or a manual refresh**, since GSC data shifts and a stale action plan is worse than
a stale sentiment label.

### Graceful degradation

The feature should still produce something useful with **only page content** (it becomes a
structure/content audit), and get progressively sharper as each data source connects. That makes
it valuable to a free user and a concrete reason to connect the integrations.

---

## 4. What it reveals and why it matters — the SEO / AI-EO payoff

### a. The page-2 rescue

Surface the queries you're one or two positions away from winning, with the specific on-page
reason you're losing them. This is the highest-ROI work in SEO, and almost nobody has it laid out
query-by-query against their own content.

### b. Closing the demand-supply gap

The model names content that *should* be on the page because the market is asking for it
(queries, paid search terms) but isn't. This is the "what's missing," grounded in evidence rather
than a generic checklist.

### b2. Behavior-confirmed fixes (GA4)

A second, distinct payoff: GA4 turns "people search for this" into "people *did* this on the page."
A page that wins clicks but bounces, holds attention far below its read time, or funnels everyone
to `/pricing` is telling you — by behavior, not inference — exactly where the experience breaks.
These fixes are uniquely ours: no keyword tool sees post-click behavior, and they're often cheaper
than chasing new rankings because the demand already arrived.

### c. Answer-engine optimization (AI-EO) — the forward-looking part

The same synthesis reframes naturally for whether a page is **extractable by AI answer engines**:

- Is there a clear, self-contained answer near the top?
- Are claims structured as discrete, quotable statements?
- Does the heading structure map to the questions people actually ask? (Your GSC queries are
  literally a list of those questions.)
- Is there schema backing the entities?

AI-EO is largely about being the cleanest, most-citable source for a specific question — and we
uniquely know *which* questions matter for this page because GSC tells us.

Consider making this a **distinct lens** within the same card (an "SEO" set of recs and an
"AI visibility" set), since the fixes diverge:

| Lens | Rewards |
|------|---------|
| SEO | depth, keyword coverage |
| AI-EO | clarity, structure, citable atomic claims |

---

## Why this fits the existing architecture

Every pattern this feature needs already exists in the codebase:

- The Anthropic API call shape (`generateField`, `loadAiInsights`)
- Per-URL caching with TTL and LRU eviction (`aiInsightsCache`, the 20-entry cap)
- JSON-only responses with strict normalization (`normalizeAiInsights`)
- On-demand button triggers with spinner/error states

The synthesis feature is essentially a heavier, multi-source version of `loadAiInsights`.

---

## Suggested next step

Draft the actual prompt (system + context assembly) and a `loadActionPlan()` function modeled on
`loadAiInsights`, including the JS-side pre-filtering of the GSC query band, plus a matching card
in `popup.html`. This requires a quick look at the GSC/Ads data shapes in `background.js` to get
the field names right.
