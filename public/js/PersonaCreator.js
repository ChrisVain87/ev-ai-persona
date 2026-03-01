/**
 * PersonaCreator — Universal AI Persona Engine
 * ─────────────────────────────────────────────
 * Collects every available browser, device, session, and behavioural signal,
 * then scores the visitor across 5 psychological/demographic dimensions.
 * The resulting persona drives AI content generation and A/B test variant selection.
 *
 * Reusable: drop this on ANY website — just call new PersonaCreator().build()
 */
class PersonaCreator {
  constructor(options = {}) {
    this.namespace  = options.namespace  || 'ai_persona';   // localStorage prefix
    this.debug      = options.debug      || false;
    this.onProgress = options.onProgress || (() => {});
  }

  // ── Public entry point ───────────────────────────────────────────────────
  async build(userChoices = []) {
    this.onProgress('Collecting browser signals…');
    const device    = this._collectDevice();

    this.onProgress('Reading session data…');
    const session   = this._collectSession();

    this.onProgress('Analysing traffic source…');
    const traffic   = this._collectTraffic();

    this.onProgress('Reading stored preferences…');
    const history   = this._collectHistory();

    this.onProgress('Checking connectivity…');
    const network   = await this._collectNetwork();

    this.onProgress('Detecting competitor research…');
    const competitors = this._collectCompetitors();

    this.onProgress('Scoring persona dimensions…');
    const scores    = this._scorePersona({ device, session, traffic, history, network, competitors, userChoices });

    this.onProgress('Selecting model recommendation…');
    const recommendation = this._recommend(scores, history);

    const persona = {
      id:             this._getOrCreateId(),
      timestamp:      Date.now(),
      device,
      session,
      traffic,
      history,
      network,
      competitors,
      userChoices,
      scores,
      recommendation,
      // Flattened scores at top level for prompt readability
      wealthScore:    scores.wealth,
      familyScore:    scores.family,
      perfScore:      scores.performance,
      ecoScore:       scores.eco,
      techScore:      scores.tech,
      intentScore:    scores.intent,
      segment:        this._segment(scores)
    };

    this._persistHistory(persona);
    if (this.debug) console.log('[PersonaCreator] Built persona:', persona);
    return persona;
  }

  // ── Device signals ───────────────────────────────────────────────────────
  _collectDevice() {
    const ua  = navigator.userAgent;
    const s   = screen;
    const nav = navigator;

    const isIOS      = /iPhone|iPad|iPod/i.test(ua);
    const isAndroid  = /Android/i.test(ua);
    const isMac      = /Macintosh|MacIntel/i.test(ua);
    const isWin      = /Win/i.test(ua);
    const isLinux    = /Linux/i.test(ua) && !isAndroid;
    const isMobile   = isIOS || isAndroid || ('ontouchstart' in window && s.width < 768);
    const isTablet   = isMobile && s.width >= 768;

    // Estimate device tier from hardware concurrency & memory
    const cores  = nav.hardwareConcurrency || 2;
    const memGB  = nav.deviceMemory        || 1;  // Safari doesn't expose this → 1
    const dpr    = window.devicePixelRatio || 1;

    // Premium device signals:
    // iPhone → higher avg income, Mac → creative/tech, high memory → flagship phone
    const premiumDevice = (isIOS && !isAndroid) || isMac || (memGB >= 8) || (cores >= 8 && dpr >= 3);

    return {
      ua, isIOS, isAndroid, isMac, isWin, isLinux,
      isMobile, isTablet, isDesktop: !isMobile,
      cores, memGB, dpr,
      premiumDevice,
      screenW:  s.width,
      screenH:  s.height,
      colorDepth: s.colorDepth,
      language: nav.language || 'en',
      languages: nav.languages ? Array.from(nav.languages) : [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      darkMode: window.matchMedia('(prefers-color-scheme: dark)').matches,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      doNotTrack: nav.doNotTrack === '1' || nav.doNotTrack === 'yes',
      cookiesEnabled: nav.cookieEnabled,
      // Plugins indicate desktop power user
      pluginCount: nav.plugins ? nav.plugins.length : 0
    };
  }

  // ── Session/time signals ─────────────────────────────────────────────────
  _collectSession() {
    const now = new Date();
    const h   = now.getHours();
    return {
      hour:           h,
      dayOfWeek:      now.getDay(),         // 0=Sun
      isWeekend:      [0, 6].includes(now.getDay()),
      isBusinessHours: h >= 9 && h <= 17,
      isPrimeTime:    h >= 19 && h <= 22,   // evening browsing
      isNightOwl:     h >= 22 || h <= 5,
      localDate:      now.toISOString().split('T')[0],
      viewportW:      window.innerWidth,
      viewportH:      window.innerHeight,
      hasTouch:       'ontouchstart' in window,
      sessionStart:   performance.now()
    };
  }

  // ── Traffic / acquisition signals ────────────────────────────────────────
  _collectTraffic() {
    const ref  = document.referrer;
    const url  = new URL(window.location.href);
    const p    = url.searchParams;

    let referrerHost = '';
    let referrerType = 'direct';
    try {
      referrerHost = ref ? new URL(ref).hostname.replace('www.', '') : '';
    } catch { /* invalid URL */ }

    if (referrerHost) {
      if (/google|bing|yahoo|duckduckgo|baidu/.test(referrerHost))   referrerType = 'organic_search';
      else if (/facebook|instagram|twitter|x\.com|tiktok|snapchat|pinterest/.test(referrerHost)) referrerType = 'social';
      else if (/linkedin/.test(referrerHost))  referrerType = 'linkedin';
      else if (/youtube/.test(referrerHost))   referrerType = 'youtube';
      else if (/reddit/.test(referrerHost))    referrerType = 'reddit';
      else if (/news|bloomberg|wsj|ft\.com|cnbc|forbes/.test(referrerHost)) referrerType = 'finance_news';
      else                                     referrerType = 'referral';
    }

    // UTM parameters
    const utmSource   = p.get('utm_source')   || '';
    const utmMedium   = p.get('utm_medium')   || '';
    const utmCampaign = p.get('utm_campaign') || '';
    const utmContent  = p.get('utm_content')  || '';
    const utmTerm     = p.get('utm_term')     || '';
    const gclid       = p.get('gclid')        || '';  // Google Ads click
    const fbclid      = p.get('fbclid')       || '';  // Facebook click
    const msclkid     = p.get('msclkid')      || '';  // Microsoft Ads

    const isPaidTraffic = !!(gclid || fbclid || msclkid || utmMedium === 'cpc' || utmMedium === 'paid');

    // Extract intent keywords from UTM terms / campaign names
    const campaignText = [utmCampaign, utmContent, utmTerm].join(' ').toLowerCase();
    const intentKeywords = {
      family:       /family|kids|school|safe|suv|space|cargo|seats/.test(campaignText),
      performance:  /fast|plaid|sport|track|0-60|performance|speed/.test(campaignText),
      luxury:       /premium|luxury|executive|business|first.class/.test(campaignText),
      eco:          /green|eco|electric|sustainable|carbon|save/.test(campaignText),
      cyber:        /truck|cyber|towing|off.road|ranch|contractor/.test(campaignText)
    };

    return {
      referrer: ref,
      referrerHost,
      referrerType,
      utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
      gclid, fbclid, msclkid,
      isPaidTraffic,
      intentKeywords,
      currentPath: window.location.pathname
    };
  }

  // ── Competitor website research signals ──────────────────────────────────
  _collectCompetitors() {
    const ns  = this.namespace;
    const ref = document.referrer;
    const get     = (k)      => { try { return localStorage.getItem(`${ns}_${k}`); } catch { return null; } };
    const set     = (k, v)   => { try { localStorage.setItem(`${ns}_${k}`, v); }   catch {} };
    const getJSON = (k, def) => { try { return JSON.parse(get(k)) || def; }         catch { return def; } };

    const COMPETITORS = {
      'bmw.com':    { brand: 'BMW',   segment: 'luxury_performance', scoreBoosts: { wealth: 10, performance: 15, intent: 8 } },
      'bmwusa.com': { brand: 'BMW',   segment: 'luxury_performance', scoreBoosts: { wealth: 10, performance: 15, intent: 8 } },
      'kia.com':    { brand: 'KIA',   segment: 'value_family',       scoreBoosts: { family: 12, eco: 8,  intent: 6 } },
      'skoda.com':  { brand: 'Skoda', segment: 'practical_family',   scoreBoosts: { family: 12, eco: 5,  intent: 6 } },
      'byd.com':    { brand: 'BYD',   segment: 'ev_tech',            scoreBoosts: { eco: 15, tech: 10, intent: 10 } },
      'byd.eu':     { brand: 'BYD',   segment: 'ev_tech',            scoreBoosts: { eco: 15, tech: 10, intent: 10 } },
      'zeekr.com':  { brand: 'Zeekr', segment: 'premium_ev_tech',    scoreBoosts: { tech: 15, performance: 10, intent: 10 } }
    };

    // Check if arriving directly from a competitor site
    let refHost = '';
    let currentVisitFrom = null;
    try { refHost = ref ? new URL(ref).hostname.replace('www.', '') : ''; } catch { /* ignore */ }

    for (const [domain, info] of Object.entries(COMPETITORS)) {
      if (refHost && refHost.includes(domain.replace('www.', ''))) {
        currentVisitFrom = info.brand;
        const visits = getJSON('competitor_visits', []);
        const existing = visits.find(v => v.brand === info.brand);
        if (existing) {
          existing.ts = Date.now();
        } else {
          visits.push({ brand: info.brand, segment: info.segment, ts: Date.now() });
        }
        set('competitor_visits', JSON.stringify(visits.slice(-10)));
        break;
      }
    }

    // Load stored competitor visit history
    const storedVisits = getJSON('competitor_visits', []);
    const scoreBoosts  = { wealth: 0, family: 0, performance: 0, eco: 0, tech: 0, intent: 0 };
    const detectedBrands = [];

    for (const visit of storedVisits) {
      const conf = Object.values(COMPETITORS).find(c => c.brand === visit.brand);
      if (conf) {
        detectedBrands.push(visit.brand);
        for (const [key, val] of Object.entries(conf.scoreBoosts)) {
          scoreBoosts[key] = Math.min(25, (scoreBoosts[key] || 0) + val); // cap per dimension
        }
      }
    }

    return {
      currentVisitFrom,
      detectedBrands:      [...new Set(detectedBrands)],
      visitHistory:        storedVisits,
      scoreBoosts,
      isCompetitorShopper: detectedBrands.length > 0
    };
  }

  // ── Persistent history signals (localStorage) ────────────────────────────
  _collectHistory() {
    const ns = this.namespace;
    const get = (k) => { try { return localStorage.getItem(`${ns}_${k}`); } catch { return null; } };
    const getJSON = (k, def) => { try { return JSON.parse(get(k)) || def; } catch { return def; } };

    const visitCount   = parseInt(get('visit_count') || '0', 10);
    const lastVisitRaw = get('last_visit');
    const lastVisit    = lastVisitRaw ? new Date(parseInt(lastVisitRaw, 10)) : null;
    const daysSinceLast = lastVisit ? Math.floor((Date.now() - lastVisit) / 86_400_000) : null;

    return {
      isReturning:       visitCount > 0,
      visitCount,
      lastVisit:         lastVisit?.toISOString() || null,
      daysSinceLast,
      viewedModels:      getJSON('viewed_models', []),
      configuredModel:   get('configured_model'),
      cartAbandoned:     !!get('cart_model'),
      cartModel:         get('cart_model'),
      preferredModel:    get('preferred_model'),
      savedRange:        get('saved_range_km') ? parseInt(get('saved_range_km'), 10) : null,
      emailCaptured:     !!get('email_captured'),
      testDriveBooked:   !!get('test_drive_booked')
    };
  }

  // ── Network signals (async) ──────────────────────────────────────────────
  async _collectNetwork() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    let battery = null;
    try {
      if (navigator.getBattery) {
        const b = await navigator.getBattery();
        battery = { level: b.level, charging: b.charging };
      }
    } catch { /* not available */ }

    return {
      effectiveType: conn?.effectiveType || 'unknown',
      downlink:      conn?.downlink      || null,
      rtt:           conn?.rtt           || null,
      saveData:      conn?.saveData      || false,
      battery
    };
  }

  // ── Scoring engine ────────────────────────────────────────────────────────
  _scorePersona({ device, session, traffic, history, network, competitors = {}, userChoices = [] }) {
    let wealth = 50, family = 30, performance = 30, eco = 30, tech = 40, intent = 20;

    // ── Wealth signals ──────────────────────────────────────────────
    if (device.premiumDevice)              wealth += 20;
    if (device.isMac)                      wealth += 10;
    if (device.memGB >= 16)               wealth += 10;
    if (device.cores >= 10)               wealth += 8;
    if (traffic.referrerType === 'linkedin') wealth += 15;
    if (traffic.referrerType === 'finance_news') wealth += 12;
    if (traffic.isPaidTraffic && traffic.utmSource === 'linkedin') wealth += 10;
    if (traffic.intentKeywords.luxury)     wealth += 15;
    if (device.isDesktop && !device.isWin) wealth += 5;    // non-Windows desktop → higher income

    // ── Family signals ──────────────────────────────────────────────
    if (device.isTablet)                   family  += 15;  // tablets correlate with family use
    if (traffic.intentKeywords.family)     family  += 25;
    if (history.viewedModels.includes('Model Y') || history.viewedModels.includes('Model X')) family += 15;
    if (traffic.referrerHost.includes('parenting') || traffic.referrerHost.includes('mom')) family += 20;
    if (session.isWeekend && !session.isNightOwl) family += 8;  // weekend afternoon = family time
    if (device.screenW >= 1280 && !device.isMobile) family += 5; // large screens = multiple users

    // ── Performance signals ─────────────────────────────────────────
    if (traffic.intentKeywords.performance) performance += 30;
    if (/sport|racing|supercar|bmw|amg|porsche/.test(traffic.referrerHost)) performance += 20;
    if (history.viewedModels.includes('Model S') || history.viewedModels.includes('Model 3')) performance += 10;
    if (device.isDesktop && session.isNightOwl) performance += 10; // night-time desktop = enthusiast
    if (device.memGB >= 16 && device.cores >= 8) performance += 8;

    // ── Eco signals ─────────────────────────────────────────────────
    if (traffic.intentKeywords.eco)        eco += 30;
    if (/greenpeace|350|climatechange|sustainability/.test(traffic.referrerHost)) eco += 25;
    if (/treehugger|electrek|insideevs/.test(traffic.referrerHost)) eco += 20;
    if (device.darkMode)                   eco += 3;       // weak signal
    if (traffic.utmCampaign.includes('ev') || traffic.utmCampaign.includes('electric')) eco += 15;
    if (traffic.referrerType === 'organic_search' && traffic.utmTerm.includes('electric')) eco += 15;

    // ── Tech signals ────────────────────────────────────────────────
    if (/github|stackoverflow|hackernews|ycombinator/.test(traffic.referrerHost)) tech += 25;
    if (traffic.referrerType === 'reddit')  tech += 15;
    if (device.pluginCount === 0 && !device.isIOS) tech += 5; // Chrome without plugins = web dev
    if (device.languages.length > 2)       tech += 8;     // polyglot → international tech worker
    if (!device.doNotTrack)                tech += 5;     // tech users often set DNT... or not (ambiguous)
    if (device.isMac && device.cores >= 8) tech += 15;
    if (device.memGB >= 32)               tech += 15;

    // ── Purchase intent ─────────────────────────────────────────────
    if (history.cartAbandoned)             intent += 40;  // strongest signal
    if (history.isReturning)               intent += 15;
    if (history.visitCount >= 3)           intent += 15;
    if (history.configuredModel)           intent += 20;
    if (traffic.isPaidTraffic)             intent += 20;  // clicked an ad = high intent
    if (traffic.gclid)                     intent += 10;  // Google Ads click
    if (history.daysSinceLast !== null && history.daysSinceLast <= 3) intent += 10;
    if (session.isWeekend && session.isBusinessHours) intent += 8; // weekend browsing = leisure shopping
    if (history.testDriveBooked)           intent += 25;  // already booked = most ready

    // ── Cyber/Utility signals (feed into model recommendation) ──────
    let cyber = 20;
    if (traffic.intentKeywords.cyber)      cyber += 30;
    if (/truck|pickup|f150|ram1500|4x4|offroad/.test(traffic.referrerHost)) cyber += 20;
    if (device.timezone && /mountain|pacific|central/.test(device.timezone.toLowerCase())) cyber += 8;

    // ── User-selected preference boosts ─────────────────────────────────────
    if (userChoices.includes('performance')) performance += 25;
    if (userChoices.includes('family'))      family      += 25;
    if (userChoices.includes('eco'))         eco         += 25;
    if (userChoices.includes('luxury'))      wealth      += 20;
    if (userChoices.includes('tech'))        tech        += 25;
    if (userChoices.includes('value'))       intent      += 10;

    // ── Competitor shopping signals ──────────────────────────────────────────
    if (competitors.isCompetitorShopper) {
      intent += 12;  // comparing = serious shopper
      const cb = competitors.scoreBoosts || {};
      wealth      += (cb.wealth      || 0);
      family      += (cb.family      || 0);
      performance += (cb.performance || 0);
      eco         += (cb.eco         || 0);
      tech        += (cb.tech        || 0);
      intent      += (cb.intent      || 0);
    }

    // Clamp all scores 0-100
    const clamp = (n) => Math.min(100, Math.max(0, Math.round(n)));
    return {
      wealth:      clamp(wealth),
      family:      clamp(family),
      performance: clamp(performance),
      eco:         clamp(eco),
      tech:        clamp(tech),
      intent:      clamp(intent),
      cyber:       clamp(cyber)
    };
  }

  // ── Model recommendation ─────────────────────────────────────────────────
  _recommend(scores, history) {
    const { wealth, family, performance, eco, tech, intent, cyber } = scores;

    if (history.cartModel)           return { model: history.cartModel, trim: 'Long Range', reason: 'cart_abandoned' };
    if (history.configuredModel)     return { model: history.configuredModel, trim: 'Long Range', reason: 'configured' };

    // Decision matrix
    if (wealth >= 75 && performance >= 70)   return { model: 'Model S', trim: 'Plaid',        reason: 'wealth_performance' };
    if (wealth >= 70 && family >= 65)        return { model: 'Model X', trim: 'Long Range',   reason: 'wealth_family' };
    if (family >= 65 && wealth < 70)         return { model: 'Model Y', trim: 'Long Range',   reason: 'family_value' };
    if (performance >= 70 && wealth < 70)    return { model: 'Model 3', trim: 'Performance',  reason: 'performance_value' };
    if (cyber >= 55)                         return { model: 'Cybertruck', trim: 'AWD',        reason: 'utility_outdoor' };
    if (eco >= 65 && wealth < 60)            return { model: 'Model 3', trim: 'Long Range',   reason: 'eco_conscious' };
    if (tech >= 65 && wealth < 70)           return { model: 'Model 3', trim: 'Long Range',   reason: 'tech_early_adopter' };
    if (wealth >= 60)                        return { model: 'Model Y', trim: 'Long Range',   reason: 'mid_wealth_practical' };

    return { model: 'Model Y', trim: 'Standard Range', reason: 'default_bestseller' };
  }

  // ── Segment label ─────────────────────────────────────────────────────────
  _segment(scores) {
    const { wealth, family, performance, eco, tech } = scores;
    const top = [
      { label: 'Executive',       score: wealth      },
      { label: 'Family Driver',   score: family      },
      { label: 'Thrill Seeker',   score: performance },
      { label: 'Eco Warrior',     score: eco         },
      { label: 'Tech Enthusiast', score: tech        }
    ].sort((a, b) => b.score - a.score);
    return top[0].label;
  }

  // ── Session ID ────────────────────────────────────────────────────────────
  _getOrCreateId() {
    const key = `${this.namespace}_session_id`;
    let id;
    try {
      id = sessionStorage.getItem(key);
      if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36); sessionStorage.setItem(key, id); }
    } catch { id = Date.now().toString(36); }
    return id;
  }

  // ── Persist history for future visits ────────────────────────────────────
  _persistHistory(persona) {
    const ns  = this.namespace;
    const set = (k, v) => { try { localStorage.setItem(`${ns}_${k}`, v); } catch { /* quota */ } };
    const get = (k)    => { try { return localStorage.getItem(`${ns}_${k}`); } catch { return null; } };

    const count = parseInt(get('visit_count') || '0', 10) + 1;
    set('visit_count', count);
    set('last_visit', Date.now().toString());
    set('preferred_model', persona.recommendation.model);
  }
}

// Export for Node.js and browsers
if (typeof module !== 'undefined' && module.exports) module.exports = PersonaCreator;
