/**
 * ABTesting — Statistical A/B Test Framework
 * ───────────────────────────────────────────
 * Handles variant assignment (consistent per user via hashing),
 * event tracking, statistical significance calculations, and
 * real-time reporting against the backend analytics store.
 *
 * Variant A = Control   (default Tesla content)
 * Variant B = Treatment (AI-personalised content)
 */
class ABTesting {
  constructor(options = {}) {
    this.apiBase   = options.apiBase   || '';
    this.debug     = options.debug     || false;
    this.onEvent   = options.onEvent   || (() => {});
    this._queue    = [];   // Buffer events if we're offline
    this._flushing = false;

    // Local event log for session reporting
    this._log = [];
  }

  // ── Assign variant ────────────────────────────────────────────────────────
  /**
   * Deterministically assigns a variant based on userId hash.
   * Same user always gets the same variant within a session.
   * @param {string} userId
   * @param {number} splitPct  % of traffic in variant B (0-100, default 50)
   * @returns {'A'|'B'}
   */
  assignVariant(userId, splitPct = 50) {
    const hash    = this._hash(userId || 'anon-' + Date.now());
    const bucket  = hash % 100;                          // 0-99
    this.variant  = bucket < splitPct ? 'B' : 'A';
    this.userId   = userId;
    if (this.debug) console.log(`[ABTest] User ${userId.slice(0, 8)} → Variant ${this.variant} (bucket ${bucket})`);
    return this.variant;
  }

  isVariantB() { return this.variant === 'B'; }
  isVariantA() { return this.variant === 'A'; }

  // ── Track events ──────────────────────────────────────────────────────────
  /**
   * Track a conversion event.
   * @param {string} event   'views' | 'clicks' | 'orders' | 'demos' | custom
   * @param {object} data    Extra metadata
   */
  track(event, data = {}) {
    const entry = {
      event,
      variant:   this.variant || 'A',
      userId:    this.userId  || 'anon',
      sessionId: this._sessionId(),
      model:     data.model || null,
      data,
      ts:        Date.now()
    };

    this._log.push(entry);
    this.onEvent(entry);

    // Fire-and-forget to backend
    this._enqueue(entry);

    // Also fire to GTM DataLayer if available
    this._pushDataLayer(event, data);

    if (this.debug) console.log('[ABTest] Track:', entry);
  }

  // Convenience wrappers
  trackView(model)    { this.track('views',  { model }); }
  trackClick(model, cta) { this.track('clicks', { model, cta }); }
  trackOrder(model, trim) { this.track('orders', { model, trim }); }
  trackDemo(model)    { this.track('demos',  { model }); }
  trackScroll(depth)  { this.track('scroll', { depth }); }
  trackEngagement(secs) { this.track('engaged', { seconds: secs }); }

  // ── Retrieve live stats from backend ─────────────────────────────────────
  async getStats() {
    try {
      const res  = await fetch(`${this.apiBase}/api/stats`);
      const data = await res.json();
      if (this.debug) console.log('[ABTest] Stats:', data);
      return data;
    } catch (e) {
      console.warn('[ABTest] Could not fetch stats:', e.message);
      return null;
    }
  }

  // ── Session report (client-side) ──────────────────────────────────────────
  getSessionReport() {
    const events = this._log;
    const byEvent = {};
    events.forEach(e => { byEvent[e.event] = (byEvent[e.event] || 0) + 1; });
    return {
      variant:    this.variant,
      userId:     this.userId,
      sessionId:  this._sessionId(),
      events:     byEvent,
      totalEvents: events.length,
      log:        events
    };
  }

  // ── Chi-Square significance (client-side) ─────────────────────────────────
  /**
   * @param {{views:number, conversions:number}} variantA
   * @param {{views:number, conversions:number}} variantB
   */
  static significance(variantA, variantB) {
    const { views: nA, conversions: cA } = variantA;
    const { views: nB, conversions: cB } = variantB;

    if (nA < 30 || nB < 30) return { significant: false, message: 'Need ≥30 samples per variant', confidence: 0 };
    if (cA + cB === 0)      return { significant: false, message: 'No conversions yet', confidence: 0 };

    const rA = cA / nA;
    const rB = cB / nB;
    const N  = nA + nB;
    const C  = cA + cB;
    const expected = C / N;

    // Pooled chi-square
    const chi = (nA * Math.pow(rA - expected, 2) / expected) +
                (nB * Math.pow(rB - expected, 2) / expected);

    // Chi-square CDF approximation (1 dof)
    const confidence = ABTesting._chiCDF(chi);
    const significant = confidence >= 0.95;  // 95% confidence

    const lift = rA > 0 ? (((rB - rA) / rA) * 100) : null;

    return {
      significant,
      confidence: Math.round(confidence * 1000) / 10,  // e.g. 97.2
      chi:        Math.round(chi * 1000) / 1000,
      lift:       lift !== null ? `${lift >= 0 ? '+' : ''}${lift.toFixed(1)}%` : null,
      rateA:      `${(rA * 100).toFixed(2)}%`,
      rateB:      `${(rB * 100).toFixed(2)}%`,
      winner:     significant ? (rB > rA ? 'B' : 'A') : null,
      message:    significant
        ? `Variant ${rB > rA ? 'B' : 'A'} wins at ${Math.round(confidence * 1000) / 10}% confidence (lift ${lift !== null ? lift.toFixed(1) : '?'}%)`
        : `Not yet significant (${Math.round(confidence * 1000) / 10}% confidence) — keep collecting data`
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────
  _enqueue(entry) {
    this._queue.push(entry);
    if (!this._flushing) this._flush();
  }

  async _flush() {
    this._flushing = true;
    while (this._queue.length > 0) {
      const entry = this._queue.shift();
      try {
        await fetch(`${this.apiBase}/api/track`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(entry),
          keepalive: true
        });
      } catch {
        this._queue.unshift(entry);  // re-queue on failure
        break;
      }
      await this._sleep(50);  // small throttle
    }
    this._flushing = false;
  }

  _pushDataLayer(event, data) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        event:        `tesla_ai_${event}`,
        variant:      this.variant,
        abTest:       'AI_Personalization_v1',
        ...data
      });
    } catch { /* GTM not loaded */ }
  }

  _sessionId() {
    try {
      let id = sessionStorage.getItem('ab_session_id');
      if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36); sessionStorage.setItem('ab_session_id', id); }
      return id;
    } catch { return Date.now().toString(36); }
  }

  // djb2 hash function — fast, consistent, no crypto needed
  _hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
    return Math.abs(h >>> 0);  // unsigned 32-bit
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Approximation of the chi-square CDF for 1 degree of freedom
  // (regularised incomplete gamma function P(0.5, chi/2))
  static _chiCDF(chi) {
    if (chi <= 0) return 0;
    const x = chi / 2;
    return ABTesting._incGammaHalf(x);
  }

  // P(0.5, x) approximation via series expansion
  static _incGammaHalf(x) {
    const erfc = (t) => {
      const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
      const p = 0.3275911;
      const sign = t < 0 ? -1 : 1;
      t = Math.abs(t);
      const z = 1 / (1 + p * t);
      let poly = 0;
      for (let i = 4; i >= 0; i--) poly = poly * z + a[i];
      return sign * (1 - poly * z * Math.exp(-t * t));
    };
    return erfc(-Math.sqrt(x)) - 1;  // clamp via erf
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = ABTesting;
