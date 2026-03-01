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
  const {
    wealthScore = 50, familyScore = 50, perfScore = 50,
    ecoScore = 50, techScore = 50, intentScore = 50,
    segment = 'General', userChoices = [], competitors = {}
  } = persona;

  // Build competitor context if detected
  const competitorBrands = competitors.detectedBrands || [];
  const competitorCtx = competitorBrands.length > 0 ? `

COMPETITOR RESEARCH DETECTED — This visitor recently researched: ${competitorBrands.join(', ')}
Use Tesla's specific advantages over these brands in headlines and taglines:
• vs BMW: Tesla matches or beats 0-60 times at lower price, no dealership markup, OTA software updates monthly, $150/mo gas → $30/mo electric.
• vs KIA/Skoda: Tesla has 5-star NHTSA in all categories, 350–400mi range vs 250mi, class-leading software UX, 60,000+ Superchargers globally.
• vs BYD/Zeekr: Tesla's Supercharger network dominates (60,000+ stalls), FSD full-self-driving lead, proven 5-year resale value advantage, superior crash safety.
Create content that positions Tesla as the unambiguous upgrade from these brands.` : '';

  // Build user choices context
  const choiceLabels = {
    performance: 'Performance & Speed (0-60 times, power, track capability)',
    family:      'Family & Safety (5-star crash ratings, space, school runs)',
    eco:         'Eco & Sustainability (CO₂ savings, solar charging, MPGe)',
    luxury:      'Luxury & Status (premium materials, exclusivity, craftsmanship)',
    tech:        'Tech & Autopilot (FSD, OTA updates, app ecosystem, AI driving)',
    value:       'Best Value (tax credits, fuel savings, low maintenance costs)'
  };
  const choicesCtx = userChoices.length > 0 ? `

USER-STATED PRIORITIES (highest weight — these MUST dominate the content):
${userChoices.map(c => `• ${choiceLabels[c] || c}`).join('\n')}
Every headline, tagline, and benefit must directly address these stated needs.` : '';

  return `You are an elite Tesla conversion-optimisation engine. Generate hyper-personalised Tesla homepage content that maximises the probability of this specific visitor placing an order TODAY.

USER PERSONA:
• Segment:      ${segment}
• Wealth:       ${wealthScore}/100
• Family:       ${familyScore}/100
• Performance:  ${perfScore}/100
• Eco:          ${ecoScore}/100
• Tech:         ${techScore}/100
• Intent:       ${intentScore}/100
• User choices: ${userChoices.length > 0 ? userChoices.join(', ') : 'none stated'}
• Competitors:  ${competitorBrands.length > 0 ? competitorBrands.join(', ') : 'none detected'}
${competitorCtx}${choicesCtx}

TESLA MODEL USPs — use ONLY the relevant ones for this persona's top scores:
• Model 3 Long Range  – $42,990  – 358mi range, 0-60 in 4.2s, 15" cinematic glass, FSD-capable, lowest total cost EV
• Model 3 Performance – $50,990  – 0-60 in 3.1s, dual motor AWD, track-ready, 315mi range, sport suspension
• Model Y Long Range  – $47,990  – America's best-seller, 5-star NHTSA all categories, 7-seat option, 330mi range, 68 cu ft cargo
• Model Y Performance – $52,990  – 0-60 in 3.5s, family SUV faster than sports cars, 5-star crash rating everywhere
• Model S             – $74,990  – 405mi (world's longest EV range), 0-60 in 3.1s, 17" portrait display, executive lounge
• Model S Plaid       – $89,990  – 0-60 in 1.99s (fastest production sedan ever), 1,020hp, tri-motor, plaid seats
• Model X             – $79,990  – Falcon wing doors, 7 seats, 351mi range, lowest drag coefficient SUV on earth
• Model X Plaid       – $94,990  – 1,020hp family rocket, falcon doors, 0-60 in 2.5s, theatre-grade rear screens
• Cybertruck RWD      – $60,990  – Ultra-hard stainless exoskeleton, 11,000 lb tow, 250mi range, built-in generator
• Cybertruck AWD      – $79,990  – 547mi range, 11,000 lb tow, air suspension, camp mode, go-anywhere 4WD

CONTENT RULES:
1. Choose ONE hero model — absolute best fit considering scores AND stated choices.
2. Every headline must feel written ONLY for this person (segment: ${segment}).
3. Wealth >70 → language: "crafted", "exclusive", "pinnacle", "bespoke" — no price talk.
4. Family >65 → concrete proof: "5-star NHTSA every category", "3 car seats fit flat-floor", "16 cameras protect your family".
5. Performance >65 → hard numbers: exact 0-60 time, hp figure, "quarter-mile in X.Xs".
6. Eco >65 → impact data: "$18,000 fuel saved over 5 years", "eliminate 5 tons CO₂/year", "charge on your own solar".
7. Tech >65 → features: "OTA updates ship monthly", "FSD v13 Autopilot", "15\" cinematic glass display".
8. Intent >70 → urgency: "$7,500 federal tax credit expires soon", "Q2 delivery slots filling".
9. If competitor brands detected → include ONE specific comparison advantage in the subheadline.
10. ctaVariantB = ultra-personalised CTA matching their top need (e.g. "Start My Family Build", "Configure My Plaid").
11. sectionOrder MUST list all 5 models; hero model FIRST.

Return ONLY a JSON object — no markdown, no explanation:
{
  "heroModel":             "Model Y",
  "heroTrim":              "Long Range",
  "heroHeadline":          "string (≤40 chars)",
  "heroSubheadline":       "string (≤110 chars)",
  "heroPrimaryCTA":        "string (≤22 chars)",
  "heroSecondaryCTA":      "string (≤22 chars)",
  "urgencyMessage":        "string or null",
  "personalizedBenefits":  ["string","string","string"],
  "priceEmphasis":         "monthly|total|savings",
  "sectionOrder":          ["Model Y","Model 3","Model S","Model X","Cybertruck"],
  "ctaVariantA":           "Order Now",
  "ctaVariantB":           "string (≤22 chars, ultra-personalised)",
  "sections": {
    "Model Y":    { "headline":"string", "tagline":"string", "primaryCTA":"string", "secondaryCTA":"string" },
    "Model 3":    { "headline":"string", "tagline":"string", "primaryCTA":"string", "secondaryCTA":"string" },
    "Model S":    { "headline":"string", "tagline":"string", "primaryCTA":"string", "secondaryCTA":"string" },
    "Model X":    { "headline":"string", "tagline":"string", "primaryCTA":"string", "secondaryCTA":"string" },
    "Cybertruck": { "headline":"string", "tagline":"string", "primaryCTA":"string", "secondaryCTA":"string" }
  },
  "personalisationReason": "string (1-2 sentences, internal rationale)"
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
