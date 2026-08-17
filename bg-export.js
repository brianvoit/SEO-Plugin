// Part of the extension background — see bg-core.js for how these files load.
// Google Docs and Sheets exports.

// ─── Google Docs: Action Plan export ────────────────────────────────────────

// Only the Drive API is needed: we upload formatted HTML and let Drive convert
// it to a native Google Doc. This avoids the Docs API entirely (which would need
// a separate API enablement + the sensitive 'documents' scope).
const GOOGLE_DOCS_SCOPE = 'https://www.googleapis.com/auth/drive.file';

async function docsConnect() {
  return googleOAuthConnectRequireScope(GOOGLE_DOCS_SCOPE, 'docsAuth', 'DOCS_SCOPE_MISSING');
}

async function docsGetStatus() {
  const { docsAuth } = await browser.storage.local.get('docsAuth');
  return {
    connected: !!docsAuth,
    redirectUri: getGoogleRedirectUri(),
    connectedAt: docsAuth?.connectedAt ?? null,
    email: docsAuth ? await googleEnsureEmail('docsAuth') : null
  };
}

function docsDisconnect() {
  return googleDisconnect('docsAuth', ['docsFolderID']);
}

async function docsGetAccessToken() {
  return googleGetAccessToken('docsAuth');
}

const DOCS_FOLDER_NAME = 'Marketing Plans';
// Folder names this app has used before. An existing install already has a
// folder id cached, so changing the name above alone would only affect fresh
// installs — the rename has to be applied to the real folder.
const DOCS_FOLDER_LEGACY_NAMES = ['SEO Plans'];

// One-time relabel of the folder this app created under its old name. It keeps
// the same folder and the same id, so every export already in there stays
// exactly where it is. Best-effort: a failure here must never block an export.
async function docsRenameLegacyFolder(accessToken, folderId) {
  const auth = { Authorization: `Bearer ${accessToken}` };
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,trashed`, { headers: auth });
    if (res.ok) {
      const meta = await res.json();
      // Only touch a folder still carrying one of our old names — if the user
      // renamed it themselves, that's their choice and we leave it alone.
      if (!meta.trashed && DOCS_FOLDER_LEGACY_NAMES.includes(meta.name)) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}`, {
          method: 'PATCH',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: DOCS_FOLDER_NAME })
        });
      }
    }
    // Mark handled on any definitive answer (renamed, already fine, or gone) so
    // this costs exactly one extra request per install rather than one per export.
    await browser.storage.local.set({ docsFolderNamed: DOCS_FOLDER_NAME });
  } catch { /* offline — retried on the next export */ }
}

async function docsGetOrCreateFolder(accessToken) {
  const { docsFolderID, docsFolderNamed } = await browser.storage.local.get(['docsFolderID', 'docsFolderNamed']);
  if (docsFolderID) {
    if (docsFolderNamed !== DOCS_FOLDER_NAME) await docsRenameLegacyFolder(accessToken, docsFolderID);
    return docsFolderID;
  }

  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DOCS_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!res.ok) return null;
  const { id } = await res.json();
  // Freshly created with the current name — no migration needed later.
  await browser.storage.local.set({ docsFolderID: id, docsFolderNamed: DOCS_FOLDER_NAME });
  return id;
}

function htmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build the Action Plan as an HTML document. Drive's import converter maps
// h1/h2 → heading styles, b/i → bold/italic, and inline color styles → text color.
function buildActionPlanHtml(plan, docTitle, fetchedAt) {
  const GRAY = '#999999';
  const EFFORT_COLOR = { surgical: '#15803d', moderate: '#b45309', rewrite: '#808080' };
  const out = [];

  out.push(`<h1>${htmlEsc(docTitle)}</h1>`);
  const dateStr = new Date(fetchedAt || Date.now()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  out.push(`<p style="color:${GRAY};font-size:10pt">Generated ${htmlEsc(dateStr)}</p>`);

  const TIERS = [
    { effort: 'surgical', title: 'Quick wins' },
    { effort: 'moderate', title: 'Recommended' },
    { effort: 'rewrite',  title: 'Heavy lift' }
  ];
  TIERS.forEach(tier => {
    const recs = (plan.recommendations || []).filter(rec => rec.effort === tier.effort);
    if (!recs.length) return;
    out.push(`<h2>${htmlEsc(tier.title)}</h2>`);
    const color = EFFORT_COLOR[tier.effort];
    recs.forEach(rec => {
      out.push(`<p style="font-size:12pt"><b>${htmlEsc(rec.change)}</b></p>`);
      const ch = rec.channel === 'both' ? 'SEO + Paid' : rec.channel === 'paid' ? 'Paid' : 'SEO';
      const impactStr = (rec.impact ? `${tier.title} · ${rec.impact} impact` : tier.title) + ` · ${ch}`;
      out.push(`<p style="color:${color};font-size:10pt">${htmlEsc(impactStr)}</p>`);
      if (rec.evidence) out.push(`<p style="color:${GRAY}"><i>${htmlEsc(rec.evidence)}</i></p>`);
    });
  });

  if (plan.contentGaps && plan.contentGaps.length) {
    out.push('<h2>Content gaps</h2>');
    out.push(`<p>${htmlEsc(plan.contentGaps.join(', '))}</p>`);
  }

  const gap = plan.intentGap;
  if (gap && gap.pageIntent) {
    out.push('<h2>Intent gap</h2>');
    out.push(`<p><b>${htmlEsc(gap.pageIntent)} → ${htmlEsc(gap.trafficIntent || '')}</b></p>`);
    if (gap.summary) out.push(`<p style="color:${GRAY}"><i>${htmlEsc(gap.summary)}</i></p>`);
    if (gap.suggestions && gap.suggestions.length) {
      out.push('<p><b>Phrase suggestions:</b></p>');
      out.push(`<p>${htmlEsc(gap.suggestions.join(' / '))}</p>`);
    }
  }

  const eeat = plan.eeat;
  if (eeat && eeat.score) {
    out.push('<h2>E-E-A-T Signals</h2>');
    const scoreLabel = eeat.score.charAt(0).toUpperCase() + eeat.score.slice(1);
    out.push(`<p><b>Score: ${htmlEsc(scoreLabel)}</b></p>`);
    (eeat.signals || []).forEach(s => {
      out.push(`<p><b>${htmlEsc(s.dimension)}:</b> ${htmlEsc(s.observation)}</p>`);
    });
    if (eeat.gaps && eeat.gaps.length) {
      out.push('<p><b>Improvements:</b></p>');
      out.push('<ul>' + eeat.gaps.map(g => `<li>${htmlEsc(g)}</li>`).join('') + '</ul>');
    }
  }

  return `<html><head><meta charset="utf-8"></head><body>${out.join('')}</body></html>`;
}

// Derive a "host/path" label for a doc title from a page URL.
function docsUrlLabel(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const h = u.hostname.replace(/^www\./, '');
    const p = u.pathname.replace(/\/$/, '');
    return p ? `${h}${p}` : h;
  } catch { return 'page'; }
}

// Multipart-upload an HTML body to Drive, which converts it to a native Google
// Doc. Shared by every "Export to Google Doc" path. Returns { url } or
// { notConnected, error } / { error, detail }.
async function docsUploadHtmlDoc(accessToken, docTitle, html, folderId) {
  const metadata = { name: docTitle, mimeType: 'application/vnd.google-apps.document' };
  if (folderId) metadata.parents = [folderId];

  const boundary = '----marketingInspectorBoundary' + Date.now();
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: text/html; charset=UTF-8\r\n\r\n' +
    html + '\r\n' +
    `--${boundary}--`;

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401) {
      await browser.storage.local.remove('docsAuth');
      return { notConnected: true, error: 'REAUTH_REQUIRED' };
    }
    return { error: 'CREATE_FAILED', detail };
  }
  const { id } = await res.json();
  return { url: `https://docs.google.com/document/d/${id}/edit` };
}

async function docsExportActionPlan({ plan, pageUrl, fetchedAt }) {
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  const { folderId } = await resolveExportFolder(token.accessToken, pageUrl, DRIVE_PLANS_SUBDIR);
  const date = new Date().toISOString().slice(0, 10);
  const docTitle = `${date}: Action Plan For ${docsUrlLabel(pageUrl)}`;
  const html = buildActionPlanHtml(plan, docTitle, fetchedAt);
  return docsUploadHtmlDoc(token.accessToken, docTitle, html, folderId);
}

// Negative keywords as nested bullets: one bullet per exclusion list, with its
// terms (match type shown as punctuation) nested beneath. Drive maps the nested
// <ul> to indented bullets in the Doc.
function negFormatTerm(text, matchType) {
  const mt = String(matchType || '').toUpperCase();
  if (mt === 'EXACT')  return `[${text}]`;
  if (mt === 'PHRASE') return `"${text}"`;
  return String(text);
}

function buildNegativesHtml(lists, docTitle) {
  const out = [`<h1>${htmlEsc(docTitle)}</h1>`];
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  out.push(`<p style="color:#999999;font-size:10pt">Generated ${htmlEsc(dateStr)}</p>`);
  out.push('<ul>');
  (lists || []).forEach(list => {
    out.push(`<li>Added Negatives to ${htmlEsc(list.campaignName || 'Campaign')} &rarr;&nbsp;&nbsp;${htmlEsc(list.name)}<ul>`);
    (list.terms || []).forEach(t => out.push(`<li>${htmlEsc(negFormatTerm(t.text, t.matchType))}</li>`));
    out.push('</ul></li>');
  });
  out.push('</ul>');
  return `<html><head><meta charset="utf-8"></head><body>${out.join('')}</body></html>`;
}

async function docsExportNegatives({ lists, pageUrl }) {
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  const { folderId } = await resolveExportFolder(token.accessToken, pageUrl, DRIVE_PLANS_SUBDIR);
  const date = new Date().toISOString().slice(0, 10);
  const docTitle = `${date}: Negative Keywords For ${docsUrlLabel(pageUrl)}`;
  const html = buildNegativesHtml(lists, docTitle);
  return docsUploadHtmlDoc(token.accessToken, docTitle, html, folderId);
}

// New keywords as nested bullets: one bullet per ad group, with its added
// keywords (match type shown as punctuation, same convention as negatives)
// nested beneath.
function buildAddKeywordsHtml(groups, docTitle) {
  const out = [`<h1>${htmlEsc(docTitle)}</h1>`];
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  out.push(`<p style="color:#999999;font-size:10pt">Generated ${htmlEsc(dateStr)}</p>`);
  out.push('<ul>');
  (groups || []).forEach(group => {
    const label = group.campaignName ? `${group.campaignName} | ${group.adGroupName || 'Ad Group'}` : (group.adGroupName || 'Ad Group');
    out.push(`<li>Added Keywords to ${htmlEsc(label)}<ul>`);
    (group.terms || []).forEach(t => out.push(`<li>${htmlEsc(negFormatTerm(t.text, t.matchType))}</li>`));
    out.push('</ul></li>');
  });
  out.push('</ul>');
  return `<html><head><meta charset="utf-8"></head><body>${out.join('')}</body></html>`;
}

async function docsExportAddKeywords({ groups, pageUrl }) {
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  const { folderId } = await resolveExportFolder(token.accessToken, pageUrl, DRIVE_PLANS_SUBDIR);
  const date = new Date().toISOString().slice(0, 10);
  const docTitle = `${date}: Added Keywords For ${docsUrlLabel(pageUrl)}`;
  const html = buildAddKeywordsHtml(groups, docTitle);
  return docsUploadHtmlDoc(token.accessToken, docTitle, html, folderId);
}

// ─── Google Sheets: per-domain keyword-brainstorm history ──────────────────
// Reuses the same drive.file grant as the Docs exports above — drive.file
// covers files the app creates via any Google Workspace API using that
// token, including Sheets-API-created spreadsheets, so no separate OAuth
// scope/connection is needed. One spreadsheet per domain (cached by domain
// in sheetsSpreadsheetIds), a single fixed tab ("Blindspot Ideas") that every
// export appends rows to — never a new tab per run — so the sheet reads as
// one continuously growing history log.

const SHEETS_TAB_NAME = 'Blindspot Ideas';
const SHEETS_HEADER_ROW = ['Date Added', 'Page URL', 'Keyword', 'Status', 'Confidence', 'Match Type', 'Volume', 'Competition', 'Reason'];
const SHEETS_SPREADSHEET_CACHE_CAP = 50;

const SHEETS_STATUS_LABEL = {
  already_suggested: 'Filtered: already suggested',
  branded:            'Filtered: branded term',
  already_targeted:   'Filtered: already targeted',
  no_volume:           'Filtered: no search volume',
};

function sheetsDomainFromUrl(pageUrl) {
  try { return new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
}

// Finds (or creates) the one spreadsheet for a cache key (one per domain per
// export kind — blindspot keys are the bare domain for back-compat with IDs
// cached before other export kinds existed). A cached ID is verified before
// trust — the user may have deleted the file in Drive since last export — and
// silently recreated on 404/trashed, matching the same no-warning precedent
// as docsGetOrCreateFolder above.
// Writes a tab's header row. Called once per tab at creation time only —
// never on append, so a user who renames a column keeps their rename.
async function sheetsWriteHeader(accessToken, spreadsheetId, tabName, headerRow) {
  const endCol = String.fromCharCode(64 + headerRow.length);   // ≤26 columns
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${tabName}'!A1:${endCol}1`)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [headerRow] })
    }
  ).catch(() => {});
}

// Adds any of `tabs` the spreadsheet doesn't already carry. Needed because a
// multi-tab export can land on a spreadsheet created by an EARLIER version of
// that export (or by a single-table export that only ever made one tab) — the
// cached id is still the right file, it's just missing sheets. Best-effort:
// a failure here leaves the append to fail loudly on its own.
async function sheetsEnsureTabs(accessToken, spreadsheetId, tabs) {
  if (!Array.isArray(tabs) || !tabs.length) return;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  ).catch(() => null);
  if (!res || !res.ok) return;

  const data = await res.json();
  const existing = new Set((data.sheets || []).map(s => s.properties && s.properties.title));
  const missing = tabs.filter(t => !existing.has(t.name));
  if (!missing.length) return;

  const addRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: missing.map(t => ({ addSheet: { properties: { title: t.name } } })) })
  }).catch(() => null);
  if (!addRes || !addRes.ok) return;

  for (const t of missing) await sheetsWriteHeader(accessToken, spreadsheetId, t.name, t.headerRow);
}

// `tabs` (optional) creates a MULTI-tab spreadsheet — one per n-gram size for
// the phrases export — instead of the single `tabName` every other caller uses.
async function sheetsGetOrCreateSpreadsheet(accessToken, cacheKey, { title, tabName, headerRow, pageUrl, tabs }) {
  const { folderId: targetFolderId } = await resolveExportFolder(accessToken, pageUrl, DRIVE_EXPORTS_SUBDIR);

  const { sheetsSpreadsheetIds } = await browser.storage.local.get('sheetsSpreadsheetIds');
  const cache = sheetsSpreadsheetIds || {};
  const cached = cache[cacheKey];
  if (cached && cached.id) {
    const check = await fetch(`https://www.googleapis.com/drive/v3/files/${cached.id}?fields=id,trashed,parents&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    }).catch(() => null);
    if (check && check.ok) {
      const meta = await check.json();
      if (!meta.trashed) {
        // Re-parent, don't duplicate: the file may predate a Client folder
        // being attached (or the attached folder changing) since this sheet
        // was first created. Moving it preserves its append history instead
        // of silently forking a second copy of it.
        const currentParents = meta.parents || [];
        if (targetFolderId && !currentParents.includes(targetFolderId)) {
          const removeQ = currentParents.length ? `&removeParents=${currentParents.join(',')}` : '';
          await fetch(
            `https://www.googleapis.com/drive/v3/files/${cached.id}?addParents=${targetFolderId}${removeQ}&supportsAllDrives=true`,
            { method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}` } }
          ).catch(() => {});
        }
        await sheetsEnsureTabs(accessToken, cached.id, tabs);
        return { id: cached.id };
      }
    }
    // 404, trashed, or network error: fall through and recreate below.
  }

  const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title },
      sheets: (tabs && tabs.length ? tabs.map(t => t.name) : [tabName]).map(t => ({ properties: { title: t } }))
    })
  });
  if (!createRes.ok) {
    const detail = await createRes.text().catch(() => '');
    if (createRes.status === 401) {
      await browser.storage.local.remove('docsAuth');
      return { notConnected: true, error: 'REAUTH_REQUIRED' };
    }
    return { error: 'CREATE_FAILED', detail };
  }
  const { spreadsheetId } = await createRes.json();

  // Sheets-API-created files land at Drive root — re-parent into the
  // resolved export folder (a Client's own SEO Inspector/Exports, or the
  // shared Marketing Plans folder for domains with no Client attached).
  // Best-effort: still usable at Drive root if this fails.
  if (targetFolderId) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}?addParents=${targetFolderId}&removeParents=root&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}` }
    }).catch(() => {});
  }

  // Header rows, written once at creation time only.
  if (tabs && tabs.length) {
    for (const t of tabs) await sheetsWriteHeader(accessToken, spreadsheetId, t.name, t.headerRow);
  } else {
    await sheetsWriteHeader(accessToken, spreadsheetId, tabName, headerRow);
  }

  cache[cacheKey] = { id: spreadsheetId, updatedAt: Date.now() };
  await writeCache('sheetsSpreadsheetIds', cache, SHEETS_SPREADSHEET_CACHE_CAP);
  return { id: spreadsheetId };
}

async function sheetsAppendRows(accessToken, spreadsheetId, tabName, rows) {
  const range = encodeURIComponent(`'${tabName}'!A1`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows })
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401) {
      await browser.storage.local.remove('docsAuth');
      return { notConnected: true, error: 'REAUTH_REQUIRED' };
    }
    return { error: 'APPEND_FAILED', detail };
  }
  return { ok: true };
}

async function sheetsExportBlindspotIdeas({ ideas, pageUrl }) {
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  if (!Array.isArray(ideas) || !ideas.length) return { error: 'NO_IDEAS' };

  const domain = sheetsDomainFromUrl(pageUrl);
  const sheet = await sheetsGetOrCreateSpreadsheet(token.accessToken, domain, {
    title: `Ads Inspector Blindspot Ideas — ${domain}`,
    tabName: SHEETS_TAB_NAME,
    headerRow: SHEETS_HEADER_ROW,
    pageUrl
  });
  if (sheet.notConnected || sheet.error) return sheet;

  const dateAdded = new Date().toISOString().slice(0, 10);
  const rows = ideas.map(r => [
    dateAdded, pageUrl, r.text,
    SHEETS_STATUS_LABEL[r.filterReason] || 'Kept',
    r.confidence || '', r.matchType || '', r.volume ?? '', r.competition || '', r.reason || ''
  ]);

  const appendRes = await sheetsAppendRows(token.accessToken, sheet.id, SHEETS_TAB_NAME, rows);
  if (appendRes.notConnected || appendRes.error) return appendRes;

  return { url: `https://docs.google.com/spreadsheets/d/${sheet.id}/edit` };
}

// ─── Google Sheets: Search-tab query export ─────────────────────────────────
// Same one-spreadsheet-per-domain history-log model as the blindspot export
// above, but its own file + tab ("Search Queries"). Rows arrive pre-formatted
// from the popup (which owns the intent classifications and Ads enrichment);
// this handler just prepends the export date/range/page context.

const SHEETS_GSC_TAB_NAME = 'Search Queries';
const SHEETS_GSC_HEADER_ROW = [
  'Date Exported', 'Range (days)', 'Page URL',
  'Query', 'Intent', 'Clicks', 'Impressions', 'CTR %', 'Position', 'Volume', 'CPC ($)', 'Difficulty'
];

async function sheetsExportGscQueries({ rows, pageUrl, rangeDays }) {
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  if (!Array.isArray(rows) || !rows.length) return { error: 'NO_ROWS' };

  const domain = sheetsDomainFromUrl(pageUrl);
  const sheet = await sheetsGetOrCreateSpreadsheet(token.accessToken, `gsc-queries::${domain}`, {
    title: `Search Inspector Queries — ${domain}`,
    tabName: SHEETS_GSC_TAB_NAME,
    headerRow: SHEETS_GSC_HEADER_ROW,
    pageUrl
  });
  if (sheet.notConnected || sheet.error) return sheet;

  const dateAdded = new Date().toISOString().slice(0, 10);
  const values = rows.map(r => [dateAdded, rangeDays || '', pageUrl, ...r]);

  const appendRes = await sheetsAppendRows(token.accessToken, sheet.id, SHEETS_GSC_TAB_NAME, values);
  if (appendRes.notConnected || appendRes.error) return appendRes;

  return { url: `https://docs.google.com/spreadsheets/d/${sheet.id}/edit` };
}

// ─── Google Sheets: Keyword Phrases export ──────────────────────────────────
// Same one-spreadsheet-per-domain history-log model as the exports above, but
// with one TAB per n-gram size rather than a single sheet — a 1-word list and
// a 4-word list are different enough that stacking them behind a "Words"
// column makes both harder to read and to sort.
//
// Rows arrive fully formed from popup-phrases.js, which owns the placement
// chips, brand matching and the GSC/volume merge; the tab names and the
// header row are owned here so an export of one table and an export of all
// four land in exactly the same shape.

const SHEETS_PHRASES_TAB_NAMES = { 1: 'One Word', 2: 'Two Words', 3: 'Three Words', 4: 'Four Words' };
const SHEETS_PHRASES_HEADER_ROW = [
  'Date Exported', 'Page URL',
  'Phrase', 'Count', 'Density %', 'Prominence', 'Placement',
  'Clicks', 'Impressions', 'Position', 'Volume', 'Competition', 'Est. CPC'
];

async function sheetsExportPhrases({ tables, pageUrl }) {
  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  // Only tables that actually carry rows: exporting a single table shouldn't
  // append a bare date/URL line to the other three.
  const wanted = (Array.isArray(tables) ? tables : [])
    .filter(t => t && SHEETS_PHRASES_TAB_NAMES[t.size] && Array.isArray(t.rows) && t.rows.length);
  if (!wanted.length) return { error: 'NO_ROWS' };

  const domain = sheetsDomainFromUrl(pageUrl);
  // Every size's tab is declared regardless of what's being exported now, so
  // the spreadsheet always has the same four tabs and a later single-table
  // export never has to create one mid-flight.
  const allTabs = Object.values(SHEETS_PHRASES_TAB_NAMES)
    .map(name => ({ name, headerRow: SHEETS_PHRASES_HEADER_ROW }));

  const sheet = await sheetsGetOrCreateSpreadsheet(token.accessToken, `phrases::${domain}`, {
    title: `Keyword Phrases — ${domain}`,
    tabName: allTabs[0].name,
    headerRow: SHEETS_PHRASES_HEADER_ROW,
    pageUrl,
    tabs: allTabs
  });
  if (sheet.notConnected || sheet.error) return sheet;

  const dateAdded = new Date().toISOString().slice(0, 10);
  for (const t of wanted) {
    const values = t.rows.map(r => [dateAdded, pageUrl, ...r]);
    const appendRes = await sheetsAppendRows(token.accessToken, sheet.id, SHEETS_PHRASES_TAB_NAMES[t.size], values);
    if (appendRes.notConnected || appendRes.error) return appendRes;
  }

  return { url: `https://docs.google.com/spreadsheets/d/${sheet.id}/edit` };
}

// ─── Google Sheets: Ads-tab table exports (Keywords / Search Terms) ─────────
// Same history-log model again; one spreadsheet per domain per table.

const SHEETS_ADS_TABLES = {
  keywords: {
    tabName: 'Ads Keywords',
    title: d => `Ads Inspector Keywords — ${d}`,
    cacheKey: d => `ads-keywords::${d}`,
    headerRow: ['Date Exported', 'Range (days)', 'Page URL',
      'Keyword', 'Match Type', 'Intent', 'QS', 'Impressions', 'Clicks', 'Cost', 'Conversions', 'Volume', 'CPC ($)', 'Competition']
  },
  terms: {
    tabName: 'Search Terms',
    title: d => `Ads Inspector Search Terms — ${d}`,
    cacheKey: d => `ads-terms::${d}`,
    headerRow: ['Date Exported', 'Range (days)', 'Page URL',
      'Search Term', 'Intent', 'Impressions', 'Clicks', 'Cost', 'Conversions', 'Volume', 'CPC ($)', 'Competition']
  }
};

async function sheetsExportAdsTable({ table, rows, pageUrl, rangeDays }) {
  const cfg = SHEETS_ADS_TABLES[table];
  if (!cfg) return { error: 'BAD_TABLE' };

  const token = await docsGetAccessToken();
  if (token.error) return { notConnected: true, error: token.error };

  if (!Array.isArray(rows) || !rows.length) return { error: 'NO_ROWS' };

  const domain = sheetsDomainFromUrl(pageUrl);
  const sheet = await sheetsGetOrCreateSpreadsheet(token.accessToken, cfg.cacheKey(domain), {
    title: cfg.title(domain),
    tabName: cfg.tabName,
    headerRow: cfg.headerRow,
    pageUrl
  });
  if (sheet.notConnected || sheet.error) return sheet;

  const dateAdded = new Date().toISOString().slice(0, 10);
  const values = rows.map(r => [dateAdded, rangeDays || '', pageUrl, ...r]);

  const appendRes = await sheetsAppendRows(token.accessToken, sheet.id, cfg.tabName, values);
  if (appendRes.notConnected || appendRes.error) return appendRes;

  return { url: `https://docs.google.com/spreadsheets/d/${sheet.id}/edit` };
}
