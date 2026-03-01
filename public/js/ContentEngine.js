/**
 * ContentEngine — AI Content Fetcher & DOM Injector
 * ──────────────────────────────────────────────────
 * Fetches AI-generated content from the backend, injects it into
 * [data-ai-*] tagged elements, reorders model sections, and manages
 * the loading/reveal animation sequence.
 */
class ContentEngine {
  constructor(options = {}) {
    this.apiBase     = options.apiBase     || '';
    this.abVariant   = options.abVariant   || 'A';
    this.debug       = options.debug       || false;
    this.timeout     = options.timeout     || 9000;   // ms before fallback
    this.onReady     = options.onReady     || (() => {});
    this.onError     = options.onError     || (() => {});
    this._content    = null;
  }

  // ── Fetch AI content from backend ────────────────────────────────────────
  async fetch(persona, sessionId) {
    if (this.abVariant === 'A') {
      // Control: no AI call, use DOM defaults
      this._content = null;
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.apiBase}/api/content`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ persona, sessionId }),
        signal:  controller.signal
      });
      clearTimeout(timer);

      const { content, fallback } = await res.json();
      this._content = content;
      if (this.debug) console.log('[ContentEngine] Received content:', content, fallback ? '(fallback)' : '(AI)');
      return content;
    } catch (err) {
      clearTimeout(timer);
      if (this.debug) console.warn('[ContentEngine] Fetch failed:', err.message);
      this.onError(err);
      return null;
    }
  }

  // ── Inject content into page ──────────────────────────────────────────────
  inject(content, abVariant) {
    if (!content) return;  // Control variant: keep DOM defaults

    this._injectHero(content, abVariant);
    this._injectSections(content, abVariant);
    this._injectUrgency(content);
    this._injectBenefits(content);
    this._reorderSections(content.sectionOrder);
    this._injectNavCTA(content, abVariant);
  }

  // ── Hero section ─────────────────────────────────────────────────────────
  _injectHero(c, variant) {
    this._setText('[data-ai="hero-headline"]', c.heroHeadline);
    this._setText('[data-ai="hero-subheadline"]', c.heroSubheadline);
    this._setText('[data-ai="hero-primary-cta"]', variant === 'B' ? (c.ctaVariantB || c.heroPrimaryCTA) : c.heroPrimaryCTA);
    this._setText('[data-ai="hero-secondary-cta"]', c.heroSecondaryCTA);
    this._setText('[data-ai="hero-model-label"]', `${c.heroModel} ${c.heroTrim}`);

    // Switch hero section to recommended model's theme
    const heroSection = document.getElementById('section-hero');
    if (heroSection && c.heroModel) {
      heroSection.setAttribute('data-active-model', c.heroModel.toLowerCase().replace(/\s/g, '-'));
      // Update background class
      heroSection.className = heroSection.className.replace(/model-\S+/g, '') + ' model-' + c.heroModel.toLowerCase().replace(/\s/g, '-').replace('model-', '');
    }

    // Price emphasis
    const priceEl = document.querySelector('[data-ai="hero-price"]');
    if (priceEl && c.priceEmphasis === 'monthly') {
      const prices = { 'Model Y': 47990, 'Model 3': 42990, 'Model S': 74990, 'Model X': 79990, 'Cybertruck': 79990 };
      const base = prices[c.heroModel] || 47990;
      priceEl.textContent = `From $${Math.round(base / 72).toLocaleString()}/mo`;
    }
  }

  // ── Individual model sections ─────────────────────────────────────────────
  _injectSections(c, variant) {
    if (!c.sections) return;
    for (const [model, s] of Object.entries(c.sections)) {
      const slug = model.toLowerCase().replace(/\s/g, '-');
      const sec  = document.getElementById(`section-${slug}`);
      if (!sec) continue;

      this._setText(`#section-${slug} [data-ai="headline"]`,     s.headline);
      this._setText(`#section-${slug} [data-ai="tagline"]`,      s.tagline);
      this._setText(`#section-${slug} [data-ai="primary-cta"]`,  variant === 'B' ? (s.primaryCTA || 'Order Now') : 'Order Now');
      this._setText(`#section-${slug} [data-ai="secondary-cta"]`,s.secondaryCTA || 'Demo Drive');
    }
  }

  // ── Urgency banner ────────────────────────────────────────────────────────
  _injectUrgency(c) {
    const el = document.getElementById('urgency-banner');
    if (!el) return;
    if (c.urgencyMessage) {
      el.textContent = c.urgencyMessage;
      el.classList.add('visible');
    } else {
      el.classList.remove('visible');
    }
  }

  // ── Benefits strip ────────────────────────────────────────────────────────
  _injectBenefits(c) {
    const container = document.getElementById('benefits-strip');
    if (!container || !c.personalizedBenefits?.length) return;
    container.innerHTML = c.personalizedBenefits
      .map(b => `<div class="benefit-item"><span class="benefit-check">✓</span> ${b}</div>`)
      .join('');
    container.classList.add('visible');
  }

  // ── Nav CTA ────────────────────────────────────────────────────────────────
  _injectNavCTA(c, variant) {
    const el = document.getElementById('nav-order-cta');
    if (!el) return;
    el.textContent = variant === 'B' ? (c.ctaVariantB || 'Order Now') : 'Order Now';
  }

  // ── Reorder sections ──────────────────────────────────────────────────────
  _reorderSections(order) {
    if (!order?.length) return;
    const container = document.getElementById('models-container');
    if (!container) return;

    order.forEach((model, i) => {
      const slug = model.toLowerCase().replace(/\s/g, '-');
      const el   = document.getElementById(`section-${slug}`);
      if (el) {
        el.style.order = i;           // CSS flexbox order
        el.dataset.rank = i;
        if (i === 0) el.classList.add('hero-model');
      }
    });
  }

  // ── Loading screen helpers ────────────────────────────────────────────────
  showLoading() {
    const el = document.getElementById('loading-screen');
    if (el) el.classList.add('active');
  }

  hideLoading(delay = 300) {
    return new Promise(resolve => {
      setTimeout(() => {
        const el = document.getElementById('loading-screen');
        if (el) {
          el.classList.add('fade-out');
          el.addEventListener('transitionend', () => {
            el.classList.remove('active', 'fade-out');
            resolve();
          }, { once: true });
        } else {
          resolve();
        }
      }, delay);
    });
  }

  updateLoadingText(msg) {
    const el = document.getElementById('loading-status');
    if (el) el.textContent = msg;
  }

  // ── Utility ───────────────────────────────────────────────────────────────
  _setText(selector, text) {
    if (!text) return;
    const el = document.querySelector(selector);
    if (el) el.textContent = text;
  }

  get content() { return this._content; }
}

if (typeof module !== 'undefined' && module.exports) module.exports = ContentEngine;
