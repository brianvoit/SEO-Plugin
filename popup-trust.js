// ─── E-E-A-T rule engine ──────────────────────────────────────────────────────
//
// Deterministic. Given the page's trust signals (content.js detectTrustSignals)
// and the client's trust profile (Client Registry), decides which
// recommendations are ACTIONABLE. Nothing here writes prose for the user — the
// model phrases what fires — but nothing fires that the engine did not allow.
//
// That split is the whole point of the design. Three of the module spec's
// constraints cannot be met by a prompt:
//   * no output may assert a value Google does not compute,
//   * policy-blocked rules must be HARD-suppressed, not down-weighted,
//   * every rule must cite the condition that triggered it.
// You cannot hard-suppress an LLM, so gating lives here and only phrasing is
// delegated.
//
// House rule throughout: a rule the client cannot execute is worse than
// silence. Every gate below exists to stay quiet rather than to say something.

const TRUST_LOCAL_MODELS = ['local_service', 'multi_location'];

function trustProfileOf(client) {
  const t = (client && client.trust) || {};
  return {
    businessModel: t.businessModel || 'local_service',
    ymyl: t.ymyl || 'none',
    hasGbp: !!t.hasGbp,
    authoredContent: !!t.authoredContent
  };
}

// A page carries a local footprint if the client is a local business OR simply
// has a Google Business Profile. Gating on business_model alone missed the
// mixed ecommerce/lead-gen clients that still operate a real location — which
// is open question 1 in the spec, answered here rather than by allowing
// business_model to hold several values.
function trustIsLocal(profile) {
  return profile.hasGbp || TRUST_LOCAL_MODELS.includes(profile.businessModel);
}

// Each rule states when it fires, when it is suppressed, and why. `suppressed`
// runs first and wins: a suppression is a policy decision, a fire is only an
// observation.
const TRUST_RULES = [
  // ── Tier 1: unconditional ────────────────────────────────────────────────
  {
    id: 'R-NAMED', tier: 1, impact: 'medium', effort: 'moderate', check: 'named',
    fires: (s) => !s.hasNamedPeople && ['home', 'about', 'service'].includes(s.pageType),
    trigger: (s) => `no named individuals detected on a ${s.pageType} page`,
    rec: 'Replace collective references ("our team", "our staff") with named individuals and their roles.'
  },
  {
    id: 'R-PROOF', tier: 1, impact: 'medium', effort: 'surgical', check: 'claims',
    fires: (s) => (s.unquantifiedClaims || []).length > 0,
    // The matched string is emitted so the analyst can see exactly what fired
    // the rule rather than having to hunt for it.
    trigger: (s) => `unanchored claims: ${(s.unquantifiedClaims || []).slice(0, 5).map(c => `"${c.claim}"`).join(', ')}`,
    // Deliberately "anchor", not "make specific". "44 years" is already
    // specific; what it lacks is anything a reader can check it against.
    rec: 'Anchor each claim to something verifiable — a founding year, a project count, a licence number, or a link to the source.'
  },
  {
    id: 'R-ORG', tier: 1, impact: 'medium', effort: 'moderate', check: 'org',
    fires: (s) => !s.hasOrganizationSchema || !s.hasOrganizationSameAs,
    trigger: (s) => s.hasOrganizationSchema
      ? 'Organization schema present but has no sameAs'
      : 'no Organization schema on the page',
    rec: 'Complete the Organization entity: legal name, address, contact, and sameAs pointing at controlled profiles.'
  },
  {
    id: 'R-ADDRESS', tier: 1, impact: 'high', effort: 'surgical', check: 'address',
    fires: (s, p) => !s.hasVisibleAddress && trustIsLocal(p),
    suppressed: (s, p) => !trustIsLocal(p) && 'the client has no local footprint',
    trigger: () => 'no postal address found in the rendered page',
    rec: 'Surface a full visible address in rendered HTML, not only in schema.'
  },

  // ── Tier 2: gated on client configuration ────────────────────────────────
  {
    id: 'R-PERSON-SCHEMA', tier: 2, impact: 'medium', effort: 'moderate', check: 'author',
    suppressed: (s, p) => (!p.authoredContent && 'this client does not publish bylined content')
      || (['home', 'product', 'location'].includes(s.pageType) && `Person schema does not belong on a ${s.pageType} page`),
    fires: (s) => s.pageType === 'article' && s.hasByline && !s.hasPersonSchema,
    trigger: (s) => `byline "${s.bylineName || 'present'}" with no Person schema`,
    rec: 'Add Person schema for the byline, linked to a populated author page via sameAs, and referenced as author from the Organization graph.'
  },
  {
    id: 'R-AUTHOR-PAGE', tier: 2, impact: 'medium', effort: 'moderate', check: 'author',
    suppressed: (s, p) => !p.authoredContent && 'this client does not publish bylined content',
    fires: (s) => s.hasByline && !s.bylineHref,
    trigger: (s) => `byline "${s.bylineName || 'present'}" does not link anywhere`,
    rec: 'Build a bio page carrying credentials, and link every byline to it.'
  },
  {
    id: 'R-REVIEW-DISPLAY-STARS', tier: 2, impact: 'high', effort: 'moderate', check: 'reviews',
    suppressed: (s, p) => (p.businessModel !== 'ecommerce' && 'star eligibility needs an ecommerce Product page')
      || (s.pageType !== 'product' && `reviews cannot earn stars on a ${s.pageType} page`),
    fires: () => true,
    trigger: () => 'ecommerce product page, eligible for review stars',
    rec: 'Display collected reviews and add Product-scoped review markup. Star rich results are achievable on this entity type.'
  },
  {
    id: 'R-REVIEW-DISPLAY-NOSTARS', tier: 2, impact: 'medium', effort: 'moderate', check: 'reviews',
    suppressed: (s, p) => (!p.hasGbp && 'no Google Business Profile configured for this client')
      || (!['home', 'service', 'location'].includes(s.pageType) && `not applicable to a ${s.pageType} page`)
      || (p.businessModel === 'ecommerce' && s.pageType === 'product' && 'this is a Product page — stars are achievable, see R-REVIEW-DISPLAY-STARS'),
    fires: () => true,
    trigger: (s) => `Google Business Profile client on a ${s.pageType} page`,
    rec: 'Display reviews on the page for conversion.',
    // The whole reason this rule is split from the stars variant: without
    // stating the ceiling, someone spends a sprint chasing rich results that
    // this entity type cannot produce.
    ceiling: 'Star rich results are NOT achievable here. Google has excluded self-serving reviews on LocalBusiness and Organization from star eligibility since 2019. Display these for conversion only.'
  },
  {
    id: 'R-CREDENTIALS', tier: 2, impact: 'high', effort: 'moderate', check: 'credentials',
    suppressed: (s, p) => p.ymyl === 'none' && 'not a YMYL or regulated vertical',
    fires: (s) => !s.hasCredentials,
    trigger: (s, p) => `${p.ymyl} vertical with no licensure or credentials found on the page`,
    // `regulated` exists so engineering and water treatment can ask for
    // licensure without masquerading as health — only health gets the
    // reviewer line, which is a medical-content convention.
    rec: (s, p) => 'Surface practitioner licensure, the credentialing body, and jurisdiction.'
      + (p.ymyl === 'health' ? ' Add a named reviewer line with a review date.' : '')
  },
  {
    id: 'R-THIRDPARTY', tier: 2, impact: 'medium', effort: 'surgical', check: 'thirdparty',
    suppressed: (s, p) => !['local_service', 'multi_location', 'b2b_technical'].includes(p.businessModel)
      && 'independent verification is not a lever for this business model',
    fires: (s) => !s.hasThirdPartyProof,
    trigger: () => 'no outbound links to independent verification',
    rec: 'Link to independent verification: a licensing registry, professional association, review platform, or press coverage.'
  }
];

// Observable, binary, and comparable across clients — which the old
// strong/moderate/weak grade was not. `n/a` renders where a rule is suppressed
// by client configuration, so the analyst can tell "not applicable here" from
// "missing", instead of the gating being invisible.
const TRUST_CHECKLIST = [
  { id: 'org',         label: 'Organization schema present and complete', met: (s) => s.hasOrganizationSchema && s.hasOrganizationSameAs },
  { id: 'address',     label: 'Visible physical address',                 met: (s) => s.hasVisibleAddress },
  { id: 'named',       label: 'Named individuals with roles',             met: (s) => s.hasNamedPeople },
  { id: 'credentials', label: 'Credentials or licensure surfaced',        met: (s) => !!s.hasCredentials },
  { id: 'thirdparty',  label: 'Third-party verification linked',          met: (s) => s.hasThirdPartyProof },
  { id: 'claims',      label: 'Specific claims (no unanchored assertions)', met: (s) => (s.unquantifiedClaims || []).length === 0 },
  { id: 'author',      label: 'Author byline with Person schema',         met: (s) => s.hasByline && s.hasPersonSchema },
  { id: 'reviews',     label: 'Reviews displayed',                        met: () => null }
];

const TRUST_CAVEAT = 'On-page analysis cannot observe off-site reputation, review corpus, or third-party mentions. For businesses with a local or reputational footprint, a substantial share of trust signal lives outside the site and is not represented in this section.';

/**
 * The engine. Pure: same inputs, same output, no I/O, no model.
 *
 * Returns fired rules with their trigger conditions, the suppressions and why,
 * the observable-signal checklist, informational findings, and the standing
 * caveat where it applies.
 */
function evaluateTrustRules(signals, client) {
  const s = signals || {};
  const p = trustProfileOf(client);

  const fired = [];
  const suppressed = [];

  TRUST_RULES.forEach(rule => {
    // Suppression is checked first and always wins. A rule blocked by client
    // configuration must never fire on the strength of a page observation.
    const why = rule.suppressed ? rule.suppressed(s, p) : false;
    if (why) { suppressed.push({ ruleId: rule.id, check: rule.check, reason: why }); return; }
    if (!rule.fires(s, p)) return;
    fired.push({
      ruleId: rule.id,
      tier: rule.tier,
      trigger: rule.trigger(s, p),
      recommendation: typeof rule.rec === 'function' ? rule.rec(s, p) : rule.rec,
      impact: rule.impact,
      effort: rule.effort,
      ...(rule.ceiling ? { ceiling: rule.ceiling } : {})
    });
  });

  // A checklist row is n/a when EVERY rule governing it was suppressed —
  // one rule firing means the signal is genuinely in play here.
  const suppressedChecks = new Set(suppressed.map(x => x.check));
  const activeChecks = new Set([...fired.map(f => TRUST_RULES.find(r => r.id === f.ruleId).check)]);
  const checklist = TRUST_CHECKLIST.map(item => {
    const governing = TRUST_RULES.filter(r => r.check === item.id);
    const allSuppressed = governing.length > 0
      && !activeChecks.has(item.id)
      && governing.every(r => suppressedChecks.has(r.check) ? true : (r.suppressed ? !!r.suppressed(s, p) : false));
    if (allSuppressed) {
      const reason = (suppressed.find(x => x.check === item.id) || {}).reason || 'not applicable to this client';
      return { id: item.id, label: item.label, state: 'na', reason };
    }
    const met = item.met(s, p);
    if (met === null) return { id: item.id, label: item.label, state: 'na', reason: 'not observable on-page' };
    return { id: item.id, label: item.label, state: met ? 'met' : 'unmet' };
  });

  const findings = [];
  if (s.hasAggregateRatingOnOrg) {
    // Informational, never an error. It does not trigger a manual action, and
    // removal is optional — Google still parses the property. The point is to
    // stop the client expecting stars it cannot get.
    findings.push({
      id: 'B-SELFSERVING-AUDIT',
      level: 'info',
      text: 'aggregateRating or Review markup is present on this site’s own LocalBusiness/Organization entity. It will not produce star rich results — Google excluded self-serving reviews on these types in 2019 — and it does not trigger a manual action. Removal is optional; the fix is to stop expecting stars.'
    });
  }

  return {
    fired,
    suppressed,
    checklist,
    findings,
    caveat: p.businessModel !== 'publisher' ? TRUST_CAVEAT : null,
    profile: p
  };
}

/** The engine's decisions as prompt text. Phrasing is the model's job; deciding is not. */
function trustRulesPromptBlock(result) {
  if (!result) return [];
  const lines = ['\n## E-E-A-T RULES (already evaluated — do not re-derive)'];
  lines.push('A deterministic rule engine has decided what is actionable on this page for this client.');
  lines.push('Phrase ONLY the rules listed under FIRED, against this page’s actual copy. Do not add trust recommendations of your own, and do not restate a suppressed rule.');

  if (result.fired.length) {
    lines.push('\nFIRED:');
    result.fired.forEach(f => {
      lines.push(`  ${f.ruleId} [${f.effort}/${f.impact}] — ${f.recommendation}`);
      lines.push(`     triggered by: ${f.trigger}`);
      if (f.ceiling) lines.push(`     ceiling (state this plainly): ${f.ceiling}`);
    });
  } else {
    lines.push('\nFIRED: none. Every trust signal this engine checks is either satisfied or not applicable — say so rather than inventing something.');
  }

  if (result.suppressed.length) {
    lines.push('\nSUPPRESSED (must not appear in any form):');
    result.suppressed.forEach(x => lines.push(`  ${x.ruleId} — ${x.reason}`));
  }

  result.findings.forEach(f => lines.push(`\nFINDING (${f.level}): ${f.text}`));
  if (result.caveat) lines.push(`\nStanding caveat to include verbatim: ${result.caveat}`);
  return lines;
}
