/**
 * TeslaAI — Main Orchestration Layer
 * ────────────────────────────────────
 * Pipeline:
 *  1. Show choices modal (if first visit) — user selects 3 priorities
 *  2. Collect persona signals + competitor research + choices
 *  3. Assign A/B variant
 *  4. Variant B → call /api/content → inject AI content
 *  5. Show persona result card + AI assistant button
 *  6. Track impressions, scroll depth, CTA clicks
 */

(function () {
  'use strict';

  let personaCreator, cookieAnalyzer, abTest, contentEngine;
  let persona   = null;
  let aiContent = null;
  let abVariant = 'A';

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

    // Brief loading screen before choices modal
    contentEngine.showLoading();
    contentEngine.updateLoadingText('Preparing your experience…');
    await sleep(600);

    try {
      // ── Step 1: Get or show choices modal ─────────────────────────────────
      const userChoices = await getOrShowChoices();

      // ── Step 2: Build persona (with choices + competitor detection) ────────
      contentEngine.updateLoadingText('Analysing your profile…');
      persona = await personaCreator.build(userChoices);

      contentEngine.updateLoadingText('Reading advertising signals…');
      const cookieInsights = cookieAnalyzer.analyze();
      persona = mergeCookieInsights(persona, cookieInsights);

      // ── Step 3: Assign A/B variant ─────────────────────────────────────────
      contentEngine.updateLoadingText('Assigning personalisation variant…');
      abVariant = abTest.assignVariant(persona.id, 50);
      contentEngine.abVariant = abVariant;

      // ── Step 4: Fetch & inject AI content (Variant B only) ─────────────────
      if (abVariant === 'B') {
        contentEngine.updateLoadingText('Generating your personalised Tesla experience…');
        aiContent = await contentEngine.fetch(persona, persona.id);
        contentEngine.inject(aiContent, abVariant);
        highlightRecommendedModel(aiContent?.heroModel || persona.recommendation.model);
      } else {
        highlightRecommendedModel(persona.recommendation.model);
      }

      // ── Step 5: Reveal page ────────────────────────────────────────────────
      contentEngine.updateLoadingText('Almost ready…');
      await sleep(300);
      await contentEngine.hideLoading();

      initSectionObserver();
      initNavScroll();
      initScrollTracking();
      abTest.trackView(aiContent?.heroModel || persona.recommendation.model);

      // ── Step 6: Show persona result card + AI assistant button ─────────────
      await sleep(800);
      showPersonaResult(persona, aiContent);
      showAIAssistantButton();

      // ── Step 7: Debug panel (optional) ────────────────────────────────────
      if (debugMode) {
        renderDebugPanel(persona, cookieInsights, abVariant, aiContent);
        document.getElementById('debug-panel')?.classList.add('visible');
      }

    } catch (err) {
      console.error('[TeslaAI] Pipeline error:', err);
      await contentEngine.hideLoading();
      initSectionObserver();
      initNavScroll();
    }
  }

  // ── Choices modal ──────────────────────────────────────────────────────────
  function getOrShowChoices() {
    const KEY = 'tesla_ai_user_choices';
    // Return stored choices if already set
    try {
      const stored = localStorage.getItem(KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length === 3) return Promise.resolve(parsed);
      }
    } catch { /* ignore */ }

    // Show modal and wait for user selection
    return new Promise((resolve) => {
      const modal    = document.getElementById('choices-modal');
      const countEl  = document.getElementById('choices-count');
      const continueBtn = document.getElementById('choices-continue');
      if (!modal) return resolve([]);

      // Show modal
      modal.style.display = 'flex';
      requestAnimationFrame(() => modal.classList.add('visible'));

      const selected = new Set();

      const updateUI = () => {
        const n = selected.size;
        countEl.textContent = `${n} of 3 selected`;
        continueBtn.disabled = n < 3;
        // Dim unselected cards when 3 chosen
        document.querySelectorAll('.choice-card').forEach(card => {
          const isSelected = selected.has(card.dataset.choice);
          card.classList.toggle('selected', isSelected);
          card.classList.toggle('disabled-card', n >= 3 && !isSelected);
        });
      };

      document.querySelectorAll('.choice-card').forEach(card => {
        card.addEventListener('click', () => {
          const val = card.dataset.choice;
          if (selected.has(val)) {
            selected.delete(val);
          } else if (selected.size < 3) {
            selected.add(val);
          }
          updateUI();
        });
      });

      continueBtn.addEventListener('click', () => {
        if (selected.size < 3) return;
        const choices = [...selected];
        try { localStorage.setItem(KEY, JSON.stringify(choices)); } catch { /* quota */ }
        modal.classList.remove('visible');
        setTimeout(() => { modal.style.display = 'none'; }, 400);
        resolve(choices);
      });
    });
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

    // Build competitor badges
    const compBrands = p.competitors?.detectedBrands || [];
    const compHtml   = compBrands.length > 0
      ? `<div style="padding:6px 16px 0;display:flex;flex-wrap:wrap;gap:4px">
           ${compBrands.map(b => `<span style="font-size:0.65rem;background:rgba(232,33,39,0.12);color:#f06b70;border:1px solid rgba(232,33,39,0.25);border-radius:10px;padding:2px 7px">vs ${b}</span>`).join('')}
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

    // Device signals
    const d = p.device || {};
    const deviceOS     = d.isIOS ? 'iOS' : d.isMac ? 'macOS' : d.isAndroid ? 'Android' : d.isWin ? 'Windows' : 'Linux';
    const deviceType   = d.isMobile ? 'Mobile' : d.isTablet ? 'Tablet' : 'Desktop';
    const deviceSignals = [
      [d.premiumDevice ? 'green' : 'blue', `${deviceType} · ${deviceOS}${d.premiumDevice ? ' (premium device detected)' : ''}`, d.premiumDevice ? '+20 Wealth' : null],
      d.cores ? ['blue', `${d.cores} CPU cores · ${d.memGB || '?'} GB RAM`, d.cores >= 8 ? '+15 Tech' : null] : null,
      [d.darkMode ? 'green' : 'blue', d.darkMode ? 'Dark mode enabled' : 'Light mode', d.darkMode ? '+3 Eco' : null],
      d.languages?.length > 2 ? ['blue', `${d.languages.length} languages detected (polyglot signal)`, '+8 Tech'] : null
    ].filter(Boolean);

    // Traffic signals
    const t = p.traffic || {};
    const trafficSignals = [
      [t.referrerHost ? 'green' : 'blue', t.referrerHost ? `Arrived from ${t.referrerHost}` : 'Direct visit (no referrer)', t.referrerType === 'linkedin' ? '+15 Wealth' : t.referrerType === 'finance_news' ? '+12 Wealth' : null],
      t.isPaidTraffic ? ['orange', 'Paid traffic detected (clicked an ad)', '+20 Intent'] : null,
      t.gclid ? ['orange', 'Google Ads click ID detected', '+10 Intent'] : null,
      t.fbclid ? ['orange', 'Facebook Ads click ID detected', '+25 Intent'] : null,
      t.utmSource ? ['blue', `UTM: ${t.utmSource}${t.utmMedium ? ' / ' + t.utmMedium : ''}${t.utmCampaign ? ' / ' + t.utmCampaign : ''}`, null] : null
    ].filter(Boolean);

    // History signals
    const h = p.history || {};
    const historySignals = [
      [h.isReturning ? 'green' : 'blue', h.isReturning ? `Returning visitor — ${h.visitCount} visits` : 'New visitor', h.isReturning ? '+15 Intent' : null],
      h.cartAbandoned ? ['orange', `Cart abandoned — previously added ${h.cartModel || 'a model'}`, '+40 Intent'] : null,
      h.configuredModel ? ['green', `Previously configured ${h.configuredModel}`, '+20 Intent'] : null,
      h.testDriveBooked ? ['green', 'Test drive already booked!', '+25 Intent'] : null,
      h.viewedModels?.length > 0 ? ['blue', `Viewed models: ${h.viewedModels.join(', ')}`, null] : null
    ].filter(Boolean);

    // Cookie signals
    const cs = p.cookieSignals || {};
    const cookiePlatforms = cs.platforms || [];
    const cookieSignals = cookiePlatforms.length > 0
      ? cookiePlatforms.map(pl => ['blue', `${pl} pixel detected`, pl.includes('Facebook') || pl.includes('Meta') ? '+25 Intent' : pl.includes('LinkedIn') ? '+15 Wealth' : pl.includes('Criteo') ? '+20 Intent' : null])
      : [['blue', 'No advertising pixels detected', null]];

    // Competitor signals
    const comp = p.competitors || {};
    const compBrands = comp.detectedBrands || [];

    // User choices
    const choices = p.userChoices || [];
    const choiceLabels = {
      performance: '⚡ Performance & Speed',
      family:      '👨‍👩‍👧 Family & Safety',
      eco:         '🌿 Eco & Sustainability',
      luxury:      '💎 Luxury & Status',
      tech:        '🤖 Tech & Autopilot',
      value:       '💰 Best Value'
    };
    const choiceBoosts = {
      performance: '+25 Performance',
      family:      '+25 Family',
      eco:         '+25 Eco',
      luxury:      '+20 Wealth',
      tech:        '+25 Tech',
      value:       '+10 Intent'
    };

    // AI content section
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
      </div>` : `
      <div class="ai-section">
        <div class="ai-section-title">AI Content</div>
        ${row('blue', 'Variant A — showing default Tesla content (control group)', null)}
      </div>`;

    body.innerHTML = `
      <!-- Persona Summary -->
      <div class="ai-section">
        <div class="ai-section-title">Your Persona</div>
        <div style="margin-bottom:12px">
          <div style="font-size:1rem;font-weight:500;color:#fff;margin-bottom:2px">${p.segment}</div>
          <div style="font-size:0.75rem;color:rgba(255,255,255,0.4)">A/B Variant: ${abVariant} · Session ID: ${p.id?.slice(0,8) || '—'}…</div>
        </div>
        ${scores.map(s => `
          <div class="ai-score-row">
            <span class="ai-score-label">${s.label}</span>
            <div class="ai-score-track">
              <div class="ai-score-fill ${fillClass(s.val)}" style="width:${s.val}%"></div>
            </div>
            <span class="ai-score-num">${s.val}</span>
          </div>`).join('')}
      </div>

      <!-- User Choices -->
      ${choices.length > 0 ? `
      <div class="ai-section">
        <div class="ai-section-title">Your Selected Priorities</div>
        ${choices.map(c => row('choice', choiceLabels[c] || c, choiceBoosts[c] || null)).join('')}
        <div style="font-size:0.7rem;color:rgba(255,255,255,0.3);margin-top:8px">
          These selections have the highest weight in content generation
        </div>
      </div>` : ''}

      <!-- Competitor Research -->
      ${compBrands.length > 0 ? `
      <div class="ai-section">
        <div class="ai-section-title">Competitor Research Detected</div>
        ${compBrands.map(b => row('red', `${b} website visited — showing Tesla advantages over ${b}`, '+Intent')).join('')}
        <div style="font-size:0.7rem;color:rgba(255,255,255,0.3);margin-top:8px">
          Content includes direct comparison advantages vs. these brands
        </div>
      </div>` : ''}

      <!-- Device Signals -->
      <div class="ai-section">
        <div class="ai-section-title">Device Signals (${deviceSignals.length} detected)</div>
        ${deviceSignals.map(([dot, text, boost]) => row(dot, text, boost)).join('')}
      </div>

      <!-- Traffic Source -->
      <div class="ai-section">
        <div class="ai-section-title">Traffic Source</div>
        ${trafficSignals.map(([dot, text, boost]) => row(dot, text, boost)).join('')}
      </div>

      <!-- Cookie & Ad Signals -->
      <div class="ai-section">
        <div class="ai-section-title">Ad Platform Signals</div>
        ${cookieSignals.map(([dot, text, boost]) => row(dot, text, boost)).join('')}
        ${cs.retargeted ? row('orange', 'In retargeting pool — previously visited Tesla', '+15 Intent') : ''}
      </div>

      <!-- Visit History -->
      <div class="ai-section">
        <div class="ai-section-title">Visit History</div>
        ${historySignals.length > 0
          ? historySignals.map(([dot, text, boost]) => row(dot, text, boost)).join('')
          : row('blue', 'First visit — no history available', null)}
      </div>

      <!-- AI Recommendation -->
      <div class="ai-section">
        <div class="ai-section-title">Model Recommendation</div>
        <div class="ai-recommendation-box">
          <div class="ai-rec-model">${p.recommendation?.model} ${p.recommendation?.trim}</div>
          <div class="ai-rec-reason">Reason: ${p.recommendation?.reason?.replace(/_/g,' ') || '—'}</div>
        </div>
      </div>

      ${aiSection}

      <!-- Data Sources Footer -->
      <div class="ai-section">
        <div class="ai-section-title">Data Sources Used</div>
        ${row('blue', 'Browser / device fingerprint (no personal data stored)', null)}
        ${row('blue', 'Session & time signals (hour, day, viewport)', null)}
        ${row('blue', 'Traffic acquisition (referrer, UTM, click IDs)', null)}
        ${row('blue', 'First-party cookies (ad platform pixels on this site)', null)}
        ${row('blue', 'localStorage visit history (this browser only)', null)}
        ${row('green', 'Your stated preferences (chosen above)', null)}
        ${compBrands.length > 0 ? row('orange', 'Competitor visit history (this browser only)', null) : ''}
        <div style="font-size:0.68rem;color:rgba(255,255,255,0.25);margin-top:12px;line-height:1.5">
          No personal data, email, or IP address is stored. All signals are collected client-side and processed in real-time. Data is not shared with third parties.
        </div>
      </div>`;
  }

  // ── Merge cookie insights into persona ─────────────────────────────────────
  function mergeCookieInsights(p, cookieData) {
    const boosts = cookieData.insights?.scoreBoosts || {};
    return {
      ...p,
      wealthScore:  clamp(p.wealthScore  + (boosts.wealth       || 0)),
      familyScore:  clamp(p.familyScore  + (boosts.family       || 0)),
      perfScore:    clamp(p.perfScore    + (boosts.performance  || 0)),
      ecoScore:     clamp(p.ecoScore     + (boosts.eco          || 0)),
      techScore:    clamp(p.techScore    + (boosts.tech         || 0)),
      intentScore:  clamp(p.intentScore  + (boosts.intent       || 0)),
      cookieSignals: {
        platforms:  cookieData.insights?.detectedPlatforms || [],
        segments:   cookieData.insights?.audienceSegments  || [],
        intentTier: cookieData.insights?.intentTier        || 'LOW',
        hasPaid:    cookieData.insights?.hasPaidTraffic    || false,
        retargeted: cookieData.insights?.inRetargetingPool || false
      }
    };
  }

  // ── Highlight recommended model section ────────────────────────────────────
  function highlightRecommendedModel(model) {
    if (!model) return;
    const slug  = model.toLowerCase().replace(/\s/g, '-');
    const badge = document.getElementById(`badge-${slug}`);
    if (badge) badge.style.display = 'inline-flex';
  }

  // ── Intersection observer → animate sections ──────────────────────────────
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
      const pct = Math.round((window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100);
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

  // ── Debug panel renderer ───────────────────────────────────────────────────
  function renderDebugPanel(p, cookieData, variant, content) {
    const body = document.getElementById('debug-body');
    if (!body) return;

    const scoreColor = (n) => n >= 70 ? 'green' : n >= 40 ? 'orange' : '';
    const scoreRow = (label, val) => `
      <div class="debug-row">
        <span class="debug-key">${label}</span>
        <div class="score-bar-wrap" style="flex:1;margin-left:8px">
          <div class="score-bar-track">
            <div class="score-bar-fill ${scoreColor(val)}" style="width:${val}%"></div>
          </div>
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
        ${row('Intent',  p.intentScore >= 70 ? '<span style="color:#4caf7d">HIGH</span>' : p.intentScore >= 40 ? '<span style="color:#ff9800">MEDIUM</span>' : 'LOW')}
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
        <h5>User Choices</h5>
        ${p.userChoices?.length > 0 ? p.userChoices.map(c => row(c, '✓ selected')).join('') : row('choices', 'none')}
      </div>
      <div class="debug-section">
        <h5>Competitors Detected</h5>
        ${p.competitors?.detectedBrands?.length > 0
          ? p.competitors.detectedBrands.map(b => row(b, '✓ visited')).join('')
          : row('brands', 'none detected')}
      </div>
      <div class="debug-section">
        <h5>Model Recommendation</h5>
        ${row('Model',  p.recommendation?.model)}
        ${row('Trim',   p.recommendation?.trim)}
        ${row('Reason', p.recommendation?.reason)}
      </div>
      <div class="debug-section">
        <h5>Traffic Source</h5>
        ${row('Type',     p.traffic?.referrerType)}
        ${row('Referrer', p.traffic?.referrerHost || 'Direct')}
        ${row('UTM Src',  p.traffic?.utmSource || '—')}
        ${row('Paid',     p.traffic?.isPaidTraffic ? '✓ Yes' : 'No')}
      </div>
      <div class="debug-section">
        <h5>Device</h5>
        ${row('Type',    p.device?.isMobile ? 'Mobile' : p.device?.isTablet ? 'Tablet' : 'Desktop')}
        ${row('OS',      p.device?.isIOS ? 'iOS' : p.device?.isMac ? 'macOS' : p.device?.isAndroid ? 'Android' : p.device?.isWin ? 'Windows' : 'Linux')}
        ${row('Memory',  p.device?.memGB ? p.device.memGB + ' GB' : '?')}
        ${row('Cores',   p.device?.cores)}
        ${row('Premium', p.device?.premiumDevice ? '✓ Yes' : 'No')}
      </div>
      <div class="debug-section">
        <h5>Cookie Signals</h5>
        ${row('Platforms',  (cookieData.insights?.detectedPlatforms || []).join(', ') || 'None')}
        ${row('Intent Tier',cookieData.insights?.intentTier || 'LOW')}
        ${row('Retargeted', cookieData.insights?.inRetargetingPool ? '✓ Yes' : 'No')}
      </div>
      <div class="debug-section">
        <h5>History</h5>
        ${row('Returning',  p.history?.isReturning ? '✓ Yes' : 'New visitor')}
        ${row('Visits',     p.history?.visitCount)}
        ${row('Cart Abnd',  p.history?.cartAbandoned ? '⚠ Yes' : 'No')}
        ${row('Configured', p.history?.configuredModel || '—')}
      </div>
      ${content ? `
      <div class="debug-section">
        <h5>AI-Generated Content</h5>
        ${row('Hero Model',   content.heroModel)}
        ${row('Headline',     content.heroHeadline)}
        ${row('CTA-B',        content.ctaVariantB)}
        ${row('Urgency',      content.urgencyMessage || '—')}
        <div class="debug-row" style="flex-direction:column;gap:4px">
          <span class="debug-key">Why this model?</span>
          <span style="color:rgba(255,255,255,0.6);font-size:0.7rem;line-height:1.4">${content.personalisationReason || '—'}</span>
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

  // ── Public API ─────────────────────────────────────────────────────────────
  window.TeslaAI = {
    trackCTA(model, type) {
      if (abTest) {
        if (type === 'order') abTest.trackOrder(model, '');
        else if (type === 'demo') abTest.trackDemo(model);
        else abTest.trackClick(model, type);
      }
    },

    trackNavOrder() { if (abTest) abTest.trackClick('Nav', 'order'); },

    showTestDrive() {
      if (abTest) abTest.track('test_drive_intent', { model: persona?.recommendation?.model });
      alert('Test Drive booking would open here.\nPersonalised for: ' + (persona?.recommendation?.model || 'Model Y'));
    },

    toggleMobileMenu() {
      document.querySelector('.nav-links')?.classList.toggle('mobile-open');
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
      if (overlay) { setTimeout(() => { overlay.style.display = 'none'; }, 350); }
    },

    closePersonaResult() {
      const el = document.getElementById('persona-result');
      if (el) { el.style.display = 'none'; }
    },

    // Reset choices so modal shows again on next load
    resetChoices() {
      localStorage.removeItem('tesla_ai_user_choices');
      location.reload();
    },

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

    getStats() { return abTest?.getStats(); }
  };

})();
