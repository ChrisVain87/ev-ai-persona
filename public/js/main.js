/**
 * TeslaAI — Main Orchestration Layer
 * ────────────────────────────────────
 * Pipeline:
 *  1. Build persona from browser signals (no blocking modal)
 *  2. Show page immediately; show inline needs tiles for first visitors
 *  3. Assign A/B variant — Variant B calls /api/content for AI personalisation
 *  4. Apply journey-based UI (education, featured program, CTA text)
 *  5. Track impressions, scroll depth, CTA clicks, test drive bookings
 */

(function () {
  'use strict';

  const TRIM_DATA = {
    'model-y': {
      'standard':     { price: 40990, range: 260, accel: 5.5, drive: 'RWD', seats: 5 },
      'standard-lr':  { price: 44990, range: 330, accel: 4.8, drive: 'RWD', seats: 5 },
      'premium-lr':   { price: 47990, range: 330, accel: 4.5, drive: 'AWD', seats: 5 },
      'premium-awd':  { price: 51990, range: 330, accel: 4.2, drive: 'AWD', seats: 5 },
      'premium-perf': { price: 54990, range: 315, accel: 3.5, drive: 'AWD', seats: 5 }
    },
    'model-3': {
      'standard':     { price: 38990, range: 272, accel: 5.8, drive: 'RWD', seats: 5 },
      'standard-lr':  { price: 42990, range: 358, accel: 4.2, drive: 'RWD', seats: 5 },
      'premium-lr':   { price: 46990, range: 358, accel: 4.0, drive: 'AWD', seats: 5 },
      'premium-awd':  { price: 50990, range: 315, accel: 3.7, drive: 'AWD', seats: 5 },
      'premium-perf': { price: 54990, range: 315, accel: 3.1, drive: 'AWD', seats: 5 }
    }
  };

  const COMPARE_CONTENT = {
    family: {
      y: { stats: '330mi / 5–7 seats / 5★', desc: 'The most space, 7-seat option, and top safety ratings. Perfect for school runs and family road trips.', price: '$44,990' },
      3: { stats: '358mi / 4.2s / 5★',      desc: 'Longer range, sportier feel, still a 5-star safety car. Great for couples and small families.', price: '$42,990' }
    },
    performance: {
      y: { stats: '315mi / 3.5s / AWD', desc: 'Family SUV that outruns sports cars. 0–60 in 3.5s with sport suspension and Alcantara interior.', price: '$54,990' },
      3: { stats: '315mi / 3.1s / AWD', desc: 'The quickest sedan in its class. 0–60 in 3.1 seconds with track mode and sport brakes.', price: '$54,990' }
    },
    value: {
      y: { stats: '$37,490 after credit / 330mi', desc: 'The world\'s best-selling EV. After the $7,500 tax credit and fuel savings, it often beats the cost of a gas car.', price: '$44,990' },
      3: { stats: '$35,490 after credit / 358mi', desc: 'Lowest entry price of any Tesla. The most miles per dollar in the lineup — saves roughly $2,000/year vs petrol.', price: '$42,990' }
    },
    eco: {
      y: { stats: '330mi / 0 emissions / 4.8s', desc: 'Charge at home for ~$30/month. Eliminates 4–5 tonnes of CO₂ per year vs an average petrol SUV.', price: '$44,990' },
      3: { stats: '358mi / most efficient Tesla', desc: 'Tesla\'s most efficient model — lower energy consumption means lower charging costs and the greatest green impact.', price: '$42,990' }
    }
  };

  let personaCreator, cookieAnalyzer, abTest, contentEngine;
  let persona   = null;
  let aiContent = null;
  let abVariant = 'A';
  let _needsSelected = new Set();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  async function init() {
    const debugMode = hasDebugFlag();

    cookieAnalyzer = new CookieAnalyzer({ debug: debugMode });
    personaCreator = new PersonaCreator({
      namespace:  'tesla_ai',
      debug:      debugMode,
      onProgress: (msg) => contentEngine?.updateLoadingText(msg)
    });
    abTest        = new ABTesting({ apiBase: '', debug: debugMode });
    contentEngine = new ContentEngine({
      apiBase:  '',
      debug:    debugMode,
      onError:  (e) => console.warn('[TeslaAI] Content fetch error:', e.message)
    });

    contentEngine.showLoading();
    contentEngine.updateLoadingText('Personalising your experience…');

    // Check for stored choices (return visitor)
    const KEY = 'tesla_ai_user_choices';
    let userChoices = [];
    try {
      const stored = localStorage.getItem(KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) userChoices = parsed;
      }
    } catch { /* ignore */ }

    const isFirstVisit = userChoices.length === 0;

    try {
      // ── Step 1: Build persona ──────────────────────────────────────────────
      contentEngine.updateLoadingText('Analysing your profile…');
      persona = await personaCreator.build(userChoices);

      contentEngine.updateLoadingText('Reading advertising signals…');
      const cookieInsights = cookieAnalyzer.analyze();
      persona = mergeCookieInsights(persona, cookieInsights);

      // ── Step 2: Assign A/B variant ─────────────────────────────────────────
      abVariant = abTest.assignVariant(persona.id, 50);
      contentEngine.abVariant = abVariant;

      // ── Step 3: Fetch & inject AI content (Variant B) ──────────────────────
      if (abVariant === 'B') {
        contentEngine.updateLoadingText('Generating your personalised experience…');
        aiContent = await contentEngine.fetch(persona, persona.id);
        contentEngine.inject(aiContent, abVariant);
      }

      // ── Step 4: Reveal page ────────────────────────────────────────────────
      contentEngine.updateLoadingText('Almost ready…');
      await sleep(200);
      await contentEngine.hideLoading();

      // ── Step 5: Apply journey + show education for first visits ─────────────
      applyJourney(persona, aiContent);
      if (isFirstVisit) {
        document.getElementById('section-needs').style.display = 'block';
        if (!aiContent?.showEducationSection) {
          document.getElementById('section-education').style.display = 'block';
        }
      }

      // ── Step 6: Highlight recommended model + init interactive features ─────
      highlightRecommendedModel(aiContent?.heroModel || persona.recommendation.model);
      initNeedsTiles(KEY);
      initSectionObserver();
      initNavScroll();
      initScrollTracking();
      initTrimSelectors();
      initFinanceCalc();
      initSavingsCalc();
      initCompareTabs();

      abTest.trackView(aiContent?.heroModel || persona.recommendation.model);

      // ── Step 7: Show persona result card + AI assistant button ─────────────
      await sleep(800);
      showPersonaResult(persona, aiContent);
      showAIAssistantButton();

      if (debugMode) {
        renderDebugPanel(persona, cookieInsights, abVariant, aiContent);
        document.getElementById('debug-panel')?.classList.add('visible');
      }

    } catch (err) {
      console.error('[TeslaAI] Pipeline error:', err);
      await contentEngine.hideLoading();
      initSectionObserver();
      initNavScroll();
      initTrimSelectors();
      initFinanceCalc();
      initSavingsCalc();
      initCompareTabs();
    }
  }

  // ── Apply customer journey UI adjustments ─────────────────────────────────
  function applyJourney(p, content) {
    const { history = {}, scores = {} } = p;
    const heroPrimary = document.getElementById('hero-primary-cta');

    // Journey 1: First Visit — gentle, educational
    if (p.isFirstVisit) {
      if (heroPrimary && abVariant !== 'B') heroPrimary.textContent = 'See Which Tesla Fits You';
      return;
    }
    // Journey 3: High Intent (cart abandoned or 3+ visits + high intent)
    if (history.cartAbandoned || (scores.intent >= 70 && history.visitCount >= 3)) {
      if (heroPrimary && abVariant !== 'B') heroPrimary.textContent = 'Continue Your Order';
      document.getElementById('nav-order-cta').textContent = 'Complete Order';
      if (!content?.featuredSalesProgram) document.getElementById('card-financing').classList.add('featured-card');
      return;
    }
    // Journey 4: Competitor Shopper
    if (p.competitors?.isCompetitorShopper) {
      if (heroPrimary && abVariant !== 'B') heroPrimary.textContent = 'See Why Tesla Wins';
      if (!content?.featuredSalesProgram) document.getElementById('card-taxcredit').classList.add('featured-card');
      return;
    }
    // Journey 2: Return Researcher
    if (history.isReturning) {
      if (heroPrimary && abVariant !== 'B') heroPrimary.textContent = 'Continue Exploring';
      if (!content?.featuredSalesProgram) document.getElementById('card-tradein').classList.add('featured-card');
    }
  }

  // ── Inline needs tiles (replace blocking modal) ───────────────────────────
  function initNeedsTiles(storageKey) {
    const tiles     = document.querySelectorAll('.need-tile');
    const countEl   = document.getElementById('needs-count');
    const submitBtn = document.getElementById('needs-submit');
    if (!tiles.length || !submitBtn) return;

    const updateUI = () => {
      const n = _needsSelected.size;
      if (countEl) countEl.textContent = `${n} of 3 selected`;
      submitBtn.disabled = n < 3;
      tiles.forEach(t => {
        const isSelected = _needsSelected.has(t.dataset.choice);
        t.classList.toggle('selected', isSelected);
        t.setAttribute('aria-pressed', String(isSelected));
        t.classList.toggle('dimmed', n >= 3 && !isSelected);
      });
    };

    tiles.forEach(tile => {
      tile.addEventListener('click', () => {
        const val = tile.dataset.choice;
        if (_needsSelected.has(val)) {
          _needsSelected.delete(val);
        } else if (_needsSelected.size < 3) {
          _needsSelected.add(val);
        }
        updateUI();
      });
    });

    updateUI();
  }

  // ── Compare tabs ──────────────────────────────────────────────────────────
  function initCompareTabs() {
    // Default to family tab content
    updateCompareTab('family');
  }

  // ── Section observer — animate on scroll ──────────────────────────────────
  function initSectionObserver() {
    const sections = document.querySelectorAll('.model-detail-section, .compare-section, .fsd-section, .sales-section');
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.05 });
    sections.forEach(s => io.observe(s));
  }

  // ── Nav background on scroll ──────────────────────────────────────────────
  function initNavScroll() {
    const nav = document.getElementById('nav');
    if (!nav) return;
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ── Scroll depth tracking ─────────────────────────────────────────────────
  function initScrollTracking() {
    const milestones = new Set();
    window.addEventListener('scroll', () => {
      const total = document.body.scrollHeight - window.innerHeight;
      if (total <= 0) return;
      const pct = Math.round((window.scrollY / total) * 100);
      [25, 50, 75, 100].forEach(m => {
        if (pct >= m && !milestones.has(m)) {
          milestones.add(m);
          abTest.trackScroll(m);
        }
      });
    }, { passive: true });

    let secs = 0;
    setInterval(() => {
      secs += 30;
      if (!document.hidden) abTest.trackEngagement(secs);
    }, 30_000);
  }

  // ── Trim selector interactivity ───────────────────────────────────────────
  function initTrimSelectors() {
    document.querySelectorAll('.trim-selector').forEach(selector => {
      const modelKey = selector.dataset.model; // e.g. 'model-y'
      if (!TRIM_DATA[modelKey]) return;

      selector.querySelectorAll('.trim-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          selector.querySelectorAll('.trim-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          updateTrimDisplay(modelKey, btn.dataset.trim);
          if (abTest) abTest.trackClick(`${modelKey}-${btn.dataset.trim}`, 'trim_select');
        });
      });

      // Init display for active trim
      const active = selector.querySelector('.trim-btn.active');
      if (active) updateTrimDisplay(modelKey, active.dataset.trim);
    });
  }

  function updateTrimDisplay(modelKey, trimKey) {
    const data = TRIM_DATA[modelKey]?.[trimKey];
    if (!data) return;

    const TAX_CREDIT = 7500;
    const DOWN = 5000;
    const MONTHS = 60;
    const monthly = Math.round((data.price - TAX_CREDIT - DOWN) / MONTHS);

    const s = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    s(`price-${modelKey}`,        '$' + data.price.toLocaleString());
    s(`monthly-${modelKey}`,      '$' + monthly.toLocaleString());
    s(`after-credit-${modelKey}`, (data.price - TAX_CREDIT).toLocaleString());
    s(`range-${modelKey}`,        data.range);
    s(`accel-${modelKey}`,        data.accel);
    s(`drive-${modelKey}`,        data.drive);
    s(`seats-${modelKey}`,        data.seats);
  }

  // ── Financing calculator ──────────────────────────────────────────────────
  function initFinanceCalc() {
    const update = () => {
      const modelSelect = document.getElementById('finance-model');
      const dpSlider    = document.getElementById('dp-slider');
      const termSelect  = document.getElementById('finance-term');
      if (!modelSelect || !dpSlider || !termSelect) return;

      const price  = parseFloat(modelSelect.value) || 44990;
      const dp     = parseFloat(dpSlider.value) || 0;
      const term   = parseInt(termSelect.value, 10) || 60;
      const amount = Math.max(0, price - 7500 - dp); // after credit + down payment
      const rate   = term === 24 ? 0 : 0.0699;

      let monthly;
      if (rate === 0) {
        monthly = Math.round(amount / term);
      } else {
        const r = rate / 12;
        monthly = Math.round(amount * r / (1 - Math.pow(1 + r, -term)));
      }

      const s = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      s('monthly-calc',  '$' + (monthly > 0 ? monthly.toLocaleString() : '0'));
      s('interest-calc', term === 24 ? '0% interest — no extra cost' : `~${(rate * 100).toFixed(2)}% APR est. after tax credit & down payment`);
      s('dp-val',        Number(dp).toLocaleString());
    };

    ['finance-model', 'dp-slider', 'finance-term'].forEach(id => {
      document.getElementById(id)?.addEventListener('input',  update);
      document.getElementById(id)?.addEventListener('change', update);
    });

    update();
  }

  // ── Savings calculator ────────────────────────────────────────────────────
  function initSavingsCalc() {
    const input  = document.getElementById('fuel-spend');
    const result = document.getElementById('savings-result');
    if (!input || !result) return;

    const calc = () => {
      const monthly = parseFloat(input.value) || 0;
      const annual  = monthly * 12;
      const elecAnn = monthly * 0.3 * 12; // ~70% cheaper to charge
      const savings = Math.max(0, Math.round(annual - elecAnn));
      result.innerHTML = `You could save <strong>$${savings.toLocaleString()}/year</strong> switching to a Tesla.`;
    };

    input.addEventListener('input', calc);
    calc();
  }

  // ── Highlight recommended model ───────────────────────────────────────────
  function highlightRecommendedModel(model) {
    if (!model) return;
    const slug  = model.toLowerCase().replace(/\s/g, '-');
    const badge = document.getElementById(`badge-${slug}`);
    if (badge) badge.style.display = 'block';

    // Highlight compare card
    const SLUG_MAP = { 'model-y': 'compare-y-badge', 'model-3': 'compare-3-badge' };
    const compareBadge = document.getElementById(SLUG_MAP[slug]);
    if (compareBadge) compareBadge.style.display = 'block';
  }

  // ── Persona result card ────────────────────────────────────────────────────
  function showPersonaResult(p, content) {
    const container = document.getElementById('persona-result');
    const body      = document.getElementById('persona-result-body');
    if (!container || !body) return;

    const scores = [
      { label: 'Wealth',      val: p.wealthScore },
      { label: 'Family',      val: p.familyScore },
      { label: 'Performance', val: p.perfScore   },
      { label: 'Eco',         val: p.ecoScore    },
      { label: 'Tech',        val: p.techScore   },
      { label: 'Intent',      val: p.intentScore }
    ];

    const barFillClass = (n) => n >= 70 ? 'high' : n >= 45 ? 'med' : '';
    const recModel = content?.heroModel || p.recommendation?.model || 'Model Y';
    const compBrands = p.competitors?.detectedBrands || [];
    const compHtml = compBrands.length > 0
      ? `<div style="padding:4px 16px 8px;display:flex;flex-wrap:wrap;gap:4px">
           ${compBrands.map(b => `<span style="font-size:0.65rem;background:rgba(227,25,55,0.08);color:var(--red);border:1px solid rgba(227,25,55,0.2);border-radius:10px;padding:2px 7px">vs ${b}</span>`).join('')}
         </div>`
      : '';

    body.innerHTML = `
      <div class="persona-result-header">
        <span class="persona-result-title">⚡ Your AI Profile</span>
        <button class="persona-result-close" onclick="TeslaAI.closePersonaResult()" aria-label="Close">✕</button>
      </div>
      <div class="persona-result-segment">${p.segment}</div>
      <div class="persona-result-model">Matched: ${recModel}</div>
      ${compHtml}
      <div class="persona-result-bars">
        ${scores.map(s => `
          <div class="pr-bar-row">
            <span class="pr-bar-label">${s.label}</span>
            <div class="pr-bar-track">
              <div class="pr-bar-fill ${barFillClass(s.val)}" style="width:${s.val}%"></div>
            </div>
            <span class="pr-bar-num">${s.val}</span>
          </div>`).join('')}
      </div>
      <div class="persona-result-footer">
        <span class="persona-result-sources">Device · Traffic · Behaviour · Choices</span>
        <button class="persona-result-link" onclick="TeslaAI.toggleAssistant()">See how →</button>
      </div>`;

    container.style.display = 'block';

    // Auto-dismiss after 12 seconds
    setTimeout(() => {
      if (container.style.display !== 'none') {
        container.style.opacity = '0';
        container.style.transition = 'opacity 0.5s ease';
        setTimeout(() => { container.style.display = 'none'; }, 500);
      }
    }, 12000);
  }

  // ── AI assistant button ────────────────────────────────────────────────────
  function showAIAssistantButton() {
    const btn = document.getElementById('ai-assistant-btn');
    if (btn) btn.style.display = 'flex';
  }

  // ── AI assistant panel ─────────────────────────────────────────────────────
  function populateAIAssistantPanel(p, content) {
    const body = document.getElementById('ai-panel-body');
    if (!body) return;

    const scores = [
      { label: 'Wealth',      val: p.wealthScore },
      { label: 'Family',      val: p.familyScore },
      { label: 'Performance', val: p.perfScore   },
      { label: 'Eco',         val: p.ecoScore    },
      { label: 'Tech',        val: p.techScore   },
      { label: 'Intent',      val: p.intentScore }
    ];

    const fillClass = (n) => n >= 70 ? 'high' : n >= 45 ? 'med' : '';
    const row = (dot, text, boost) => `
      <div class="ai-signal-row">
        <div class="ai-signal-dot ${dot}"></div>
        <span class="ai-signal-text">${text}</span>
        ${boost ? `<span class="ai-signal-boost">${boost}</span>` : ''}
      </div>`;

    const d = p.device || {};
    const deviceOS   = d.isIOS ? 'iOS' : d.isMac ? 'macOS' : d.isAndroid ? 'Android' : d.isWin ? 'Windows' : 'Linux';
    const deviceType = d.isMobile ? 'Mobile' : d.isTablet ? 'Tablet' : 'Desktop';
    const deviceSignals = [
      [d.premiumDevice ? 'green' : 'blue', `${deviceType} · ${deviceOS}${d.premiumDevice ? ' (premium device)' : ''}`, d.premiumDevice ? '+20 Wealth' : null],
      d.cores ? ['blue', `${d.cores} CPU cores · ${d.memGB || '?'} GB RAM`, d.cores >= 8 ? '+15 Tech' : null] : null,
      [d.darkMode ? 'green' : 'blue', d.darkMode ? 'Dark mode enabled' : 'Light mode', d.darkMode ? '+3 Eco' : null],
    ].filter(Boolean);

    const t = p.traffic || {};
    const trafficSignals = [
      [t.referrerHost ? 'green' : 'blue', t.referrerHost ? `Arrived from ${t.referrerHost}` : 'Direct visit', t.referrerType === 'linkedin' ? '+15 Wealth' : t.referrerType === 'finance_news' ? '+12 Wealth' : null],
      t.isPaidTraffic ? ['orange', 'Paid ad click detected', '+20 Intent'] : null,
      t.gclid ? ['orange', 'Google Ads click ID', '+10 Intent'] : null,
      t.fbclid ? ['orange', 'Facebook Ads click ID', '+25 Intent'] : null,
    ].filter(Boolean);

    const h = p.history || {};
    const historySignals = [
      [h.isReturning ? 'green' : 'blue', h.isReturning ? `Returning visitor — ${h.visitCount} visits` : 'First visit', h.isReturning ? '+15 Intent' : null],
      h.cartAbandoned ? ['orange', `Cart abandoned — ${h.cartModel || 'a model'}`, '+40 Intent'] : null,
      h.configuredModel ? ['green', `Previously configured ${h.configuredModel}`, '+20 Intent'] : null,
      h.testDriveBooked ? ['green', 'Test drive already booked', '+25 Intent'] : null,
    ].filter(Boolean);

    const cs = p.cookieSignals || {};
    const cookieSignals = (cs.platforms || []).length > 0
      ? (cs.platforms || []).map(pl => ['blue', `${pl} pixel detected`, pl.includes('Facebook') ? '+25 Intent' : pl.includes('LinkedIn') ? '+15 Wealth' : pl.includes('Criteo') ? '+20 Intent' : null])
      : [['blue', 'No advertising pixels detected', null]];

    const comp = p.competitors || {};
    const compBrands = comp.detectedBrands || [];
    const choices = p.userChoices || [];
    const choiceLabels = { performance:'⚡ Performance', family:'👨‍👩‍👧 Family & Safety', eco:'🌿 Eco', luxury:'💎 Luxury', tech:'🤖 Tech & Autopilot', value:'💰 Best Value' };
    const choiceBoosts = { performance:'+25 Performance', family:'+25 Family', eco:'+25 Eco', luxury:'+20 Wealth', tech:'+25 Tech', value:'+10 Intent' };

    const aiSection = content ? `
      <div class="ai-section">
        <div class="ai-section-title">AI-Generated Content</div>
        <div class="ai-recommendation-box">
          <div class="ai-rec-model">${content.heroModel} ${content.heroTrim}</div>
          <div class="ai-rec-reason">${content.personalisationReason || '—'}</div>
        </div>
        ${row('green', `Headline: "${content.heroHeadline}"`, null)}
        ${row('blue',  `CTA: "${content.ctaVariantB || content.ctaVariantA}"`, null)}
        ${(content.personalizedBenefits || []).map(b => row('green', b, null)).join('')}
        ${content.urgencyMessage ? row('orange', `Urgency: "${content.urgencyMessage}"`, null) : ''}
        ${content.promoteFSD ? row('blue', 'FSD promoted for this persona', '+Conversion') : ''}
        ${content.featuredSalesProgram ? row('green', `Featured program: ${content.featuredSalesProgram}`, null) : ''}
      </div>` : `
      <div class="ai-section">
        <div class="ai-section-title">AI Content</div>
        ${row('blue', 'Variant A — control group, default content shown', null)}
      </div>`;

    body.innerHTML = `
      <div class="ai-section">
        <div class="ai-section-title">Your Persona</div>
        <div style="margin-bottom:12px">
          <div style="font-size:1rem;font-weight:500;color:#fff;margin-bottom:2px">${p.segment}</div>
          <div style="font-size:0.75rem;color:rgba(255,255,255,0.4)">A/B Variant: ${abVariant} · ID: ${p.id?.slice(0,8) || '—'}…</div>
        </div>
        ${scores.map(s => `
          <div class="ai-score-row">
            <span class="ai-score-label">${s.label}</span>
            <div class="ai-score-track"><div class="ai-score-fill ${fillClass(s.val)}" style="width:${s.val}%"></div></div>
            <span class="ai-score-num">${s.val}</span>
          </div>`).join('')}
      </div>

      ${choices.length > 0 ? `
      <div class="ai-section">
        <div class="ai-section-title">Your Selected Priorities</div>
        ${choices.map(c => row('choice', choiceLabels[c] || c, choiceBoosts[c] || null)).join('')}
      </div>` : ''}

      ${compBrands.length > 0 ? `
      <div class="ai-section">
        <div class="ai-section-title">Competitor Research Detected</div>
        ${compBrands.map(b => row('red', `${b} visited — showing Tesla advantages`, '+Intent')).join('')}
      </div>` : ''}

      <div class="ai-section">
        <div class="ai-section-title">Device Signals</div>
        ${deviceSignals.map(([dot, text, boost]) => row(dot, text, boost)).join('')}
      </div>

      <div class="ai-section">
        <div class="ai-section-title">Traffic Source</div>
        ${trafficSignals.map(([dot, text, boost]) => row(dot, text, boost)).join('')}
      </div>

      <div class="ai-section">
        <div class="ai-section-title">Ad Platform Signals</div>
        ${cookieSignals.map(([dot, text, boost]) => row(dot, text, boost)).join('')}
        ${cs.retargeted ? row('orange', 'In retargeting pool — previously visited Tesla', '+15 Intent') : ''}
      </div>

      <div class="ai-section">
        <div class="ai-section-title">Visit History</div>
        ${historySignals.length > 0
          ? historySignals.map(([dot, text, boost]) => row(dot, text, boost)).join('')
          : row('blue', 'First visit — no history', null)}
      </div>

      <div class="ai-section">
        <div class="ai-section-title">Model Recommendation</div>
        <div class="ai-recommendation-box">
          <div class="ai-rec-model">${p.recommendation?.model} ${p.recommendation?.trim}</div>
          <div class="ai-rec-reason">Reason: ${p.recommendation?.reason?.replace(/_/g,' ') || '—'}</div>
        </div>
      </div>

      ${aiSection}

      <div class="ai-section">
        <div class="ai-section-title">Data Sources</div>
        ${row('blue', 'Browser/device signals (no PII)', null)}
        ${row('blue', 'Session & time signals', null)}
        ${row('blue', 'Traffic source (referrer, UTM, click IDs)', null)}
        ${row('blue', 'First-party cookies (ad platforms)', null)}
        ${row('blue', 'localStorage history (this browser only)', null)}
        ${choices.length > 0 ? row('green', 'Your stated priorities (selected above)', null) : ''}
        <div style="font-size:0.68rem;color:rgba(255,255,255,0.25);margin-top:12px;line-height:1.5">
          No personal data, email, or IP address is stored. Signals are collected client-side and processed in real-time.
        </div>
      </div>`;
  }

  // ── Merge cookie insights into persona ─────────────────────────────────────
  function mergeCookieInsights(p, cookieData) {
    const boosts = cookieData.insights?.scoreBoosts || {};
    return {
      ...p,
      wealthScore:  clamp(p.wealthScore  + (boosts.wealth      || 0)),
      familyScore:  clamp(p.familyScore  + (boosts.family      || 0)),
      perfScore:    clamp(p.perfScore    + (boosts.performance || 0)),
      ecoScore:     clamp(p.ecoScore     + (boosts.eco         || 0)),
      techScore:    clamp(p.techScore    + (boosts.tech        || 0)),
      intentScore:  clamp(p.intentScore  + (boosts.intent      || 0)),
      cookieSignals: {
        platforms:  cookieData.insights?.detectedPlatforms || [],
        segments:   cookieData.insights?.audienceSegments  || [],
        intentTier: cookieData.insights?.intentTier        || 'LOW',
        hasPaid:    cookieData.insights?.hasPaidTraffic    || false,
        retargeted: cookieData.insights?.inRetargetingPool || false
      }
    };
  }

  // ── Debug panel ────────────────────────────────────────────────────────────
  function renderDebugPanel(p, cookieData, variant, content) {
    const body = document.getElementById('debug-body');
    if (!body) return;

    const scoreColor = (n) => n >= 70 ? 'green' : n >= 40 ? 'orange' : '';
    const scoreRow = (label, val) => `
      <div class="debug-row">
        <span class="debug-key">${label}</span>
        <div class="score-bar-wrap">
          <div class="score-bar-track"><div class="score-bar-fill ${scoreColor(val)}" style="width:${val}%"></div></div>
          <span class="score-num">${val}</span>
        </div>
      </div>`;
    const row = (k, v) => `
      <div class="debug-row">
        <span class="debug-key">${k}</span>
        <span class="debug-val">${v ?? '—'}</span>
      </div>`;

    body.innerHTML = `
      <div class="debug-section">
        <h5>A/B Variant</h5>
        ${row('Variant', `<span class="debug-variant-badge ${variant}">${variant}</span>`)}
        ${row('Segment', p.segment)}
        ${row('First Visit', p.isFirstVisit ? '✓ Yes' : 'No')}
      </div>
      <div class="debug-section">
        <h5>Persona Scores</h5>
        ${scoreRow('Wealth',      p.wealthScore)}
        ${scoreRow('Family',      p.familyScore)}
        ${scoreRow('Performance', p.perfScore)}
        ${scoreRow('Eco',         p.ecoScore)}
        ${scoreRow('Tech',        p.techScore)}
        ${scoreRow('Intent',      p.intentScore)}
      </div>
      <div class="debug-section">
        <h5>Recommendation</h5>
        ${row('Model',  p.recommendation?.model)}
        ${row('Trim',   p.recommendation?.trim)}
        ${row('Reason', p.recommendation?.reason)}
      </div>
      <div class="debug-section">
        <h5>Traffic</h5>
        ${row('Type',     p.traffic?.referrerType)}
        ${row('Referrer', p.traffic?.referrerHost || 'Direct')}
        ${row('Paid',     p.traffic?.isPaidTraffic ? '✓' : 'No')}
      </div>
      <div class="debug-section">
        <h5>Device</h5>
        ${row('Type',    p.device?.isMobile ? 'Mobile' : p.device?.isTablet ? 'Tablet' : 'Desktop')}
        ${row('OS',      p.device?.isIOS ? 'iOS' : p.device?.isMac ? 'macOS' : p.device?.isAndroid ? 'Android' : p.device?.isWin ? 'Windows' : 'Linux')}
        ${row('Premium', p.device?.premiumDevice ? '✓' : 'No')}
      </div>
      <div class="debug-section">
        <h5>History</h5>
        ${row('Returning',  p.history?.isReturning ? '✓' : 'New')}
        ${row('Visits',     p.history?.visitCount)}
        ${row('Cart Abnd',  p.history?.cartAbandoned ? '⚠' : 'No')}
      </div>
      ${content ? `
      <div class="debug-section">
        <h5>AI Content</h5>
        ${row('Hero', `${content.heroModel} ${content.heroTrim}`)}
        ${row('Headline', content.heroHeadline)}
        ${row('Education', content.showEducationSection ? '✓' : 'No')}
        ${row('FSD Push',  content.promoteFSD ? '✓' : 'No')}
        ${row('Program',   content.featuredSalesProgram || '—')}
        ${row('Urgency',   content.urgencyMessage || '—')}
      </div>` : ''}
      <div style="padding:8px 0;text-align:center">
        <button onclick="TeslaAI.copyPersona()"
                style="font-size:0.7rem;color:rgba(255,255,255,0.5);background:rgba(255,255,255,0.06);
                       border:1px solid rgba(255,255,255,0.12);border-radius:4px;padding:6px 14px;cursor:pointer">
          Copy Persona JSON
        </button>
      </div>`;
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  function hasDebugFlag() {
    return new URLSearchParams(location.search).has('debug') ||
           location.hash === '#debug' ||
           localStorage.getItem('tesla_ai_debug') === '1';
  }
  function clamp(n) { return Math.min(100, Math.max(0, Math.round(n))); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function updateCompareTab(tab) {
    const c = COMPARE_CONTENT[tab];
    if (!c) return;
    const s = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    s('compare-y-desc',  c.y.desc);
    s('compare-y-price', `From ${c.y.price} (${(parseInt(c.y.price.replace(/\D/g,'')) - 7500).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0})} after credit)`);
    s('compare-3-desc',  c['3'].desc);
    s('compare-3-price', `From ${c['3'].price} (${(parseInt(c['3'].price.replace(/\D/g,'')) - 7500).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0})} after credit)`);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.TeslaAI = {
    // CTA tracking
    trackCTA(model, type) {
      if (abTest) {
        if (type === 'order') abTest.trackOrder(model, '');
        else if (type === 'demo') abTest.trackDemo(model);
        else abTest.trackClick(model, type);
      }
    },
    trackNavOrder() { if (abTest) abTest.trackClick('Nav', 'order'); },

    // Test Drive Modal
    showTestDrive(model) {
      const modal = document.getElementById('testdrive-modal');
      if (!modal) return;

      const rec = model || aiContent?.heroModel || persona?.recommendation?.model || 'Model Y';
      const modelSelect = document.getElementById('td-model-select');
      if (modelSelect) modelSelect.value = rec;

      // Set min date to tomorrow
      const dateInput = document.getElementById('td-date');
      if (dateInput) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        dateInput.min = tomorrow.toISOString().split('T')[0];
      }

      modal.style.display = 'flex';
      document.getElementById('testdrive-form').style.display = 'flex';
      document.getElementById('testdrive-success').style.display = 'none';
      document.getElementById('td-error').style.display = 'none';

      if (abTest) abTest.track('test_drive_intent', { model: rec });
    },

    closeTestDrive() {
      const modal = document.getElementById('testdrive-modal');
      if (modal) modal.style.display = 'none';
    },

    async submitTestDrive(event) {
      event.preventDefault();
      const form    = event.target;
      const submit  = document.getElementById('td-submit');
      const errorEl = document.getElementById('td-error');

      // Collect form data
      const data = {};
      new FormData(form).forEach((val, key) => {
        if (data[key]) {
          // handle multi-values (checkboxes)
          data[key] = Array.isArray(data[key]) ? [...data[key], val] : [data[key], val];
        } else {
          data[key] = val;
        }
      });
      // Collect interest checkboxes as array
      data.interests = [...form.querySelectorAll('[name="interests"]:checked')].map(el => el.value);
      data.sessionId = abTest?.sessionId || persona?.id;

      submit.textContent = 'Confirming…';
      submit.disabled    = true;
      errorEl.style.display = 'none';

      try {
        const res  = await fetch('/api/test-drive', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(data)
        });
        const json = await res.json();

        if (json.success) {
          form.style.display = 'none';
          document.getElementById('testdrive-success').style.display = 'block';
          if (abTest) abTest.trackDemo(data.model || 'Unknown');
          try { localStorage.setItem('tesla_ai_test_drive_booked', '1'); } catch {}
        } else {
          throw new Error(json.error || 'Submission failed');
        }
      } catch (err) {
        errorEl.textContent = 'Something went wrong. Please try again or call your local Tesla store.';
        errorEl.style.display = 'block';
        submit.textContent = 'Confirm Test Drive';
        submit.disabled    = false;
      }
    },

    // Inline needs tiles submit
    async submitNeeds() {
      if (_needsSelected.size < 3) return;
      const choices = [..._needsSelected];
      const KEY = 'tesla_ai_user_choices';

      try { localStorage.setItem(KEY, JSON.stringify(choices)); } catch {}

      // Hide the needs section
      const needsSection = document.getElementById('section-needs');
      if (needsSection) {
        needsSection.style.opacity = '0';
        needsSection.style.transition = 'opacity 0.3s';
        setTimeout(() => { needsSection.style.display = 'none'; }, 300);
      }

      // Rebuild persona with new choices + re-fetch AI content
      if (persona && personaCreator) {
        try {
          persona = await personaCreator.build(choices);
          const cookieInsights = cookieAnalyzer.analyze();
          persona = mergeCookieInsights(persona, cookieInsights);

          if (abVariant === 'B') {
            aiContent = await contentEngine.fetch(persona, persona.id);
            contentEngine.inject(aiContent, abVariant);
          }

          highlightRecommendedModel(aiContent?.heroModel || persona.recommendation.model);

          // Scroll to recommended model
          const recSlug = (aiContent?.heroModel || persona.recommendation.model || 'Model Y').toLowerCase().replace(/\s/g,'-');
          const recSec  = document.getElementById(`section-${recSlug}`);
          if (recSec) setTimeout(() => recSec.scrollIntoView({ behavior: 'smooth', block: 'start' }), 350);

        } catch(err) {
          console.warn('[TeslaAI] Needs rebuild error:', err.message);
        }
      }
    },

    // Compare tabs
    switchCompareTab(tab) {
      document.querySelectorAll('.ctab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
        t.setAttribute('aria-selected', String(t.dataset.tab === tab));
      });
      updateCompareTab(tab);
      if (abTest) abTest.trackClick('compare', tab);
    },

    // Trade-In calculator
    estimateTradeIn() {
      const year  = document.getElementById('tradein-year')?.value;
      const make  = document.getElementById('tradein-make')?.value;
      const model = document.getElementById('tradein-model-input')?.value?.trim();
      const result = document.getElementById('tradein-result');
      if (!result) return;

      if (!model) {
        result.style.display = 'block';
        result.innerHTML = '<span style="color:var(--text-muted)">Please enter your vehicle model above.</span>';
        return;
      }

      const currentYear = 2025;
      const age  = currentYear - parseInt(year, 10);
      const BASE = { Toyota: 22000, Honda: 20000, Ford: 19000, Chevrolet: 18000, BMW: 30000, Mercedes: 33000, Audi: 28000, Volkswagen: 22000, Hyundai: 19000, Kia: 18500, Other: 17000 };
      const base = BASE[make] || 17000;
      const value = Math.max(2500, Math.round(base * Math.pow(0.83, age)));
      const uplift = 3000;
      const total  = value + uplift;

      result.style.display = 'block';
      result.innerHTML = `
        <div>Estimated value: <strong>$${value.toLocaleString()}</strong></div>
        <div>Tesla trade-in uplift: <strong style="color:var(--green)">+$${uplift.toLocaleString()}</strong></div>
        <div style="font-weight:700;color:var(--text);margin-top:6px">Total: $${total.toLocaleString()}</div>
        <small>Final value confirmed at your nearest Tesla store.</small>`;

      if (abTest) abTest.trackClick('trade-in', 'estimate');
    },

    // Tax credit eligibility
    checkEligibility() {
      const income = parseFloat(document.getElementById('income-input')?.value);
      const el     = document.getElementById('eligibility-result');
      if (!el) return;
      el.style.display = 'block';

      if (!income || isNaN(income)) {
        el.innerHTML = '<span style="color:var(--text-muted)">Please enter your estimated annual income.</span>';
        return;
      }
      if (income <= 150000) {
        el.innerHTML = '<strong style="color:#22c55e">✓ You likely qualify</strong> for the full $7,500 credit on Model Y and Model 3.';
      } else if (income <= 300000) {
        el.innerHTML = '<strong style="color:#f59e0b">⚠ Possible eligibility</strong> — depends on filing status. Consult a tax advisor. Joint filers up to $300K qualify.';
      } else {
        el.innerHTML = '<strong style="color:#ef4444">✗ Above income limit</strong> for the personal tax credit. However, leased vehicles have no income cap — explore leasing.';
      }
      if (abTest) abTest.trackClick('tax-credit', 'eligibility_check');
    },

    // Mobile menu
    toggleMobileMenu() {
      const menu = document.getElementById('nav-mobile-menu');
      if (menu) menu.classList.toggle('open');
    },

    // AI Assistant panel
    toggleAssistant() {
      const panel   = document.getElementById('ai-assistant-panel');
      const overlay = document.getElementById('ai-panel-overlay');
      if (!panel) return;
      if (panel.classList.contains('open')) {
        this.closeAssistant();
      } else {
        overlay.style.display = 'block';
        panel.classList.add('open');
        panel.setAttribute('aria-hidden', 'false');
        if (persona) populateAIAssistantPanel(persona, aiContent);
      }
    },
    closeAssistant() {
      const panel   = document.getElementById('ai-assistant-panel');
      const overlay = document.getElementById('ai-panel-overlay');
      if (panel) { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); }
      if (overlay) setTimeout(() => { overlay.style.display = 'none'; }, 350);
    },

    // Persona result card
    closePersonaResult() {
      const el = document.getElementById('persona-result');
      if (el) el.style.display = 'none';
    },

    // Debug
    showDebug() {
      if (persona) renderDebugPanel(persona, cookieAnalyzer?.analyze() || {}, abVariant, aiContent);
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
    resetChoices() {
      localStorage.removeItem('tesla_ai_user_choices');
      location.reload();
    },
    getStats() { return abTest?.getStats(); }
  };

})();
