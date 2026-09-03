// Part of the extension background — see bg-core.js for how these files load.
// The single runtime.onMessage router every popup call arrives through.

// ─── Google Search Console: message handlers ────────────────────────────────

// Distinguishes "no case matched" from "a handler resolved to undefined", so
// unknown actions can fall through to other listeners instead of being
// answered with undefined.
const NOT_HANDLED = Symbol('not-handled');

function routeMessage(message) {
  switch (message?.action) {
    case 'gscGetStatus':       return gscGetStatus();
    case 'gscConnect':         return gscConnect();
    case 'gscDisconnect':      return gscDisconnect();
    case 'gscGetPageData':     return gscGetPageData(message);
    case 'gscGetQueryData':    return gscGetQueryData(message);
    case 'gscGetMoreQueries':  return gscGetMoreQueries(message);
    case 'gscGetQueriesData':  return gscGetQueriesData(message);
    case 'gscGetChartData':    return gscGetChartData(message);
    case 'gscResolveProperty': return gscResolveProperty(message);
    case 'gscSetProperty':     return gscSetProperty(message);
    case 'gscListProperties':  return gscListProperties();
    case 'gaGetStatus':        return gaGetStatus();
    case 'gaConnect':          return gaConnect();
    case 'gaDisconnect':       return gaDisconnect();
    case 'gaResolveProperty':  return gaResolveProperty(message);
    case 'gaSetProperty':      return gaSetProperty(message);
    case 'gaGetPageData':      return gaGetPageData(message);
    case 'gaGetPageUtmValues': return gaGetPageUtmValues(message);
    case 'gaGetChannelData':   return gaGetChannelData(message);
    case 'adsGetStatus':       return adsGetStatus();
    case 'adsConnect':         return adsConnect();
    case 'adsDisconnect':      return adsDisconnect();
    case 'adsResolveAccount':  return adsResolveAccount(message);
    case 'adsSetAccount':      return adsSetAccount(message);
    case 'adsGetPageData':     return adsGetPageData(message);
    case 'adsGetChartData':    return adsGetChartData(message);
    case 'adsGetMoreSearchTerms': return adsGetMoreSearchTerms(message);
    case 'adsGetAdsDetail':    return adsGetAdsDetail(message);
    case 'adsGetPageAdCopy':   return adsGetPageAdCopy(message);
    case 'adsGetCampaignNegLists': return adsGetCampaignNegLists(message);
    case 'adsGetAllAdGroups':  return adsGetAllAdGroups(message);
    case 'adsGetAllKeywords':  return adsGetAllKeywords(message);
    case 'adsAddNegatives':    return adsAddNegatives(message);
    case 'adsGetNegatives':    return adsGetNegatives(message);
    case 'adsGetKeywordIdeas': return adsGetKeywordIdeas(message);
    case 'adsAddKeywords':     return adsAddKeywords(message);
    case 'adsListCampaignsForBuild':  return adsListCampaignsForBuild(message);
    case 'adsGetCampaignAdGroupNames': return adsGetCampaignAdGroupNames(message);
    case 'adsCreateAdGroup':   return adsCreateAdGroup(message);
    case 'getRedirectInfo':    return getRedirectInfo(message);
    case 'traceUrl':           return traceUrl(message);
    case 'getTargetTab':       return getTargetTab();
    case 'injectContentScript': return injectContentScript(message);
    case 'openPopout':         return openPopoutWindow();
    case 'getDomainAge':       return getDomainAge(message);
    case 'dnsResolve':         return dnsResolve(message);
    case 'psiGetPageSpeed':    return psiGetPageSpeed(message);
    case 'checkLinks':         return checkLinkStatuses(message);
    // Announced by the content script when an overlay is toggled from the page
    // side (keyboard shortcut, or the toolbar menu). Chrome has no onShown, so
    // its checkmarks only stay right if something pushes them.
    case 'overlayStateChanged': syncToggleCheckmarks(); return { ok: true };
    case 'validateFavicon':    return validateFavicon(message);
    case 'clearFaviconCache':  return clearFaviconCache(message);
    case 'webceoGetStatus':      return webceoGetStatus();
    case 'webceoSaveConfig':     return webceoSaveConfig(message);
    case 'webceoDisconnect':     return webceoDisconnect();
    case 'webceoResolveProject': return webceoResolveProject(message);
    case 'webceoSetProject':     return webceoSetProject(message);
    case 'webceoGetRankings':    return webceoGetRankings(message);
    case 'webceoAddKeywords':    return webceoAddKeywords(message);
    case 'webceoGetTrackedKeywords': return webceoGetTrackedKeywords(message);
    case 'webceoGetKeywordTags': return webceoGetKeywordTags(message);
    case 'webceoGetBacklinks':   return webceoGetBacklinks(message);
    case 'webceoGetLostBacklinks':      return webceoGetLostBacklinks(message);
    case 'webceoGetLinkingDomains':     return webceoGetLinkingDomains(message);
    case 'webceoGetCompetitorMetrics':  return webceoGetCompetitorMetrics(message);
    case 'webceoGetCompetitors':        return webceoGetCompetitors(message);
    case 'webceoSetCompetitors':        return webceoSetCompetitors(message);
    case 'webceoGetSiteAudit':   return webceoGetSiteAudit(message);
    case 'webceoAddEvent':       return webceoAddEvent(message);
    case 'gaConnectEdit':        return gaConnectEdit();
    case 'ga4AddAnnotation':     return ga4AddAnnotation(message);
    case 'getChartAnnotations':  return getChartAnnotations(message);
    case 'docsConnect':          return docsConnect();
    case 'docsGetStatus':        return docsGetStatus();
    case 'docsDisconnect':       return docsDisconnect();
    case 'docsExportActionPlan': return docsExportActionPlan(message);
    case 'docsExportNegatives':  return docsExportNegatives(message);
    case 'docsExportAddKeywords': return docsExportAddKeywords(message);
    case 'sheetsExportBlindspotIdeas': return sheetsExportBlindspotIdeas(message);
    case 'sheetsExportGscQueries': return sheetsExportGscQueries(message);
    case 'sheetsExportPhrases':   return sheetsExportPhrases(message);
    case 'sheetsExportAdsTable': return sheetsExportAdsTable(message);
    case 'clientRegistryList':   return clientRegistryList();
    case 'clientRegistryGet':    return clientRegistryGet(message);
    case 'clientRegistryFindByDomain': return clientRegistryFindByDomain(message);
    case 'clientRegistrySave':   return clientRegistrySave(message);
    case 'clientRegistryDelete': return clientRegistryDelete(message);
    case 'clientRegistryAddDomain':      return clientRegistryAddDomain(message);
    case 'clientRegistryRemoveDomain':   return clientRegistryRemoveDomain(message);
    case 'clientRegistrySetBrandedTerms': return clientRegistrySetBrandedTerms(message);
    case 'clientRegistryAddBrandedTerm':  return clientRegistryAddBrandedTerm(message);
    case 'clientRegistrySetImageSeo': return clientRegistrySetImageSeo(message);
    case 'clientRegistrySetCompetitors': return clientRegistrySetCompetitors(message);
    case 'clientRegistrySetTrust':       return clientRegistrySetTrust(message);
    case 'serpClientIndex':      return serpClientIndex();
    case 'driveConnectBrowse':   return driveConnectBrowse();
    case 'driveListFolders':     return driveListFolders(message);
    case 'driveListSharedDrives': return driveListSharedDrives(message);
    case 'driveVerifyFolder':    return driveVerifyFolder(message);
    default: return NOT_HANDLED;
  }
}

// Firefox resolves a Promise returned straight from an onMessage listener;
// Chrome ignores it entirely and requires sendResponse + `return true`. The
// sendResponse form works on both, so it's the only one used here — returning
// the promise directly would make every handler resolve to undefined on
// Chrome, i.e. break the entire extension.
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const result = routeMessage(message);
  if (result === NOT_HANDLED) return false;   // let other listeners see it

  Promise.resolve(result).then(
    sendResponse,
    // A handler that throws would otherwise leave the caller hanging until
    // sendMessageWithTimeout's 30s timeout fires with a misleading message.
    err => sendResponse({ error: 'HANDLER_FAILED', detail: String((err && err.message) || err) })
  );
  return true;   // keep the channel open for the async reply
});
