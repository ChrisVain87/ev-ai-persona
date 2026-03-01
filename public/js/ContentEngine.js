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
    this._injectEducation(content);
    this._injectFSD(content);
    this._injectSalesProgram(content);
  }

  // ── Hero section ─────────────────────────────────────────────────────────
  _injectHero(c, variant) {
    this._setText('[data-ai="hero-headline"]', c.heroHeadline);
    this._setText('[data-ai="hero-subheadline"]', c.heroSubheadline);
    this._setText('#hero-primary-cta', variant === 'B' ? (c.ctaVariantB || c.heroPrimaryCTA) : c.heroPrimaryCTA);
    this._setText('#hero-secondary-cta', c.heroSecondaryCTA);

    // Swap hero car image based on recommended model
    const heroImg = document.getElementById('hero-model-img');
    if (heroImg && c.heroModel) {
      const IMAGES = {
        'Model Y': 'https://digitalassets.tesla.com/tesla-cms/image/upload/f_auto,q_auto/v1/cms-assets/20220303-Model-Y-Social.png',
        'Model 3': 'https://digitalassets.tesla.com/tesla-cms/image/upload/f_auto,q_auto/v1/cms-assets/20240320-Model-3-Social.png'
      };
      if (IMAGES[c.heroModel]) heroImg.src = IMAGES[c.heroModel];
      heroImg.alt = `Tesla ${c.heroModel}`;
    }

    // Set personalized badge
    const badge = document.getElementById('hero-personalized-badge');
    if (badge && c.heroModel && c.heroTrim) {
      badge.textContent = `Recommended: ${c.heroModel} ${c.heroTrim}`;
    }
  }

  // ── Individual model sections ─────────────────────────────────────────────
  _injectSections(c, variant) {
    if (!c.sections) return;
    // Only process Model Y and Model 3
    const ALLOWED = ['Model Y', 'Model 3'];
    for (const [model, s] of Object.entries(c.sections)) {
      if (!ALLOWED.includes(model)) continue;
      const slug = model.toLowerCase().replace(/\s/g, '-');
      const sec  = document.getElementById(`section-${slug}`);
      if (!sec) continue;

      this._setText(`#section-${slug} [data-ai="headline"]`,      s.headline);
      this._setText(`#section-${slug} [data-ai="tagline"]`,       s.tagline);
      this._setText(`#section-${slug} [data-ai="primary-cta"]`,   variant === 'B' ? (s.primaryCTA || 'Order Now') : 'Order Now');
      this._setText(`#section-${slug} [data-ai="secondary-cta"]`, s.secondaryCTA || 'Book Test Drive');

      // Pre-select AI recommended trim
      if (s.recommendedTrim) {
        const TRIM_MAP = {
          'Standard': 'standard',
          'Standard Long Range': 'standard-lr',
          'Premium Long Range': 'premium-lr',
          'Premium AWD': 'premium-awd',
          'Premium Performance': 'premium-perf'
        };
        const trimKey = TRIM_MAP[s.recommendedTrim];
        if (trimKey) {
          const selector = sec.querySelector(`.trim-selector`);
          if (selector) {
            selector.querySelectorAll('.trim-btn').forEach(btn => {
              btn.classList.toggle('active', btn.dataset.trim === trimKey);
            });
          }
        }
      }
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
    container.style.display = 'flex';
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
    // Only reorder Model Y and Model 3 sections
    const ALLOWED = ['Model Y', 'Model 3'];
    order.filter(m => ALLOWED.includes(m)).forEach((model, i) => {
      const slug = model.toLowerCase().replace(/\s/g, '-');
      const el   = document.getElementById(`section-${slug}`);
      if (el) {
        el.style.order = i;
        el.dataset.rank = i;
        if (i === 0) el.classList.add('hero-model');
      }
    });
  }

  // ── Education section toggle ───────────────────────────────────────────────
  _injectEducation(c) {
    if (c.showEducationSection) {
      const el = document.getElementById('section-education');
      if (el) el.style.display = 'block';
    }
  }

  // ── FSD promotion ─────────────────────────────────────────────────────────
  _injectFSD(c) {
    if (c.promoteFSD) {
      document.querySelectorAll('[data-ai="fsd-cta"]').forEach(el => {
        el.style.color = 'var(--red)';
      });
    }
  }

  // ── Featured sales program ────────────────────────────────────────────────
  _injectSalesProgram(c) {
    if (c.featuredSalesProgram) {
      const el = document.getElementById(`card-${c.featuredSalesProgram}`);
      if (el) el.classList.add('featured-card');
    }
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
