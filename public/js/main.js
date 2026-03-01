/**
 * TeslaAI — Main Orchestration Layer
 * ────────────────────────────────────
 * Ties together PersonaCreator, CookieAnalyzer, ABTesting, and ContentEngine.
 * Runs the full personalisation pipeline on every page load:
 *
 *   1. Show loading screen
 *   2. Collect persona signals (device, cookies, traffic, history)
 *   3. Assign A/B variant (deterministic hash of session ID)
 *   4. Variant A → keep default Tesla content; hide loader
 *   5. Variant B → call /api/content with persona → inject AI content → hide loader
 *   6. Track impressions, scroll depth, CTA clicks
 *   7. Render debug panel if ?debug=1
 */

(function () {
  'use strict';

  // ── Module instances ───────────────────────────────────────────────────────
  let personaCreator, cookieAnalyzer, abTest, contentEngine;
  let persona = null;

  // ── Initialise on DOM ready ────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  async function init() {
    const debugMode = hasDebugFlag();

    // Instantiate core libraries
    cookieAnalyzer = new CookieAnalyzer({ debug: debugMode });
    personaCreator = new PersonaCreator({
      namespace:  'tesla_ai',
      debug:      debugMode,
      onProgress: (msg) => contentEngine?.updateLoadingText(msg)
    });
    abTest = new ABTesting({ apiBase: '', debug: debugMode });
    contentEngine  = new ContentEngine({
      apiBase:   '',
      debug:     debugMode,
      onError:   (e) => console.warn('[TeslaAI] Content fetch error:', e.message)
    });

    // Show loading immediately
    contentEngine.showLoading();
    contentEngine.updateLoadingText('Analysing your profile…');

    try {
      // ── Step 1: Build persona ──────────────────────────────────────────────
      persona = await personaCreator.build();

      // Merge cookie insights into persona scores (boosts)
      contentEngine.updateLoadingText('Reading advertising signals…');
      const cookieInsights = cookieAnalyzer.analyze();
      persona = mergeCookieInsights(persona, cookieInsights);

      // ── Step 2: Assign A/B variant ─────────────────────────────────────────
      contentEngine.updateLoadingText('Assigning personalisation variant…');
      const variant = abTest.assignVariant(persona.id, 50); // 50% split
      contentEngine.abVariant = variant;

      // ── Step 3: Fetch & inject AI content (Variant B only) ────────────────
      let content = null;
      if (variant === 'B') {
        contentEngine.updateLoadingText('Generating your personalised Tesla experience…');
        content = await contentEngine.fetch(persona, persona.id);
        contentEngine.inject(content, variant);
        highlightRecommendedModel(content?.heroModel || persona.recommendation.model);
      } else {
        // Control: just highlight the rule-based recommendation
        highlightRecommendedModel(persona.recommendation.model);
      }

      // ── Step 4: UI polish ──────────────────────────────────────────────────
      contentEngine.updateLoadingText('Almost ready…');
      await sleep(400);  // brief pause so "Almost ready" is readable
      await contentEngine.hideLoading();

      // Animate sections into view
      initSectionObserver();
      initNavScroll();
      initScrollTracking();

      // Track impression
      abTest.trackView(content?.heroModel || persona.recommendation.model);

      // ── Step 5: Debug panel ────────────────────────────────────────────────
      if (debugMode) {
        renderDebugPanel(persona, cookieInsights, variant, content);
        document.getElementById('debug-panel')?.classList.add('visible');
      }

    } catch (err) {
      console.error('[TeslaAI] Pipeline error:', err);
      // Always reveal the page even on error — degrade gracefully
      await contentEngine.hideLoading();
      initSectionObserver();
      initNavScroll();
    }
  }

  // ── Merge cookie score boosts into persona ─────────────────────────────────
  function mergeCookieInsights(p, cookieData) {
    const boosts = cookieData.insights?.scoreBoosts || {};
    return {
      ...p,
      wealthScore:  clamp(p.wealthScore  + (boosts.wealth  || 0)),
      familyScore:  clamp(p.familyScore  + (boosts.family  || 0)),
      perfScore:    clamp(p.perfScore    + (boosts.performance || 0)),
      ecoScore:     clamp(p.ecoScore     + (boosts.eco     || 0)),
      techScore:    clamp(p.techScore    + (boosts.tech    || 0)),
      intentScore:  clamp(p.intentScore  + (boosts.intent  || 0)),
      cookieSignals: {
        platforms:  cookieData.insights?.detectedPlatforms || [],
        segments:   cookieData.insights?.audienceSegments  || [],
        intentTier: cookieData.insights?.intentTier        || 'LOW',
        hasPaid:    cookieData.insights?.hasPaidTraffic    || false,
        retargeted: cookieData.insights?.inRetargetingPool || false
      }
    };
  }

  // ── Show "Recommended for You" badge on the top model ─────────────────────
  function highlightRecommendedModel(model) {
    if (!model) return;
    const slug  = model.toLowerCase().replace(/\s/g, '-');
    const badge = document.getElementById(`badge-${slug}`);
    if (badge) badge.style.display = 'inline-flex';
  }

  // ── Intersection observer → animate sections into view ────────────────────
  function initSectionObserver() {
    const sections = document.querySelectorAll('.model-section');
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08 });
    sections.forEach(s => io.observe(s));
  }

  // ── Nav dark on scroll ─────────────────────────────────────────────────────
  function initNavScroll() {
    const nav = document.getElementById('nav');
    if (!nav) return;
    const onScroll = () => {
      nav.classList.toggle('scrolled', window.scrollY > 40);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ── Scroll depth tracking (25 / 50 / 75 / 100) ────────────────────────────
  function initScrollTracking() {
    const milestones = new Set();
    window.addEventListener('scroll', () => {
      const pct = Math.round((window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100);
      [25, 50, 75, 100].forEach(m => {
        if (pct >= m && !milestones.has(m)) {
          milestones.add(m);
          abTest.trackScroll(m);
        }
      });
    }, { passive: true });

    // Engagement time (every 30s on page)
    let secs = 0;
    setInterval(() => {
      secs += 30;
      if (!document.hidden) abTest.trackEngagement(secs);
    }, 30_000);
  }

  // ── Debug panel renderer ───────────────────────────────────────────────────
  function renderDebugPanel(p, cookieData, variant, content) {
    const body = document.getElementById('debug-body');
    if (!body) return;

    const scoreColor = (n) => n >= 70 ? 'green' : n >= 40 ? 'orange' : '';

    const scoreRow = (label, val, color) => `
      <div class="debug-row">
        <span class="debug-key">${label}</span>
        <div class="score-bar-wrap" style="flex:1;margin-left:8px">
          <div class="score-bar-track">
            <div class="score-bar-fill ${color}" style="width:${val}%"></div>
          </div>
          <span class="score-num">${val}</span>
        </div>
      </div>`;

    const row = (k, v, cls = '') => `
      <div class="debug-row">
        <span class="debug-key">${k}</span>
        <span class="debug-val ${cls}">${v ?? '—'}</span>
      </div>`;

    body.innerHTML = `
      <div class="debug-section">
        <h5>A/B Variant</h5>
        ${row('Variant', `<span class="debug-variant-badge ${variant}">${variant}</span>`, '')}
        ${row('Segment', p.segment)}
        ${row('Intent', p.intentScore >= 70 ? '<span style="color:#4caf7d">HIGH</span>' : p.intentScore >= 40 ? '<span style="color:#ff9800">MEDIUM</span>' : 'LOW')}
      </div>

      <div class="debug-section">
        <h5>Persona Scores</h5>
        ${scoreRow('Wealth',      p.wealthScore,  scoreColor(p.wealthScore))}
        ${scoreRow('Family',      p.familyScore,  scoreColor(p.familyScore))}
        ${scoreRow('Performance', p.perfScore,    scoreColor(p.perfScore))}
        ${scoreRow('Eco',         p.ecoScore,     scoreColor(p.ecoScore))}
        ${scoreRow('Tech',        p.techScore,    scoreColor(p.techScore))}
        ${scoreRow('Intent',      p.intentScore,  scoreColor(p.intentScore))}
      </div>

      <div class="debug-section">
        <h5>Model Recommendation</h5>
        ${row('Model',  p.recommendation?.model)}
        ${row('Trim',   p.recommendation?.trim)}
        ${row('Reason', p.recommendation?.reason)}
      </div>

      <div class="debug-section">
        <h5>Traffic Source</h5>
        ${row('Type',    p.traffic?.referrerType)}
        ${row('Referrer',p.traffic?.referrerHost || 'Direct')}
        ${row('UTM Src', p.traffic?.utmSource || '—')}
        ${row('UTM Med', p.traffic?.utmMedium || '—')}
        ${row('Paid',    p.traffic?.isPaidTraffic ? '✓ Yes' : 'No')}
      </div>

      <div class="debug-section">
        <h5>Device</h5>
        ${row('Type',   p.device?.isMobile ? 'Mobile' : p.device?.isTablet ? 'Tablet' : 'Desktop')}
        ${row('OS',     p.device?.isIOS ? 'iOS' : p.device?.isMac ? 'macOS' : p.device?.isAndroid ? 'Android' : p.device?.isWin ? 'Windows' : 'Linux')}
        ${row('Memory', p.device?.memGB ? p.device.memGB + ' GB' : '?')}
        ${row('Cores',  p.device?.cores)}
        ${row('Premium',p.device?.premiumDevice ? '✓ Yes' : 'No')}
      </div>

      <div class="debug-section">
        <h5>Cookie Signals</h5>
        ${row('Platforms', (cookieData.insights?.detectedPlatforms || []).join(', ') || 'None detected')}
        ${row('Audiences', (cookieData.insights?.audienceSegments || []).join(', ') || '—')}
        ${row('Intent Tier', cookieData.insights?.intentTier || 'LOW')}
        ${row('Retargeted', cookieData.insights?.inRetargetingPool ? '✓ Yes' : 'No')}
      </div>

      <div class="debug-section">
        <h5>History</h5>
        ${row('Returning', p.history?.isReturning ? '✓ Yes' : 'New visitor')}
        ${row('Visits',    p.history?.visitCount)}
        ${row('Cart Abnd', p.history?.cartAbandoned ? '⚠ Yes' : 'No')}
        ${row('Configured',p.history?.configuredModel || '—')}
      </div>

      ${content ? `
      <div class="debug-section">
        <h5>AI-Generated Content</h5>
        ${row('Hero Model',    content.heroModel)}
        ${row('Hero Trim',     content.heroTrim)}
        ${row('Headline',      content.heroHeadline)}
        ${row('CTA-A',         content.ctaVariantA)}
        ${row('CTA-B',         content.ctaVariantB)}
        ${row('Urgency',       content.urgencyMessage || '—')}
        ${row('Price Emphasis',content.priceEmphasis)}
        <div class="debug-row" style="flex-direction:column;gap:4px">
          <span class="debug-key">Why this model?</span>
          <span style="color:rgba(255,255,255,0.7);font-size:0.7rem;line-height:1.4">${content.personalisationReason || '—'}</span>
        </div>
      </div>` : `
      <div class="debug-section">
        <h5>AI Content</h5>
        ${row('Variant', 'A — Control (no AI call)')}
      </div>`}

      <div style="padding:8px 0;text-align:center">
        <button onclick="TeslaAI.copyPersona()"
                style="font-size:0.7rem;color:rgba(255,255,255,0.5);background:rgba(255,255,255,0.06);
                       border:1px solid rgba(255,255,255,0.12);border-radius:4px;padding:6px 14px;cursor:pointer">
          Copy Persona JSON
        </button>
      </div>
    `;
  }

  // ── Utility ────────────────────────────────────────────────────────────────
  function hasDebugFlag() {
    return new URLSearchParams(location.search).has('debug') ||
           location.hash === '#debug' ||
           localStorage.getItem('tesla_ai_debug') === '1';
  }
  function clamp(n) { return Math.min(100, Math.max(0, Math.round(n))); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Public API (called from HTML onclick handlers) ─────────────────────────
  window.TeslaAI = {
    trackCTA(model, type) {
      if (abTest) {
        if (type === 'order') abTest.trackOrder(model, '');
        else if (type === 'demo') abTest.trackDemo(model);
        else abTest.trackClick(model, type);
      }
      // In real site: navigate to /order or /test-drive
      console.log(`[TeslaAI] CTA clicked: ${type} → ${model}`);
    },

    trackNavOrder() {
      if (abTest) abTest.trackClick('Nav', 'order');
    },

    showTestDrive() {
      if (abTest) abTest.track('test_drive_intent', { model: persona?.recommendation?.model });
      alert('Test Drive booking would open here.\nPersonalised for: ' + (persona?.recommendation?.model || 'Model Y'));
    },

    toggleMobileMenu() {
      const links = document.querySelector('.nav-links');
      if (links) links.classList.toggle('mobile-open');
    },

    showDebug() {
      if (persona) renderDebugPanel(persona, cookieAnalyzer?.analyze() || {}, abTest?.variant || 'A', contentEngine?.content);
      document.getElementById('debug-panel')?.classList.add('visible');
      return false;
    },

    hideDebug() {
      document.getElementById('debug-panel')?.classList.remove('visible');
    },

    copyPersona() {
      const json = JSON.stringify(persona, null, 2);
      navigator.clipboard?.writeText(json).then(() => alert('Persona JSON copied!')).catch(() => console.log(json));
    },

    getStats() {
      return abTest?.getStats();
    }
  };

})();
