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

// ─── API: Book a test drive ───────────────────────────────────────────────────
app.post('/api/test-drive', (req, res) => {
  const { firstName, lastName, email, model, date, location, phone, trim, time, interests, sessionId } = req.body;
  if (!firstName || !email || !model || !date || !location) {
    return res.status(400).json({ error: 'Required fields missing: firstName, email, model, date, location' });
  }

  const booking = { firstName, lastName, email, phone, model, trim, date, time, location, interests, sessionId, ts: Date.now() };
  analytics.testDriveBookings = analytics.testDriveBookings || [];
  analytics.testDriveBookings.push(booking);

  // Track as conversion event
  if (sessionId && analytics.sessions[sessionId]) {
    analytics.sessions[sessionId].events.push({ event: 'test_drive_booked', model, ts: Date.now() });
  }
  analytics.conversionFunnel['test_drive_booked'] = (analytics.conversionFunnel['test_drive_booked'] || 0) + 1;

  console.log(`[TEST DRIVE] Booked: ${firstName} ${lastName} <${email}> — ${model} ${trim || ''} on ${date} in ${location}`);
  res.json({ success: true, message: 'Test drive confirmed' });
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
    segment = 'General', userChoices = [], competitors = {},
    isFirstVisit = false, history = {}
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
• User choices:     ${userChoices.length > 0 ? userChoices.join(', ') : 'none stated'}
• Competitors:      ${competitorBrands.length > 0 ? competitorBrands.join(', ') : 'none detected'}
• First visit:      ${isFirstVisit ? 'YES — new to Tesla, may need education' : 'No — returning visitor'}
• Visit count:      ${history.visitCount || 1}
• Cart abandoned:   ${history.cartAbandoned ? 'YES — high intent' : 'No'}
• Configured model: ${history.configuredModel || 'none'}
${competitorCtx}${choicesCtx}

TESLA MODEL USPs — use ONLY the relevant ones for this persona's top scores:
MODEL Y TRIMS (family SUV, America's best-seller, 5-star NHTSA all categories, 68 cu ft cargo):
• Model Y Standard           – $40,990 – 260mi range, 0-60 in 5.5s, RWD, 5 seats, FSD-capable
• Model Y Standard LR        – $44,990 – 330mi range, 0-60 in 4.8s, RWD, 5 seats (7-seat option +$3K)
• Model Y Premium LR         – $47,990 – 330mi range, 0-60 in 4.5s, AWD, premium audio, heated rear seats
• Model Y Premium AWD        – $51,990 – 330mi range, 0-60 in 4.2s, AWD, all-weather capability, sport brakes
• Model Y Premium Performance– $54,990 – 315mi range, 0-60 in 3.5s, AWD, sport suspension, lowered 1.5", Alcantara

MODEL 3 TRIMS (sports sedan, longest EV range in class, 15" cinematic display):
• Model 3 Standard           – $38,990 – 272mi range, 0-60 in 5.8s, RWD, 5 seats, FSD-capable
• Model 3 Standard LR        – $42,990 – 358mi range, 0-60 in 4.2s, RWD, lowest cost-per-mile EV
• Model 3 Premium LR         – $46,990 – 358mi range, 0-60 in 4.0s, AWD, premium interior, heated rear seats
• Model 3 Premium AWD        – $50,990 – 315mi range, 0-60 in 3.7s, AWD, sport suspension
• Model 3 Premium Performance– $54,990 – 315mi range, 0-60 in 3.1s, AWD, track mode, sport brakes, Alcantara

FSD (Full Self-Driving, Supervised): $8,000 purchase or $99/month subscription — available on all trims
All trims qualify for $7,500 federal clean vehicle tax credit (applied at point of sale)

CONTENT RULES:
1. Choose ONE hero model — "Model Y" or "Model 3" only. Best fit considering all scores AND stated choices.
2. Choose the best trim for this persona from the 5 trim levels (Standard / Standard LR / Premium LR / Premium AWD / Premium Performance).
3. Every headline must feel written ONLY for this person (segment: ${segment}).
4. Wealth >70 → language: "crafted", "exclusive", "pinnacle" — no price talk.
5. Family >65 → concrete proof: "5-star NHTSA every category", "3 car seats fit flat-floor", "7-seat option".
6. Performance >65 → hard numbers: exact 0-60 time (e.g. "3.1 seconds"), AWD advantage.
7. Eco >65 → impact: "$18,000 fuel saved over 5 years", "charge at home for $30/month".
8. Tech >65 → FSD, OTA updates, "15-inch cinematic display", "144 TOPS neural processing".
9. Intent >70 → urgency: "$7,500 tax credit — apply it instantly", "delivery slots limited".
10. Competitor detected → include ONE specific comparison advantage in the subheadline.
11. showEducationSection: true if no prior visits (isFirstVisit) or eco/value score high (first-time EV buyers).
12. promoteFSD: true if techScore >65 OR perfScore >65.
13. featuredSalesProgram: "tradein" if returning visitor, "financing" if value/eco dominant, "taxcredit" if high intent or first visit.
14. ctaVariantB = ultra-personalised CTA matching their top need (e.g. "Start My Family Build", "Configure Performance").
15. sectionOrder MUST be exactly ["Model Y","Model 3"] — hero model first.

Return ONLY a JSON object — no markdown, no explanation:
{
  "heroModel":             "Model Y",
  "heroTrim":              "Standard Long Range",
  "heroHeadline":          "string (≤40 chars)",
  "heroSubheadline":       "string (≤110 chars)",
  "heroPrimaryCTA":        "string (≤22 chars)",
  "heroSecondaryCTA":      "string (≤22 chars)",
  "urgencyMessage":        "string or null",
  "personalizedBenefits":  ["string","string","string"],
  "showEducationSection":  false,
  "educationFocus":        "charging|savings|safety|null",
  "promoteFSD":            false,
  "fsdReason":             "string or null",
  "featuredSalesProgram":  "tradein|financing|taxcredit|null",
  "salesProgramReason":    "string or null",
  "sectionOrder":          ["Model Y","Model 3"],
  "ctaVariantA":           "Order Now",
  "ctaVariantB":           "string (≤22 chars, ultra-personalised)",
  "sections": {
    "Model Y": { "headline":"string", "tagline":"string", "recommendedTrim":"string", "primaryCTA":"string", "secondaryCTA":"string" },
    "Model 3": { "headline":"string", "tagline":"string", "recommendedTrim":"string", "primaryCTA":"string", "secondaryCTA":"string" }
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
  const { wealthScore = 50, familyScore = 50, perfScore = 50, ecoScore = 50, techScore = 50, isFirstVisit = false, history = {} } = persona;
  let heroModel = 'Model Y';
  let heroTrim  = 'Standard Long Range';

  if (perfScore > 70)                         { heroModel = 'Model 3'; heroTrim = 'Premium Performance'; }
  else if (familyScore > 65 && wealthScore > 60) { heroModel = 'Model Y'; heroTrim = 'Premium Long Range'; }
  else if (familyScore > 65)                  { heroModel = 'Model Y'; heroTrim = 'Standard Long Range'; }
  else if (wealthScore > 65)                  { heroModel = 'Model Y'; heroTrim = 'Premium Long Range'; }
  else if (ecoScore > 65 || techScore > 65)   { heroModel = 'Model 3'; heroTrim = 'Standard Long Range'; }

  const sectionOrder = heroModel === 'Model 3' ? ['Model 3', 'Model Y'] : ['Model Y', 'Model 3'];

  return {
    heroModel, heroTrim,
    heroHeadline:         'Drive Electric. Live Better.',
    heroSubheadline:      'Join 2 million+ Tesla owners. Model Y or Model 3 — see which fits your life.',
    heroPrimaryCTA:       'Build Your Tesla',
    heroSecondaryCTA:     'Book a Test Drive',
    urgencyMessage:       null,
    personalizedBenefits: ['$7,500 federal tax credit applied at purchase', 'Autopilot included on every Tesla', '330mi range — charge at home overnight'],
    showEducationSection: isFirstVisit || false,
    educationFocus:       isFirstVisit ? 'savings' : null,
    promoteFSD:           techScore > 65 || perfScore > 65,
    fsdReason:            null,
    featuredSalesProgram: history.isReturning ? 'tradein' : 'taxcredit',
    salesProgramReason:   null,
    sectionOrder,
    ctaVariantA:          'Order Now',
    ctaVariantB:          'Build Your Tesla',
    sections: {
      'Model Y': { headline: 'Model Y', tagline: 'America\'s Best-Selling Electric SUV', recommendedTrim: heroModel === 'Model Y' ? heroTrim : 'Standard Long Range', primaryCTA: 'Order Now', secondaryCTA: 'Book Test Drive' },
      'Model 3': { headline: 'Model 3', tagline: '358 Miles. Zero Compromises.',           recommendedTrim: heroModel === 'Model 3' ? heroTrim : 'Standard Long Range', primaryCTA: 'Order Now', secondaryCTA: 'Book Test Drive' }
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
const server = app.listen(PORT, () => {
  console.log(`\nTesla AI Persona Engine running on http://localhost:${PORT}`);
  console.log(`   API key: ${process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET — using fallback content'}`);
  console.log(`   A/B split: ${AB_SPLIT}% get AI personalisation\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nERROR: Port ${PORT} is already in use.`);
    console.error(`Run this to fix it:  npx kill-port ${PORT}\nThen restart with:   npm start\n`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
