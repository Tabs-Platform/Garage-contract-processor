import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const uploadDir = process.env.NODE_ENV === 'production' ? '/tmp/uploads/' : 'uploads/';
try { fs.mkdirSync(uploadDir, { recursive: true }); } catch {}
const upload = multer({ dest: uploadDir });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

const BILLING_TYPES = ['Flat price','Unit price','Tier flat price','Tier unit price'];
const FREQ_UNITS   = ['None','Day(s)','Week(s)','Semi_month(s)','Month(s)','Year(s)'];

/* ----------------------- ITEM NAME → INTEGRATION ITEM ---------------------- */
const INTEGRATION_PAIRS = [
  ['Ad Spend ($500)', 'Ad Spend'],
  ['Ad Spend ($1,000)', 'Ad Spend'],
  ['Ad Spend Add On', 'Ad Spend Add On'],
  ['Presence Platform User Seat', 'Additional User Seat'],
  ['Additional Website Page', 'Additional Website Page'],
  ['Agent Bio', 'Agent Bio'],
  ['Agent Landing Pages', 'Agent Landing Pages'],
  ['Standard User Seat', 'Agent Subdomains'],
  ['AI Advertising Specialist', 'AI Advertising Specialist'],
  ['AI Blog Specialist', 'AI Blog Specialist'],
  ['AI Lead Nurture', 'AI Lead Nurture'],
  ['AI SEO Specialist', 'AI SEO Specialist'],
  ['All In', 'All In'],
  ['All In Premier', 'All In Premier'],
  ['Base', 'Base'],
  ['Bespoke Website', 'Bespoke Website'],
  ['Blog Migration', 'Blog Migration'],
  ['Brand', 'Brand'],
  ['Brand+', 'Brand+'],
  ['Collective by Luxury Presence', 'Collective by Luxury Presence'],
  ['Branded Mobile App User Seat', 'Copilot (White-Label) Additional Agent Seat'],
  ['Branded Mobile App Activation', 'Copilot Activation (White-Label)'],
  ['Luxury Presence Mobile App User Seat', 'Copilot Agent Seat'],
  ['Branded Mobile App Subscription', 'Copilot Subscription (White-Label)'],
  ['Design Change (Pro)', 'Design Change (within Pro)'],
  ['Design Change (Custom)', 'Design Change to Custom'],
  ['Design Refresh', 'Design Refresh'],
  ['Dev Hours', 'Dev Hours'],
  ['Development Website (Monthly)', 'Development Website (Monthly)'],
  ['One-Time Setup Fee (Development)', 'Development Website (One-Time Setup Fee)'],
  ['Domain Forwarding', 'Domain Forwarding'],
  ['Enterprise', 'Enterprise'],
  ['Enterprise Features', 'Enterprise Features'],
  ['Feed Integration Partner', 'Feed Integration Partner'],
  ['Growth+', 'Growth+'],
  ['IDX Tool', 'IDX Tool'],
  ['Launch', 'Launch'],
  ['Launch+', 'Launch+'],
  ['Lead Gen Ads', 'Lead Gen Ads'],
  ['Lead Gen Ads (Premier)', 'Lead Gen Ads (Premier)'],
  ['Leads Premier', 'Leads Premier'],
  ['Leads Pro', 'Leads Pro'],
  ['Press Migration', 'N/A (did not exist previously)'],
  ['Neighborhood Migration', 'N/A (did not exist previously)'],
  ['Development Migration', 'N/A (did not exist previously)'],
  ['Testimonial Migration', 'N/A (did not exist previously)'],
  ['Neighborhood Copy', 'Neighborhood Copy'],
  ['Neighborhood Guide', 'Neighborhood Guide'],
  ['One-Click Property Websites', 'One-Click Property Websites'],
  ['One-Time Setup Fee (All In Premier Custom)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (All In Premier)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (Brand+ & Custom)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (Brand+ & Pro)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (Launch+ & Custom)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (Launch+ & Pro)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (Leads Premier Custom)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (Leads Premier)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (Leads Pro & Custom)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (Leads Pro & Pro)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (Presence Premier Custom)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (Presence Premier)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (SEO Premier Custom)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (SEO Premier)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (SEO Pro & Custom)', 'One-Time Setup Fee'],
  ['One-Time Setup Fee (SEO Pro & Pro)', 'One-Time Setup Fee'],
  ['Opening Video', 'Opening Video'],
  ['Pages of Copywriting', 'Pages of Copywriting'],
  ['Premium Support', 'Premium Support'],
  ['Premium+', 'Premium+'],
  ['Presence Premier', 'Presence Premier'],
  ['Property Migration', 'Property Migration'],
  ['Remove LP Link in Footer', 'Remove LP Link in Footer'],
  ['Self-Serve Property Website (Monthly)', 'Self-Serve Property Website (Monthly)'],
  ['One-Time Setup Fee (Self-Serve Property Website)', 'Self-Serve Property Website (One-Time Setup Fee)'],
  ['SEO Blog Post', 'SEO Blog Post'],
  ['SEO Migration', 'SEO Migration'],
  ['SEO Premier', 'SEO Premier'],
  ['SEO Pro', 'SEO Pro'],
  ['Social Media', 'Social Media'],
  ['Template Change', 'Template Change'],
  ['Video Editing', 'Video Editing'],
  ['12 Blogs per Quarter', '12 Blogs per Quarter'],
  ['6 Blogs per Quarter', '6 Blogs per Quarter'],
  ['Performance SEO Add On', 'Editorial SEO Add On'],
  ['Premium User Seat', 'Premium User Seat'],
];
const INTEGRATION_BY_ITEM = new Map(
  INTEGRATION_PAIRS.map(([itemName, integrationId]) => [itemName.toLowerCase().trim(), integrationId])
);
function canonicalizeName(s) {
  let t = String(s || '').toLowerCase();
  t = t.replace(/&/g, 'and');
  t = t.replace(/[^a-z0-9]/g, ' ');
  t = t.replace(/\b(add[-\s]?on|addon)s?\b/g, ''); // ignore “Add-On”
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/(\d)\s+(?=\d)/g, '$1');
  return t;
}
const CANON_INDEX = Array.from(INTEGRATION_BY_ITEM.entries()).map(([k, v]) => ({ rawKey: k, canonKey: canonicalizeName(k), val: v }));
function mapIntegrationItem(itemName) {
  if (!itemName) return null;
  const exact = INTEGRATION_BY_ITEM.get(String(itemName).toLowerCase().trim());
  if (exact) return exact;
  const canon = canonicalizeName(itemName);
  const hit = CANON_INDEX.find(e => e.canonKey === canon);
  return hit ? hit.val : null;
}

/* ------------------- Normalization & guardrails ------------------- */
function clampEnum(value, allowed, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  const byLower = new Map(allowed.map(v => [v.toLowerCase(), v]));
  return byLower.get(value.toLowerCase()) || fallback;
}
function isLuxuryPresenceHint(s) {
  const parts = []
    .concat(s?.item_name || [], s?.description || [])
    .concat(Array.isArray(s?.evidence) ? s.evidence.map(e => e?.snippet || '') : []);
  const hay = parts.join(' ').toLowerCase();
  return /luxury\s+presence/.test(hay);
}
function hasStrongUnitEvidence(s) {
  const parts = []
    .concat(s?.item_name || [], s?.description || [], s?.unit_label || [])
    .concat(Array.isArray(s?.evidence) ? s.evidence.map(e => e?.snippet || '') : []);
  const hay = parts.join(' ').toLowerCase();
  const perPattern = /\b(per|each|\/)\s*(seat|user|impression|click|lead|unit|order|transaction|visit|listing|ad|sku|gb|hour|minute|api call|api|sms|email|message|device|location|month|year)s?\b/;
  const usageWords = /\b(overage|usage|metered|consumption|rate\s*card|per[-\s]*use)\b/;
  const hasPPU = Number.isFinite(Number(s?.price_per_unit));
  const hasUnitLabel = !!(s?.unit_label && String(s.unit_label).trim());
  const tierCount = Array.isArray(s?.tiers) ? s.tiers.length : 0;
  return perPattern.test(hay) || usageWords.test(hay) || (hasPPU && hasUnitLabel) || tierCount > 0;
}
function normalizeBillingType(bt, hint = {}) {
  if (isLuxuryPresenceHint(hint)) return 'Flat price';
  if (Array.isArray(hint?.tiers) && hint.tiers.length) return 'Tier unit price';
  if (hasStrongUnitEvidence(hint)) return 'Unit price';
  const t = (bt || '').toLowerCase();
  if (t.includes('tier') && t.includes('unit')) return 'Tier unit price';
  if (t.includes('tier') && t.includes('flat')) return 'Tier flat price';
  return 'Flat price';
}
function normalizeFrequency(rawText, rawEvery, rawUnit, fallback = 'None') {
  let every = Number.isFinite(Number(rawEvery)) ? Number(rawEvery) : 1;
  let unit  = clampEnum(rawUnit, FREQ_UNITS, null);
  const txt = (rawText || '').toLowerCase();
  if (!unit) {
    if (!txt || txt === 'none' || txt.includes('one-time')) { unit = 'None'; every = 1; }
    else if (txt.includes('annual'))  { unit = 'Year(s)';  every = 1; }
    else if (txt.includes('month'))   { unit = 'Month(s)'; every = 1; }
    else if (txt.includes('week'))    { unit = 'Week(s)';  every = 1; }
    else if (txt.includes('semi'))    { unit = 'Semi_month(s)'; every = 1; }
    else if (txt.includes('day'))     { unit = 'Day(s)';   every = 1; }
    else unit = fallback;
  }
  if (unit === 'None') every = 1;
  return { every, unit };
}
function pickNumber(n, fallback = null) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}
function computeTotalValue(s) {
  const periods = s.frequency_unit === 'None' ? 1 : pickNumber(s.periods, 1);
  const price   = pickNumber(s.total_price, null);
  if (price != null) return +(price * periods).toFixed(2);
  const ppu = pickNumber(s.price_per_unit, null);
  if (ppu != null) return +(ppu * periods).toFixed(2);
  return null;
}

/* ------------------- Prompt ------------------- */
function buildSystemPrompt(forceMulti = 'auto') {
  const multiHint =
    forceMulti === 'on'
      ? 'ALWAYS enumerate multiple schedules if plausible.'
      : forceMulti === 'off'
      ? 'Return exactly the items you are certain of; do not search for additional schedules.'
      : 'Decide whether multiple schedules exist; if there is evidence (multiple fees, renewal tables, “co-term”, “expansion”, etc.) set model_recommendations.force_multi=true and enumerate them.';

  return `You are an expert Revenue Operations analyst for Tabs Platform's Garage.

TASK:
Given a contract PDF, enumerate EVERY billable item and map each to Garage fields for Revenue Schedules. If anything is ambiguous, return a conservative result and add an issue explaining what to check.

${multiHint}

BRAND POLICY & ANTI-HALLUCINATION RULES:
- "Luxury Presence" contracts are NEVER usage- or unit-priced. For ANY item tied to Luxury Presence, set billing_type="Flat price", quantity=1, and leave event_to_track, unit_label, price_per_unit and tiers NULL/empty. Do NOT infer them.
- DEFAULT to "Flat price" when ambiguous. Only choose "Unit price" or "Tier*" when you can QUOTE explicit per-unit/usage language from the contract (e.g., "per user", "per seat", "per lead", "per impression", "overage", "usage", or an explicit rate card like "$X per Y").
- Never populate event_to_track unless the contract explicitly defines the tracked event; otherwise keep it null.

OUTPUT:
Return ONE JSON object only (no prose) with:
{
  "schedules": [ ... ],
  "issues": ["string", "..."],
  "totals_check": { "sum_of_items": number|null, "contract_total_if_any": number|null, "matches": boolean|null, "notes": "string|null" },
  "model_recommendations": { "force_multi": boolean|null, "reasons": ["string", "..."] }
}

Rules:
- Billing type MUST be one of: "Flat price", "Unit price", "Tier flat price", "Tier unit price".
- Frequency unit MUST be one of: "None","Day(s)","Week(s)","Semi_month(s)","Month(s)","Year(s)".
- For one-time Flat price, default quantity=1 unless the contract explicitly says otherwise.
- If Unit or Tier, include event_to_track, unit_label, and price_per_unit or tiers[].
- Include page+snippet evidence for every extracted price/date line.
- If uncertain about a field, set it to null and add an issue.`;
}

/* ------------------- Parse model JSON ------------------- */
function parseModelJson(apiResponse) {
  const raw = apiResponse?.output_text ?? JSON.stringify(apiResponse || {});
  try { return JSON.parse(raw); }
  catch {
    const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
    return (a >= 0 && b > a) ? JSON.parse(raw.slice(a, b + 1)) : { schedules: [], issues: ['Could not parse model JSON'] };
  }
}

/* ------------------- Price fallbacks ------------------- */
function extractPriceFromEvidenceLikeText(texts) {
  const out = [];
  const currencyRe = /\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2})?)/g;
  for (const t of texts) {
    if (!t) continue;
    let m;
    while ((m = currencyRe.exec(String(t)))) {
      const n = Number(String(m[1]).replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
  }
  if (!out.length) return null;
  return out[out.length - 1];
}
function fallbackTotalPrice(s) {
  const unit = s?.frequency_unit;
  const recurring = unit && unit !== 'None';
  const every = Number.isFinite(Number(s?.frequency_every)) ? Number(s.frequency_every) : 1;
  const periods = inferNumberOfPeriods(s, unit, every, s?.periods);
  if (Number.isFinite(Number(s?.total_value))) {
    const tv = Number(s.total_value);
    if (recurring && periods > 0) return +(tv / periods).toFixed(2);
    return tv;
  }
  const texts = [];
  if (Array.isArray(s?.evidence)) for (const ev of s.evidence) if (ev?.snippet) texts.push(ev.snippet);
  if (s?.description) texts.push(String(s.description));
  if (s?.item_name)   texts.push(String(s.item_name));
  const p = extractPriceFromEvidenceLikeText(texts);
  return Number.isFinite(p) ? p : null;
}

/* ------------------- Normalize schedules ------------------- */
function normalizeSchedules(data) {
  const schedules = Array.isArray(data?.schedules) ? data.schedules : [];
  return schedules.map((s) => {
    const issues = Array.isArray(s.issues) ? [...s.issues] : [];

    let bt = clampEnum(normalizeBillingType(s.billing_type, s), BILLING_TYPES, 'Flat price');
    const { every, unit } = normalizeFrequency(s.frequency, s.frequency_every, s.frequency_unit, 'None');

    let qty = pickNumber(s.quantity, null);
    if (bt === 'Flat price') qty = 1;

    const out = {
      schedule_label: s.schedule_label ?? null,
      item_name: String(s.item_name || '').trim(), // TRUST the model; don't overwrite later
      description: s.description ?? null,
      billing_type: bt,
      total_price: pickNumber(s.total_price, null),
      quantity: qty,
      start_date: s.start_date || null,

      frequency_every: pickNumber(every, 1),
      frequency_unit: clampEnum(unit, FREQ_UNITS, 'None'),

      months_of_service: pickNumber(s.months_of_service, null),
      periods: pickNumber(s.periods, 1),
      calculated_end_date: s.calculated_end_date || s.end_date || null,
      net_terms: pickNumber(s.net_terms, 0),
      rev_rec_category: s.rev_rec_category ?? null,

      event_to_track: s.event_to_track ?? null,
      unit_label: s.unit_label ?? null,
      price_per_unit: pickNumber(s.price_per_unit, null),
      volume_based: typeof s.volume_based === 'boolean' ? s.volume_based : null,
      tiers: Array.isArray(s.tiers)
        ? s.tiers.map(t => ({
            tier_name: t.tier_name ?? null,
            price: pickNumber(t.price, null),
            applied_when: t.applied_when ?? null,
            min_quantity: pickNumber(t.min_quantity, null)
          }))
        : [],

      evidence: Array.isArray(s.evidence) ? s.evidence.slice(0, 8) : [],
      issues
    };

    // Policy enforcement
    if (isLuxuryPresenceHint(s)) {
      out.billing_type = 'Flat price';
      out.quantity = 1;
      out.event_to_track = null;
      out.unit_label = null;
      out.price_per_unit = null;
      out.volume_based = null;
      out.tiers = [];
      out.issues.push('Policy: Luxury Presence contracts are Flat price only; cleared unit/usage fields.');
    } else {
      if (out.billing_type === 'Unit price' && !hasStrongUnitEvidence(s)) {
        out.billing_type = 'Flat price';
        out.quantity = 1;
        out.event_to_track = null;
        out.unit_label = null;
        out.price_per_unit = null;
        out.volume_based = null;
        out.tiers = [];
        out.issues.push('Demoted Unit → Flat: missing explicit per-unit/usage evidence.');
      }
      if ((out.billing_type === 'Tier unit price' || out.billing_type === 'Tier flat price') && (!out.tiers || out.tiers.length === 0)) {
        out.billing_type = 'Flat price';
        out.quantity = 1;
        out.issues.push('Demoted Tier → Flat: no tiers found.');
      }
    }

    // Price fallback
    if (out.total_price == null) {
      const p = fallbackTotalPrice({ ...s, ...out });
      if (Number.isFinite(p)) out.total_price = p;
    }

    out.total_value = computeTotalValue(out);
    return out;
  });
}

/* ------------------- Agreement / confidence ------------------- */
function clamp01(x){ return Math.max(0, Math.min(1, Number(x)||0)); }
function tokenize(s) { if (!s) return []; return String(s).toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(x => x && x.length > 1); }
function jaccardTokens(a, b) { const A = new Set(tokenize(a)); const B = new Set(tokenize(b)); if (!A.size && !B.size) return 1; const inter = [...A].filter(x => B.has(x)).length; const union = new Set([...A, ...B]).size; return union ? inter / union : 0; }
function numericSimilarity(a, b) { if (a == null && b == null) return 1; if (a == null || b == null) return 0; const x = Number(a), y = Number(b); if (!Number.isFinite(x) || !Number.isFinite(y)) return 0; const diff = Math.abs(x - y); const denom = Math.max(1, Math.abs(x), Math.abs(y)); return clamp01(1 - diff / denom); }
function dateSimilarity(a, b) { if (!a && !b) return 1; if (!a || !b) return 0; const da = new Date(a), db = new Date(b); if (isNaN(da) || isNaN(db)) return 0; const days = Math.abs((db - da) / (1000*60*60*24)); return clamp01(Math.exp(-days/30)); }
function enumSimilarity(a, b) { return (a && b && String(a) === String(b)) ? 1 : (!a && !b ? 1 : 0); }
function tiersSimilarity(ta, tb) {
  if (!Array.isArray(ta) && !Array.isArray(tb)) return 1;
  if (!Array.isArray(ta) || !Array.isArray(tb)) return 0;
  if (ta.length === 0 && tb.length === 0) return 1;
  const len = Math.max(ta.length, tb.length); if (!len) return 1;
  let score = 0;
  for (let i=0;i<len;i++){
    const a = ta[i] || {}, b = tb[i] || {};
    const name = jaccardTokens(a.tier_name, b.tier_name);
    const price = numericSimilarity(a.price, b.price);
    const minq = numericSimilarity(a.min_quantity, b.min_quantity);
    score += (name*0.3 + price*0.5 + minq*0.2);
  }
  return clamp01(score / len);
}
function scheduleSimilarity(a, b) {
  const fields = {};
  fields.item_name = jaccardTokens(a.item_name, b.item_name);
  fields.total_price = numericSimilarity(a.total_price, b.total_price);
  fields.start_date = dateSimilarity(a.start_date, b.start_date);
  fields.frequency_unit = enumSimilarity(a.frequency_unit, b.frequency_unit);
  fields.frequency_every = numericSimilarity(a.frequency_every, b.frequency_every);
  fields.unit_label = jaccardTokens(a.unit_label, b.unit_label);
  fields.event_to_track = jaccardTokens(a.event_to_track, b.event_to_track);
  fields.tiers = tiersSimilarity(a.tiers, b.tiers);
  const w = { item_name: 0.35, total_price: 0.25, start_date: 0.10, frequency_unit: 0.10, frequency_every: 0.05, unit_label: 0.05, event_to_track: 0.05, tiers: 0.05 };
  const sim = w.item_name*fields.item_name + w.total_price*fields.total_price + w.start_date*fields.start_date + w.frequency_unit*fields.frequency_unit + w.frequency_every*fields.frequency_every + w.unit_label*fields.unit_label + w.event_to_track*fields.event_to_track + w.tiers*fields.tiers;
  return { sim: clamp01(sim), fields };
}
function keyCompletenessPenalty(s) {
  const keys = ['item_name','total_price','start_date','frequency_unit','periods'];
  const missing = keys.reduce((acc, k) => acc + (s[k]==null || s[k]==='' ? 1 : 0), 0);
  return clamp01(1 - (missing / keys.length) * 0.5);
}
function computeAgreement(first, second) {
  const n = second.length;
  const used = new Set();
  const enriched = first.map((a) => {
    let best = { j: -1, sim: 0, fields: {} };
    for (let j = 0; j < n; j++) {
      if (used.has(j)) continue;
      const score = scheduleSimilarity(a, second[j]);
      if (score.sim > best.sim) best = { j, ...score };
    }
    if (best.j >= 0) used.add(best.j);
    const missingPenalty = keyCompletenessPenalty(a);
    const confidence = clamp01(0.2 + 0.8 * best.sim * missingPenalty);
    const flag_for_review = confidence < 0.75 || best.sim < 0.70;
    return { confidence, flag_for_review, agreement: { matched_index_in_run2: best.j, similarity: best.sim, fields: best.fields } };
  });
  const avg = enriched.length ? (enriched.reduce((s, e) => s + e.confidence, 0) / enriched.length) : null;
  const min = enriched.length ? enriched.reduce((m, e) => Math.min(m, e.confidence), 1) : null;
  return { enriched, summary: { avg_confidence: avg, min_confidence: min, total_items_run1: first.length, total_items_run2: second.length, unmatched_in_run2: Math.max(0, first.length - used.size) } };
}

/* ------------------- Date helpers for month math ------------------- */
function monthsFromDates(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (isNaN(start) || isNaN(end)) return null;
  const ms = end - start;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24 * 30))); // ~30-day months
}

/* ------------------- Period logic (now driven by months) ------------------- */
function periodsFromMonths(unit, every, months) {
  if (!unit || unit === 'None') return 0;
  const m = Number(months);
  const e = Number(every) || 1;
  if (!Number.isFinite(m) || m <= 0) return 1;
  if (unit === 'Month(s)')      return Math.max(1, Math.round(m / e));
  if (unit === 'Year(s)')       return Math.max(1, Math.round(m / (12 * e)));
  if (unit === 'Week(s)')       return Math.max(1, Math.round((m * 30) / (7 * e)));
  if (unit === 'Day(s)')        return Math.max(1, Math.round((m * 30) / (1 * e)));
  if (unit === 'Semi_month(s)') return Math.max(1, Math.round((m * 30) / (15 * e)));
  return 1;
}

/* ------------------- Garage JSON builders ------------------- */
function toGarageBillingType(bt) {
  const map = { 'Flat price': 'FLAT_PRICE', 'Unit price': 'UNIT_PRICE', 'Tier flat price': 'TIER_FLAT_PRICE', 'Tier unit price': 'TIER_UNIT_PRICE' };
  return map[bt] || 'FLAT_PRICE';
}
function toGarageFrequencyWithMonths(s, months) {
  const every = Number.isFinite(Number(s?.frequency_every)) ? Number(s.frequency_every) : 1;
  const unit = s?.frequency_unit;

  const number_of_periods = periodsFromMonths(unit, every, months);
  if (!unit || unit === 'None') {
    return { frequency_unit: 'NONE', period: 1, number_of_periods: 0 };
  }
  if (unit === 'Month(s)') {
    if (every === 3) return { frequency_unit: 'QUARTER', period: 1, number_of_periods };
    return { frequency_unit: 'MONTH', period: every, number_of_periods };
  }
  if (unit === 'Year(s)')       return { frequency_unit: 'YEAR', period: every, number_of_periods };
  if (unit === 'Day(s)')        return { frequency_unit: 'DAYS', period: every, number_of_periods };
  if (unit === 'Semi_month(s)') return { frequency_unit: 'SEMI_MONTH', period: every, number_of_periods };
  if (unit === 'Week(s)')       return { frequency_unit: 'DAYS', period: every*7, number_of_periods };
  return { frequency_unit: 'NONE', period: 1, number_of_periods: 0 };
}
function polishOneTimeNameAndDescription(s, g) {
  const text = [s?.schedule_label, s?.item_name, s?.description, s?.rev_rec_category].filter(Boolean).join(' ').toLowerCase();
  const isOneTime = g.frequency_unit === 'NONE' || /one[-\s]?time|setup|implementation|professional services/.test(text);
  if (isOneTime) {
    if (!g.item_name) g.item_name = 'Implementation & One-Time Services';
    if (!g.item_description) g.item_description = 'Total one-time fees listed on order form';
  }
}
function deriveMonthsOfService(s) {
  const byDates = monthsFromDates(s?.start_date, s?.calculated_end_date || s?.end_date);
  if (Number.isFinite(byDates) && byDates > 0) return byDates;
  const mosRaw = s?.months_of_service;
  if (mosRaw !== null && mosRaw !== undefined) {
    const mosNum = Number(mosRaw);
    if (Number.isFinite(mosNum) && mosNum > 0) return mosNum;
  }
  const every = Number.isFinite(Number(s?.frequency_every)) ? Number(s.frequency_every) : 1;
  const unit = s?.frequency_unit;
  const p = Number(s?.periods);
  if (Number.isFinite(p) && p > 0) {
    if (unit === 'Month(s)')      return every * p;
    if (unit === 'Year(s)')       return 12 * every * p;
    if (unit === 'Week(s)')       return Math.round((7 * every * p) / 30);
    if (unit === 'Day(s)')        return Math.round((every * p) / 30);
    if (unit === 'Semi_month(s)') return Math.round((15 * every * p) / 30);
  }
  if (!unit || unit === 'None') return 0;
  return 0; // unknown → 0 (we'll still set periods via default rules)
}
function toGarageRevenueStrict(s) {
  // 1) derive months first
  const service_term = deriveMonthsOfService(s) || 0;

  // 2) compute frequency (period/number_of_periods) from those months
  const freq = toGarageFrequencyWithMonths(s, service_term);

  // 3) build core
  const billing_type = toGarageBillingType(s?.billing_type);
  const qty = billing_type === 'FLAT_PRICE' ? 1 : (Number.isFinite(Number(s?.quantity)) ? Number(s.quantity) : 1);
  const integration_item = mapIntegrationItem(s?.item_name) ?? s?.integration_item ?? null;

  const g = {
    service_start_date: s.start_date || '',
    service_term,
    revenue_category: null,
    item_name: s.item_name || '',           // trust the model’s extracted name
    item_description: s.description || null,
    start_date: s.start_date || '',
    frequency_unit: freq.frequency_unit,
    period: freq.period,
    number_of_periods: freq.number_of_periods,
    arrears: false,
    billing_type,
    event_to_track: s.event_to_track ?? null,
    integration_item,
    discounts: [],
    net_terms: Number.isFinite(Number(s?.net_terms)) ? Number(s.net_terms) : 0,
    quantity: qty,
    total_price: Number.isFinite(Number(s?.total_price)) ? Number(s.total_price) : 0,
    pricing_tiers: (Array.isArray(s?.tiers) && s.tiers.length)
      ? s.tiers.map((t, i) => ({
          tier: i+1,
          mantissa: t?.price != null ? String(t.price) : null,
          exponent: '0',
          condition_value: Number.isFinite(Number(t?.min_quantity)) ? Number(t.min_quantity) : null,
          condition_operator: t?.min_quantity != null ? 'GREATER_THAN_EQUAL' : null,
          name: t?.tier_name || t?.applied_when || null
        }))
      : []
  };

  // 4) only polish one-time if the name was missing
  polishOneTimeNameAndDescription(s, g);
  return g;
}
function toGarageAllStrict(schedules) {
  return (schedules || []).map(toGarageRevenueStrict);
}

/* ------------------- /api/extract ------------------- */
app.post('/api/extract', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { model = 'o3', forceMulti = 'auto', runs = '2', format } = req.query;
    const chosenModel = ['o3','o4-mini','gpt-4o-mini','o3-mini'].includes(model) ? model : 'o3';
    const agreementRuns = Math.max(1, Math.min(5, Number(runs) || 1));

    const uploaded = await client.files.create({
      file: await toFile(fs.createReadStream(req.file.path), req.file.originalname || 'contract.pdf'),
      purpose: 'assistants'
    });

    const response1 = await client.responses.create({
      model: chosenModel,
      input: [
        { role: 'system', content: buildSystemPrompt(forceMulti) },
        { role: 'user',   content: [
            { type: 'input_text', text: 'Extract Garage-ready revenue schedules as a single JSON object.' },
            { type: 'input_file', file_id: uploaded.id }
        ] }
      ],
      text: { format: { type: 'json_object' } }
    });
    const data1 = parseModelJson(response1);
    const norm1 = normalizeSchedules(data1);

    let agreement = null;
    if (agreementRuns >= 2) {
      const response2 = await client.responses.create({
        model: chosenModel,
        input: [
          { role: 'system', content: buildSystemPrompt(forceMulti) },
          { role: 'user',   content: [
              { type: 'input_text', text: 'Extract Garage-ready revenue schedules as a single JSON object.' },
              { type: 'input_file', file_id: uploaded.id }
          ] }
        ],
        text: { format: { type: 'json_object' } }
      });
      const data2 = parseModelJson(response2);
      const norm2 = normalizeSchedules(data2);
      const agr = computeAgreement(norm1, norm2);
      agr.enriched.forEach((extra, idx) => Object.assign(norm1[idx], extra));
      agreement = agr.summary;
    }

    const garage = toGarageAllStrict(norm1);

    if (String(format).toLowerCase() === 'garage-only') {
      return res.json({ revenue_schedule: garage });
    }

    res.json({
      model_used: chosenModel,
      runs: agreementRuns,
      schedules: norm1,
      garage_revenue_schedules: garage,
      model_recommendations: data1.model_recommendations ?? null,
      issues: Array.isArray(data1.issues) ? data1.issues : [],
      totals_check: data1.totals_check ?? null,
      agreement_summary: agreement ?? null
    });
  } catch (err) {
    res.status(500).json({ error: 'Extraction failed', debug: { message: err?.message } });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

/* ------------------- /api/use-contract-assistant ------------------- */
app.get('/api/use-contract-assistant', async (req, res) => {
  const { contractID, model = 'o3', forceMulti = 'auto', format } = req.query;
  if (!contractID) return res.status(400).json({ error: 'Missing contractID' });

  try {
    const pdfResp = await fetch(`https://integrators.prod.api.tabsplatform.com/v3/contracts/${contractID}/file`, {
      headers: { 'accept': 'application/pdf', 'Authorization': `${process.env.LUXURY_PRESENCE_TABS_SANDBOX_API_KEY}` }
    });
    if (!pdfResp.ok) throw new Error(`Failed to fetch PDF for contract ${contractID}: ${pdfResp.status}`);

    const tempPath = `/tmp/${contractID}.pdf`;
    const buf = Buffer.from(await pdfResp.arrayBuffer());
    await fs.promises.writeFile(tempPath, buf);

    const uploaded = await client.files.create({
      file: await toFile(fs.createReadStream(tempPath), `${contractID}.pdf`),
      purpose: 'assistants'
    });

    const response = await client.responses.create({
      model,
      input: [
        { role: 'system', content: buildSystemPrompt(forceMulti) },
        { role: 'user', content: [
            { type: 'input_text', text: 'Extract Garage-ready revenue schedules as a single JSON object.' },
            { type: 'input_file', file_id: uploaded.id }
        ] }
      ],
      text: { format: { type: 'json_object' } }
    });

    const data = parseModelJson(response);
    const normalized = normalizeSchedules(data);
    const garage = toGarageAllStrict(normalized);

    if (String(format || '').toLowerCase() !== 'full') {
      fs.unlink(tempPath, () => {});
      return res.json({ revenue_schedule: garage });
    }

    res.json({
      model_used: model,
      schedules: normalized,
      garage_revenue_schedules: garage,
      model_recommendations: data.model_recommendations ?? null,
      issues: Array.isArray(data.issues) ? data.issues : [],
      totals_check: data.totals_check ?? null
    });

    fs.unlink(tempPath, () => {});
  } catch (err) {
    console.error('use-contract-assistant error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------- Health ------------------- */
app.get('/health', async (_req, res) => {
  try {
    const models = await client.models.list();
    res.json({ ok: true, models: models.data.slice(0, 3).map(m => m.id) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Garage assistant running on http://localhost:${PORT}`));
}
export default app;
