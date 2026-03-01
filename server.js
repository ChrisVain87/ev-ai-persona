'use strict';
require('dotenv').config();

const express     = require('express');
const path        = require('path');
const cookieParser= require('cookie-parser');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const Anthropic   = require('@anthropic-ai/sdk');

const app      = express();
const PORT     = process.env.PORT || 3000;
const AB_SPLIT = parseInt(process.env.AB_SPLIT || '50', 10); // % getting AI content

// ─── Anthropic Client ───────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory analytics store (swap Redis/Postgres in production) ───────────
const analytics = {
  sessions: {},          // sessionId → { variant, persona, events[] }
  abSummary: {           // aggregated A/B counts
    A: { views: 0, clicks: 0, orders: 0, demos: 0 },
    B: { views: 0, clicks: 0, orders: 0, demos: 0 }
  },
  modelImpressions: {},  // model → count
  conversionFunnel: {}   // event → count
};

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const apiLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

// ─── API: Generate AI-personalised content ───────────────────────────────────
app.post('/api/content', async (req, res) => {
  const { persona, sessionId } = req.body;
  if (!persona) return res.status(400).json({ error: 'persona required' });

  // Enrich persona with server-side signals
  const enriched = enrichPersona(persona, req);

  try {
    const content = await generateContent(enriched);
    // Store session
    analytics.sessions[sessionId] = {
      variant: 'B',
      persona: enriched,
      events: [],
      content,
      ts: Date.now()
    };
    return res.json({ success: true, content, persona: enriched });
  } catch (err) {
    console.error('[AI] Content generation failed:', err.message);
    const fallback = getDefaultContent(enriched);
    analytics.sessions[sessionId] = {
      variant: 'B',
      persona: enriched,
      events: [],
      content: fallback,
      ts: Date.now()
    };
    return res.json({ success: false, content: fallback, persona: enriched, fallback: true });
  }
});

// ─── API: Track events ────────────────────────────────────────────────────────
app.post('/api/track', (req, res) => {
  const { sessionId, variant, event, model, data } = req.body;
  if (!event) return res.status(400).json({ error: 'event required' });

  const v = variant || 'A';
  if (analytics.abSummary[v] && analytics.abSummary[v][event] !== undefined) {
    analytics.abSummary[v][event]++;
  } else if (analytics.abSummary[v]) {
    analytics.abSummary[v][event] = 1;
  }

  analytics.conversionFunnel[event] = (analytics.conversionFunnel[event] || 0) + 1;

  if (model) {
    analytics.modelImpressions[model] = (analytics.modelImpressions[model] || 0) + 1;
  }

  if (sessionId && analytics.sessions[sessionId]) {
    analytics.sessions[sessionId].events.push({ event, model, data, ts: Date.now() });
  }

  res.json({ success: true });
});

// ─── API: Get A/B stats dashboard ────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const { abSummary, modelImpressions, conversionFunnel } = analytics;

  // Compute conversion rates
  const stats = {};
  for (const [v, counts] of Object.entries(abSummary)) {
    const views  = counts.views  || 1;
    const orders = counts.orders || 0;
    const demos  = counts.demos  || 0;
    stats[v] = {
      ...counts,
      orderRate: ((orders / views) * 100).toFixed(2) + '%',
      demoRate:  ((demos  / views) * 100).toFixed(2) + '%'
    };
  }

  // Chi-square significance (simplified)
  const sig = chiSquareSignificance(
    abSummary.A.views, abSummary.A.orders,
    abSummary.B.views, abSummary.B.orders
  );

  res.json({ stats, modelImpressions, conversionFunnel, significance: sig, abSplit: AB_SPLIT });
});

// ─── API: Assign A/B variant ──────────────────────────────────────────────────
app.post('/api/variant', (req, res) => {
  const { userId } = req.body;
  const hash = simpleHash(userId || Math.random().toString());
  const variant = (hash % 100) < AB_SPLIT ? 'B' : 'A';
  analytics.abSummary[variant].views++;
  res.json({ variant });
});

// ─── Catch-all → index.html ───────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Core AI content generator ────────────────────────────────────────────────
async function generateContent(persona) {
  const prompt = buildPrompt(persona);

  const message = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2048,
    messages:   [{ role: 'user', content: prompt }]
  });

  const raw = message.content[0].text;
  return parseContent(raw);
}

function buildPrompt(persona) {
  return `You are an elite Tesla conversion-optimisation engine. Your ONLY job is to generate hyper-personalised Tesla homepage content that maximises the probability of this specific visitor placing an order TODAY.

USER PERSONA (built from browser signals, cookies & behavioural data):
${JSON.stringify(persona, null, 2)}

SCORING KEY:
• wealthScore   0-100 (financial capacity)
• familyScore   0-100 (family-oriented lifestyle)
• perfScore     0-100 (performance/speed enthusiast)
• ecoScore      0-100 (sustainability-driven)
• techScore     0-100 (tech-savvy early adopter)
• intentScore   0-100 (purchase intent urgency)

TESLA MODEL REFERENCE:
• Model 3 Long Range  – $42,990  – Young professional, tech-first, daily driver
• Model 3 Performance – $50,990  – Performance seeker, track-day driver
• Model Y Long Range  – $47,990  – Family, practical, America's best-seller
• Model Y Performance – $52,990  – Active family, weekend adventures
• Model S             – $74,990  – Executive, luxury, long-range traveller
• Model S Plaid       – $89,990  – Wealth + performance pinnacle
• Model X             – $79,990  – Large family, premium SUV, falcon doors
• Model X Plaid       – $94,990  – Wealthy family, status + performance
• Cybertruck RWD      – $60,990  – Utility, rural, adventurous, contractor
• Cybertruck AWD      – $79,990  – Premium utility, off-road, ranch

INSTRUCTIONS:
1. Choose ONE hero model that is the absolute best fit for this persona.
2. Make every headline feel like it was written ONLY for this person.
3. High wealth → premium language, exclusivity, craftsmanship.
4. Family signals → safety ratings, cargo space, range, school runs.
5. Performance signals → 0-60 times, Ludicrous mode, track data.
6. Eco signals → lifetime CO₂ savings, MPGe, renewable energy angle.
7. Tech signals → FSD, Autopilot, OTA updates, app ecosystem.
8. High intent → urgency (limited inventory, tax credit deadline).
9. Use A/B variant CTA: ctaVariantA = "Order Now", ctaVariantB = something ultra-specific.
10. sectionOrder MUST list all 5 models; put hero model FIRST.

Return ONLY a JSON object — no markdown, no explanation — matching this exact schema:
{
  "heroModel":          "Model Y",
  "heroTrim":           "Long Range",
  "heroHeadline":       "string (≤40 chars)",
  "heroSubheadline":    "string (≤110 chars)",
  "heroPrimaryCTA":     "string (≤22 chars)",
  "heroSecondaryCTA":   "string (≤22 chars)",
  "urgencyMessage":     "string or null",
  "personalizedBenefits": ["string","string","string"],
  "priceEmphasis":      "monthly|total|savings",
  "sectionOrder":       ["Model Y","Model 3","Model S","Model X","Cybertruck"],
  "ctaVariantA":        "Order Now",
  "ctaVariantB":        "string (≤22 chars, ultra-personalised)",
  "sections": {
    "Model Y":       { "headline":"string", "tagline":"string", "primaryCTA":"string", "secondaryCTA":"string" },
    "Model 3":       { "headline":"string", "tagline":"string", "primaryCTA":"string", "secondaryCTA":"string" },
    "Model S":       { "headline":"string", "tagline":"string", "primaryCTA":"string", "secondaryCTA":"string" },
    "Model X":       { "headline":"string", "tagline":"string", "primaryCTA":"string", "secondaryCTA":"string" },
    "Cybertruck":    { "headline":"string", "tagline":"string", "primaryCTA":"string", "secondaryCTA":"string" }
  },
  "personalisationReason": "string (internal rationale, 1-2 sentences)"
}`;
}

function parseContent(raw) {
  // Strip potential markdown fences
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Attempt to extract JSON block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Failed to parse AI response as JSON');
  }
}

// ─── Server-side persona enrichment ──────────────────────────────────────────
function enrichPersona(persona, req) {
  const ip      = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '';
  const ua      = req.headers['user-agent'] || '';
  const lang    = req.headers['accept-language'] || '';
  const country = req.headers['cf-ipcountry'] || req.headers['x-country-code'] || '';

  return {
    ...persona,
    server: { ip: ip.replace(/^::ffff:/, ''), ua, lang, country, ts: new Date().toISOString() }
  };
}

// ─── Fallback content (when AI is unavailable) ────────────────────────────────
function getDefaultContent(persona) {
  // Simple rule-based fallback
  const { wealthScore = 50, familyScore = 50, perfScore = 50 } = persona;
  let heroModel = 'Model Y';
  let heroTrim  = 'Long Range';

  if (wealthScore > 75 && perfScore > 60) { heroModel = 'Model S'; heroTrim = 'Plaid'; }
  else if (familyScore > 65 && wealthScore > 60) { heroModel = 'Model X'; heroTrim = 'Long Range'; }
  else if (perfScore > 70) { heroModel = 'Model 3'; heroTrim = 'Performance'; }

  return {
    heroModel, heroTrim,
    heroHeadline:    'Drive the Future',
    heroSubheadline: 'Experience the safest, fastest, most capable electric vehicle ever built.',
    heroPrimaryCTA:  'Order Now',
    heroSecondaryCTA:'Demo Drive',
    urgencyMessage:  null,
    personalizedBenefits: ['Zero emissions', 'Autopilot included', '$7,500 federal tax credit'],
    priceEmphasis:   'monthly',
    sectionOrder:    [heroModel, 'Model Y', 'Model 3', 'Model S', 'Model X', 'Cybertruck'].filter((v, i, a) => a.indexOf(v) === i),
    ctaVariantA:     'Order Now',
    ctaVariantB:     'Build Your Tesla',
    sections: {
      'Model Y':    { headline:'Model Y', tagline:'For Every Adventure', primaryCTA:'Order Now', secondaryCTA:'Demo Drive' },
      'Model 3':    { headline:'Model 3', tagline:'The Future of Driving', primaryCTA:'Order Now', secondaryCTA:'Demo Drive' },
      'Model S':    { headline:'Model S', tagline:'Relentless Performance', primaryCTA:'Order Now', secondaryCTA:'Demo Drive' },
      'Model X':    { headline:'Model X', tagline:'Maximum Versatility', primaryCTA:'Order Now', secondaryCTA:'Demo Drive' },
      'Cybertruck': { headline:'Cybertruck', tagline:'Built for the World Outside', primaryCTA:'Order Now', secondaryCTA:'Demo Drive' }
    },
    personalisationReason: 'Fallback content — AI unavailable'
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function chiSquareSignificance(nA, cA, nB, cB) {
  if (nA < 10 || nB < 10) return { significant: false, pValue: null, message: 'Insufficient data' };
  const rA = cA / nA, rB = cB / nB;
  const total = nA + nB, converted = cA + cB;
  if (total === 0 || converted === 0) return { significant: false, pValue: null, message: 'No conversions yet' };
  const expected = converted / total;
  const chi = nA * Math.pow(rA - expected, 2) / expected +
               nB * Math.pow(rB - expected, 2) / expected;
  // Approximate p-value: chi > 3.84 → p < 0.05
  const significant = chi > 3.84;
  const lift = rA > 0 ? (((rB - rA) / rA) * 100).toFixed(1) + '%' : 'N/A';
  return { significant, chi: chi.toFixed(3), lift, message: significant ? `Statistically significant (p<0.05). B lifts orders by ${lift}` : 'Not yet significant — keep collecting data' };
}

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Tesla AI Persona Engine running on http://localhost:${PORT}`);
  console.log(`   API key: ${process.env.ANTHROPIC_API_KEY ? '✅ set' : '⚠️  NOT SET — using fallback content'}`);
  console.log(`   A/B split: ${AB_SPLIT}% get AI personalisation\n`);
});
