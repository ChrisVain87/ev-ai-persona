/**
 * CookieAnalyzer — Third-Party Cookie Intelligence
 * ──────────────────────────────────────────────────
 * Reads first-party cookies deposited by advertising & analytics platforms
 * (Google Analytics, Google Ads, Facebook Pixel, LinkedIn Insight, Microsoft Ads,
 *  Twitter/X, TikTok, etc.) to infer audience segment memberships, traffic source,
 *  recency, and purchase intent signals.
 *
 * NOTE: These are first-party cookies (set on YOUR domain by the analytics scripts
 * the site loads). They are not cross-origin third-party cookies — those are
 * inaccessible to JavaScript by browser design and SameSite policy.
 */
class CookieAnalyzer {
  constructor(options = {}) {
    this.debug = options.debug || false;
  }

  // ── Public entry point ───────────────────────────────────────────────────
  analyze() {
    const all      = this._getAllCookies();
    const ls       = this._getLocalStorageSignals();

    const google   = this._analyzeGoogle(all);
    const facebook = this._analyzeFacebook(all);
    const linkedin = this._analyzeLinkedIn(all, ls);
    const microsoft= this._analyzeMicrosoft(all);
    const tiktok   = this._analyzeTikTok(all, ls);
    const twitter  = this._analyzeTwitter(all, ls);
    const criteo   = this._analyzeCriteo(all);
    const adobe    = this._analyzeAdobe(all);

    const insights = this._synthesize({ google, facebook, linkedin, microsoft, tiktok, twitter, criteo, adobe, all });

    if (this.debug) console.log('[CookieAnalyzer]', { all, google, facebook, linkedin, insights });

    return { raw: all, google, facebook, linkedin, microsoft, tiktok, twitter, criteo, adobe, insights };
  }

  // ── Cookie reader ─────────────────────────────────────────────────────────
  _getAllCookies() {
    const map = {};
    try {
      document.cookie.split(';').forEach(c => {
        const [k, ...vParts] = c.trim().split('=');
        if (k) map[k.trim()] = decodeURIComponent(vParts.join('=') || '');
      });
    } catch { /* privacy mode */ }
    return map;
  }

  // ── LocalStorage / SessionStorage signals ─────────────────────────────────
  _getLocalStorageSignals() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) out[k] = localStorage.getItem(k);
      }
    } catch { /* blocked */ }
    return out;
  }

  // ── Google Analytics & Ads ────────────────────────────────────────────────
  _analyzeGoogle(c) {
    // _ga format: GA1.1.<random>.<timestamp>
    const gaRaw  = c['_ga'] || c['_ga_XXXXXXXXX'] || Object.keys(c).find(k => /^_ga$/.test(k)) && c[Object.keys(c).find(k => /^_ga$/.test(k))];
    const gidRaw = c['_gid'];

    let gaCreatedAt = null, gaDaysSinceCreation = null, gaIsLongTermUser = false;
    if (gaRaw) {
      const parts = gaRaw.split('.');
      if (parts.length === 4) {
        const ts = parseInt(parts[3], 10);
        if (!isNaN(ts) && ts > 1e8) {
          gaCreatedAt = new Date(ts * 1000).toISOString();
          gaDaysSinceCreation = Math.floor((Date.now() / 1000 - ts) / 86400);
          gaIsLongTermUser    = gaDaysSinceCreation > 365;
        }
      }
    }

    // Google Ads conversion cookies
    const gclau  = c['_gcl_au'];    // Conversion linker
    const gcldc  = c['_gcl_dc'];    // Display & Video 360 conversion
    const gclgb  = c['_gcl_gb'];    // Google Ads
    const gclha  = c['_gcl_ha'];    // Google Ads help
    const gacKeys= Object.keys(c).filter(k => k.startsWith('_gac_'));
    const hasGoogleAds = !!(gclau || gcldc || gclgb || gclha || gacKeys.length);

    // GA4 measurement ID cookies
    const ga4Keys = Object.keys(c).filter(k => /^_ga_[A-Z0-9]+$/.test(k));

    // Google Optimize (A/B test data from Google side)
    const gaOptimize = c['_gaexp'] || null;

    return {
      hasGA:             !!gaRaw,
      gaClientId:        gaRaw || null,
      gaCreatedAt,
      gaDaysSinceCreation,
      gaIsLongTermUser,
      hasActiveSession:  !!gidRaw,
      hasGoogleAds,
      hasConversionTracking: gacKeys.length > 0,
      ga4Properties:     ga4Keys.length,
      hasGoogleOptimize: !!gaOptimize,
      signals: {
        // Long-term GA user → familiar with digital purchases, higher LTV
        digitalBuyer:    gaIsLongTermUser,
        // Active GA session + Google Ads = came from a paid campaign
        paidSearchVisit: hasGoogleAds && !!gidRaw,
        // Has conversion tracking = brand runs DR campaigns
        highIntent:      hasGoogleAds
      }
    };
  }

  // ── Facebook / Meta Pixel ─────────────────────────────────────────────────
  _analyzeFacebook(c) {
    // _fbp format: fb.1.<timestamp>.<random>   (Browser ID)
    // _fbc format: fb.1.<timestamp>.<click_id>  (Click ID from fbclid param)
    const fbp = c['_fbp'];
    const fbc = c['_fbc'];

    let fbpCreatedAt = null;
    if (fbp) {
      const parts = fbp.split('.');
      if (parts.length >= 3) {
        const ts = parseInt(parts[2], 10);
        if (!isNaN(ts)) fbpCreatedAt = new Date(ts).toISOString();
      }
    }

    let fbClickedAt = null;
    if (fbc) {
      const parts = fbc.split('.');
      if (parts.length >= 3) {
        const ts = parseInt(parts[2], 10);
        if (!isNaN(ts)) fbClickedAt = new Date(ts).toISOString();
      }
    }

    // Meta advanced matching signals (encrypted, but presence tells us remarketing is active)
    const frCookie = c['fr'];   // Facebook ad targeting cookie

    return {
      hasFBPixel:         !!fbp,
      hasClickId:         !!fbc,
      fbBrowserId:        fbp || null,
      fbClickId:          fbc || null,
      fbpCreatedAt,
      fbClickedAt,
      isMetaAudienceMember: !!frCookie,
      signals: {
        // Came from a Facebook/Instagram ad click
        socialAdClick:   !!fbc,
        // Facebook user (pixel fires) → social/visual content consumer
        facebookUser:    !!fbp,
        // Recent click → very high intent
        recentAdClick:   !!fbc && fbClickedAt && (Date.now() - new Date(fbClickedAt)) < 7_200_000
      }
    };
  }

  // ── LinkedIn Insight Tag ─────────────────────────────────────────────────
  _analyzeLinkedIn(c, ls) {
    // LinkedIn sets these cookies after Insight Tag fires:
    const liAts  = c['li_at'];         // LinkedIn session (if logged in, rarely readable)
    const liSugr = c['li_sugr'];       // LinkedIn user ID (hashed)
    const liGc   = c['li_gc'];         // GDPR consent
    const AnalyticsUUID = c['AnalyticsUUID'];  // LinkedIn analytics
    const lidio  = c['lidio'];
    const bscookie = c['bscookie'];    // LinkedIn Ads
    const lmsAds = ls['li_lms_ads'];   // LinkedIn localStorage

    const hasLinkedIn = !!(liSugr || AnalyticsUUID || lidio || bscookie || lmsAds);

    return {
      hasInsightTag:      hasLinkedIn,
      hasLinkedInSession: !!liAts,
      hasAdTracking:      !!bscookie,
      signals: {
        // LinkedIn professional = B2B, higher income, decision maker
        isProfessional:  hasLinkedIn,
        isB2BLead:       !!bscookie,         // LinkedIn Ad click
        isDecisionMaker: !!liAts && !!liSugr // logged-in LinkedIn + insight = senior
      }
    };
  }

  // ── Microsoft Advertising (Bing Ads) ─────────────────────────────────────
  _analyzeMicrosoft(c) {
    const uetq = c['_uetq'];      // Universal Event Tracking
    const muid = c['MUID'];       // Microsoft User ID
    const ms   = c['_msptc'];     // Microsoft ad targeting

    return {
      hasBingAds:   !!(uetq || muid),
      signals: {
        // Bing users skew older (35-60), higher disposable income
        olderDemographic: !!(muid),
        enterpriseUser:   !!(uetq && muid)  // enterprise segment uses Bing often
      }
    };
  }

  // ── TikTok Pixel ─────────────────────────────────────────────────────────
  _analyzeTikTok(c, ls) {
    const ttclid = c['ttclid'] || new URLSearchParams(location.search).get('ttclid');
    const tiktokPixel = ls['_ttp'] || c['_ttp'];

    return {
      hasTikTokPixel: !!tiktokPixel,
      hasClickId:     !!ttclid,
      signals: {
        // TikTok = younger demographic (18-34), impulse buyers
        youngDemographic: !!tiktokPixel,
        visualContentConsumer: !!tiktokPixel,
        recentAdClick: !!ttclid
      }
    };
  }

  // ── Twitter / X Ads ──────────────────────────────────────────────────────
  _analyzeTwitter(c, ls) {
    const twclid = new URLSearchParams(location.search).get('twclid');
    const personalization = c['personalization_id'];
    const twitterUuid = ls['tw_uuid'];

    return {
      hasTwitterPixel:  !!personalization,
      hasClickId:       !!twclid,
      signals: {
        earlyAdopter:  !!twitterUuid,     // Twitter users skew tech-savvy
        opinionLeader: !!personalization
      }
    };
  }

  // ── Criteo (Retargeting network) ─────────────────────────────────────────
  _analyzeCriteo(c) {
    const uid  = c['uid'];
    const evt  = c['cto_bundle'] || c['cto_sid'];  // Criteo event/session
    const bidId= c['crto_is_user_optout'];

    return {
      hasCriteo: !!(uid && evt),
      signals: {
        // Criteo = already been to other e-commerce sites, active shopper
        activeShopper:   !!(uid && evt),
        highPurchaseIntent: !!evt
      }
    };
  }

  // ── Adobe Analytics / Audience Manager ──────────────────────────────────
  _analyzeAdobe(c) {
    const adobeId  = c['s_ecid'] || c['s_vi'] || c['AMCVS_'];
    const adobeKey = Object.keys(c).find(k => k.startsWith('AMCVS_') || k.startsWith('s_vi'));
    return {
      hasAdobe: !!(adobeId || adobeKey),
      signals: {
        // Adobe → enterprise-scale website = potentially B2B, larger company visitor
        enterpriseVisitor: !!(adobeId || adobeKey)
      }
    };
  }

  // ── Synthesize cross-platform insights ───────────────────────────────────
  _synthesize({ google, facebook, linkedin, microsoft, tiktok, twitter, criteo, adobe }) {
    const platforms  = [];
    const segments   = new Set();
    const boosts     = { wealth: 0, family: 0, performance: 0, eco: 0, tech: 0, intent: 0 };

    // Aggregate platform presence
    if (google.hasGA)                platforms.push('Google Analytics');
    if (google.hasGoogleAds)         { platforms.push('Google Ads'); boosts.intent += 15; }
    if (facebook.hasFBPixel)         { platforms.push('Meta Pixel'); boosts.intent += 10; }
    if (facebook.hasClickId)         { platforms.push('Meta Ad Click'); boosts.intent += 25; }
    if (linkedin.hasInsightTag)      { platforms.push('LinkedIn'); boosts.wealth += 15; boosts.tech += 10; }
    if (linkedin.isB2BLead)          { segments.add('B2B Professional'); boosts.wealth += 10; }
    if (microsoft.hasBingAds)        { platforms.push('Microsoft Ads'); boosts.wealth += 8; }
    if (tiktok.hasTikTokPixel)       { platforms.push('TikTok'); }
    if (twitter.hasTwitterPixel)     { platforms.push('Twitter/X'); boosts.tech += 8; }
    if (criteo.hasCriteo)            { platforms.push('Criteo'); boosts.intent += 20; }
    if (adobe.hasAdobe)              { platforms.push('Adobe'); boosts.wealth += 5; }

    // Audience segment inference
    if (google.gaIsLongTermUser)     segments.add('Long-Term Web User');
    if (linkedin.isProfessional)     segments.add('Professional');
    if (tiktok.youngDemographic)     segments.add('Young Adult (18-34)');
    if (microsoft.olderDemographic)  segments.add('Mature Demographic (35+)');
    if (criteo.activeShopper)        segments.add('Active Online Shopper');
    if (facebook.hasFBPixel && !linkedin.hasInsightTag) segments.add('Consumer (B2C)');

    // Purchase intent tier
    const intentSignals = [
      google.signals.highIntent,
      facebook.signals.recentAdClick,
      linkedin.signals.isB2BLead,
      criteo.signals.highPurchaseIntent
    ].filter(Boolean).length;

    const intentTier = intentSignals >= 3 ? 'HIGH' : intentSignals >= 1 ? 'MEDIUM' : 'LOW';

    return {
      detectedPlatforms:    platforms,
      audienceSegments:     Array.from(segments),
      intentTier,
      scoreBoosts:          boosts,
      platformCount:        platforms.length,
      isMultiTouchVisitor:  platforms.length >= 3,
      hasPaidTraffic:       google.hasGoogleAds || facebook.hasClickId || linkedin.isB2BLead || microsoft.hasBingAds,
      inRetargetingPool:    criteo.hasCriteo || (google.hasGoogleAds && google.hasConversionTracking)
    };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = CookieAnalyzer;
