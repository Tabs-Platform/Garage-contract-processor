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
  ['Ad Spend ($500)', 'Ad Spend ($500)'],
  ['Ad Spend ($1,000)', 'Ad Spend ($1,000)'],
  ['Ad Spend Add On', 'Ad Spend Add On'],
  ['Presence Platform User Seat', 'Presence Platform User Seat'],
  ['Additional Website Page', 'Additional Website Page'],
  ['Agent Bio', 'Agent Bio'],
  ['Agent Landing Pages', 'Agent Landing Pages'],
  ['Agent Subdomains', 'Agent Subdomains'],
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
  ['Branded Mobile App User Seat', 'Branded Mobile App User Seat'],
  ['Branded Mobile App Activation', 'Branded Mobile App Activation'],
  ['Luxury Presence Mobile App User Seat', 'Luxury Presence Mobile App User Seat'],
  ['Branded Mobile App Subscription', 'Branded Mobile App Subscription'],
  ['Design Change (Pro)', 'Design Change (Pro)'],
  ['Design Change (Custom)', 'Design Change (Custom)'],
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
  ['Press Migration', 'Press Migration'],
  ['Neighborhood Migration', 'Neighborhood Migration'],
  ['Development Migration', 'Development Migration'],
  ['Testimonial Migration', 'Testimonial Migration'],
  ['Neighborhood Copy', 'Neighborhood Copy'],
  ['Neighborhood Guide', 'Neighborhood Guide'],
  ['One-Click Property Websites', 'One-Click Property Websites'],
  ['One-Time Setup Fee (All In Premier Custom)', 'One-Time Setup Fee (All In Premier Custom)'],
  ['One-Time Setup Fee (All In Premier)', 'One-Time Setup Fee (All In Premier)'],
  ['One-Time Setup Fee (Brand+ & Custom)', 'One-Time Setup Fee (Brand+ & Custom)'],
  ['One-Time Setup Fee (Brand+ & Pro)', 'One-Time Setup Fee (Brand+ & Pro)'],
  ['One-Time Setup Fee (Launch+ & Custom)', 'One-Time Setup Fee (Launch+ & Custom)'],
  ['One-Time Setup Fee (Launch+ & Pro)', 'One-Time Setup Fee (Launch+ & Pro)'],
  ['One-Time Setup Fee (Leads Premier Custom)', 'One-Time Setup Fee (Leads Premier Custom)'],
  ['One-Time Setup Fee (Leads Premier)', 'One-Time Setup Fee (Leads Premier)'],
  ['One-Time Setup Fee (Leads Pro & Custom)', 'One-Time Setup Fee (Leads Pro & Custom)'],
  ['One-Time Setup Fee (Leads Pro & Pro)', 'One-Time Setup Fee (Leads Pro & Pro)'],
  ['One-Time Setup Fee (Presence Premier Custom)', 'One-Time Setup Fee (Presence Premier Custom)'],
  ['One-Time Setup Fee (Presence Premier)', 'One-Time Setup Fee (Presence Premier)'],
  ['One-Time Setup Fee (SEO Premier Custom)', 'One-Time Setup Fee (SEO Premier Custom)'],
  ['One-Time Setup Fee (SEO Premier)', 'One-Time Setup Fee (SEO Premier)'],
  ['One-Time Setup Fee (SEO Pro & Custom)', 'One-Time Setup Fee (SEO Pro & Custom)'],
  ['One-Time Setup Fee (SEO Pro & Pro)', 'One-Time Setup Fee (SEO Pro & Pro)'],
  ['Opening Video', 'Opening Video'],
  ['Pages of Copywriting', 'Pages of Copywriting'],
  ['Premium Support', 'Premium Support'],
  ['Premium+', 'Premium+'],
  ['Presence Premier', 'Presence Premier'],
  ['Property Migration', 'Property Migration'],
  ['Remove LP Link in Footer', 'Remove LP Link in Footer'],
  ['Self-Serve Property Website (Monthly)', 'Self-Serve Property Website (Monthly)'],
  ['One-Time Setup Fee (Self-Serve Property Website)', 'One-Time Setup Fee (Self-Serve Property Website)'],
  ['SEO Blog Post', 'SEO Blog Post'],
  ['SEO Migration', 'SEO Migration'],
  ['SEO Premier', 'SEO Premier'],
  ['SEO Pro', 'SEO Pro'],
  ['Social Media', 'Social Media'],
  ['Template Change', 'Template Change'],
  ['Video Editing', 'Video Editing'],
  ['12 Blogs per Quarter', '12 Blogs per Quarter'],
  ['6 Blogs per Quarter', '6 Blogs per Quarter'],
  ['Performance SEO Add On', 'Performance SEO Add On'],
  ['Premium User Seat', 'Premium User Seat']
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

/* ---------- Fuzzy matching helpers (robust but conservative) ---------- */
// Stopwords that don't help identify the product
const INTEGRATION_STOPWORDS = new Set([
  'subscription','plan','program','package','activation','setup','set','up',
  'one','time','fee','fees','user','seat','additional','addon','add','on',
  'add on','add-on','tool','service','services'
]);
// "Flavor" tokens that shouldn't be the only overlap
const INTEGRATION_FLAVOR = new Set([
  'pro','premier','premium','plus','base','enterprise','custom','standard','basic','advanced'
]);
function canonTokens(canonStr) {
  return String(canonStr || '')
    .split(' ')
    .map(t => t.trim())
    .filter(t => t && t.length > 1 && !INTEGRATION_STOPWORDS.has(t));
}
/* Precompute canonical keys *and* token sets for scoring */
const CANON_INDEX = Array.from(INTEGRATION_BY_ITEM.entries()).map(([k, v]) => {
  const can = canonicalizeName(k);
  return { rawKey: k, canonKey: can, tokens: canonTokens(can), val: v };
});

function mapIntegrationItem(itemName) {
  if (!itemName) return null;
  const raw = String(itemName).trim();

  // 1) Exact match (case-insensitive)
  const exact = INTEGRATION_BY_ITEM.get(raw.toLowerCase());
  if (exact) return exact;

  // 2) Canonical equality
  const canonQ = canonicalizeName(raw);
  const eq = CANON_INDEX.find(e => e.canonKey === canonQ);
  if (eq) return eq.val;

  // 3) Fuzzy tokens fallback
  const qTokens = canonTokens(canonQ);
  if (!qTokens.length) return null;
  const setQ = new Set(qTokens);

  let best = { val: null, score: 0 };

  for (const e of CANON_INDEX) {
    if (!e.tokens || !e.tokens.length) continue;
    const setK = new Set(e.tokens);

    const inter = [...setQ].filter(t => setK.has(t));
    if (inter.length === 0) continue;

    // Reject matches where the only overlap is flavor (unless 2+ tokens overlap)
    const hasNonFlavorOverlap = inter.some(t => !INTEGRATION_FLAVOR.has(t));
    if (inter.length < 2 && !hasNonFlavorOverlap) continue;

    // Weighted score: Jaccard + coverage + small bonus for non-flavor overlap
    const unionSize = new Set([...setQ, ...setK]).size;
    const jacc = inter.length / unionSize;
    const covQ = inter.length / setQ.size;
    const covK = inter.length / setK.size;
    const score = jacc + 0.25 * covQ + 0.15 * covK + (hasNonFlavorOverlap ? 0.10 : 0);

    if (score > best.score) best = { val: e.val, score };
  }
  return best.score >= 0.55 ? best.val : null; // threshold
}

/* ------------------- Helpers: numbers, enums, etc. ------------------- */
function toNumberLoose(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    // first numeric group (handles "$1,200.00", "USD 3000", etc.)
    const m = v.match(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function clampEnum(value, allowed, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  const byLower = new Map(allowed.map(v => [v.toLowerCase(), v]));
  return byLower.get(value.toLowerCase()) || fallback;
}
function pickNumber(n, fallback = null) {
  const x = toNumberLoose(n);
  return x == null ? fallback : x;
}
function positive(n){ return Number.isFinite(n) && n > 0 ? n : null; }

/* ------------------- Brand / heuristics ------------------- */
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
  const hasPPU = Number.isFinite(pickNumber(s?.price_per_unit));
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
  // Cast to string to avoid `.toLowerCase` on non-strings
  const txt = String(rawText ?? '').toLowerCase();
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

/* ------------------- Evidence & price extraction ------------------- */
function extractPriceFromEvidenceLikeText(texts, ctx = {}) {
  const candidates = [];
  const re = /(?:\$|US\$|USD)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.\d{2})|[0-9]+(?:\.\d{2})?)/gi;
  for (const raw of texts) {
    if (!raw) continue;
    const s = String(raw);
    let m;
    while ((m = re.exec(s))) {
      const val = Number(m[1].replace(/,/g, ''));
      if (!Number.isFinite(val) || val <= 0) continue;
      const start = m.index, end = re.lastIndex;
      const W = 48;
      const left  = s.slice(Math.max(0, start - W), start).toLowerCase();
      const right = s.slice(end, Math.min(s.length, end + W)).toLowerCase();
      const ring  = left + ' ' + right;

      let score = 0;
      if (/\b(monthly|per\s*month|per\s*mo\.?)\b/.test(ring)) score += (ctx.frequency_unit === 'Month(s)') ? 3 : -1;
      if (/\b(annual|yearly|per\s*year)\b/.test(ring))       score += (ctx.frequency_unit === 'Year(s)')  ? 3 : -1;
      if (/\b(one[-\s]?time|setup|implementation)\b/.test(ring)) score += (ctx.frequency_unit === 'None') ? 3 : -1;
      if (/\b(line\s*total|total\s*(?:per|for)?\b)/.test(ring)) score += 2;
      if (/\b(discount|credit|rebate|tax|deposit|retainer|balance\s*due)\b/.test(ring)) score -= 4;
      if (/\b(each|per\s*(seat|user|lead|click|impression|unit|gb|api|sms|email))\b/.test(ring)) {
        if (ctx.billing_type !== 'Unit price' && ctx.billing_type !== 'Tier unit price') score -= 2;
      }
      score += candidates.length * 0.05;
      candidates.push({ value: val, score });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].value;
}

// Explicit-zero detection
const ZERO_TERMS_RE = /\b(?:no\s*charge|free|complimentary|waived|included\s+at\s+no\s+extra\s+cost|n\/c|zero)\b/i;
const ZERO_CURRENCY_RE = /(?:\$|US\$|USD)\s*0(?:\.00)?\b/i;

const PRICE_FIELDS_PRIMARY = ['total_price','price','amount','per_period_price','per_period','annual_price','monthly_price'];
const PRICE_FIELDS_SECONDARY = ['setup_fee','one_time_fee','upfront','down_payment','line_total','subtotal'];

function explicitZeroSignal(obj){
  for (const f of [...PRICE_FIELDS_PRIMARY, ...PRICE_FIELDS_SECONDARY]) {
    const v = toNumberLoose(obj?.[f]);
    if (v === 0) return `field:${f}`;
  }
  const texts = [];
  if (Array.isArray(obj?.evidence)) for (const ev of obj.evidence) if (ev?.snippet) texts.push(ev.snippet);
  if (obj?.description) texts.push(String(obj.description));
  if (obj?.item_name)   texts.push(String(obj.item_name));
  const hay = texts.join(' ');
  if (ZERO_CURRENCY_RE.test(hay)) return 'currency_text';
  if (ZERO_TERMS_RE.test(hay))    return 'keyword_text';
  if (/\b100%\s*(?:discount|off)\b/i.test(hay)) return 'discount_100';
  return null;
}

function priceFromFields(obj) {
  for (const f of PRICE_FIELDS_PRIMARY) {
    const v = positive(pickNumber(obj?.[f], null));
    if (v != null) return v;
  }
  for (const f of PRICE_FIELDS_SECONDARY) {
    const v = positive(pickNumber(obj?.[f], null));
    if (v != null) return v;
  }
  return null;
}
function priceFromEvidence(obj) {
  const texts = [];
  if (Array.isArray(obj?.evidence)) for (const ev of obj.evidence) if (ev?.snippet) texts.push(ev.snippet);
  if (obj?.description) texts.push(String(obj.description));
  if (obj?.item_name)   texts.push(String(obj.item_name));
  const ctx = {
    frequency_unit: clampEnum(obj?.frequency_unit, FREQ_UNITS, null),
    billing_type: normalizeBillingType(obj?.billing_type, obj)
  };
  return positive(extractPriceFromEvidenceLikeText(texts, ctx));
}
function bestPrice(obj, { allowExplicitZero = true } = {}) {
  const pos = priceFromFields(obj) ?? priceFromEvidence(obj);
  if (pos != null) return pos;
  if (allowExplicitZero) {
    const zr = explicitZeroSignal(obj);
    if (zr) return 0;
  }
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

/* ------------------- Dates → months helpers (for frequency only) ------------------- */
function monthsFromDates(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (isNaN(start) || isNaN(end)) return null;
  const ms = end - start;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24 * 30))); // ~30-day months
}
function periodsFromMonths(unit, every, months) {
  if (!unit || unit === 'None') return 0;
  const m = Number(months);
  const e = Number(every) || 1;
  if (!Number.isFinite(m) || m <= 0) return 1;
  if (unit === 'Month(s)')      return Math.max(1, Math.round(m / e));
  if (unit === 'Year(s)')       return Math.max(1, Math.round(m / (12 * e)));
  if (unit === 'Week(s)')       return Math.max(1, Math.round((m * 30) / (7 * e)));
  if (unit === 'Day(s)')        return Math.max(1, Math.round((every * m * 30) / (30 * e)));
  if (unit === 'Semi_month(s)') return Math.max(1, Math.round((m * 30) / (15 * e)));
  return 1;
}

/* ------------------- Normalize schedules (NO total_value) ------------------- */
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
      item_name: String(s.item_name || '').trim(),
      description: s.description ?? null,
      billing_type: bt,
      total_price: null, // computed below
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

    // Brand/policy enforcement
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

    // PRICE: positive fields → positive evidence → explicit zero
    const chosen = bestPrice(s) ?? bestPrice(out);
    if (chosen != null) {
      out.total_price = chosen;
      if (chosen === 0) out.issues.push('Explicit zero price accepted (waived/free/included).');
    } else {
      out.total_price = null;
      out.issues.push('Price missing after all fallbacks; verify contract line.');
    }

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

/* ------------------- Garage JSON builders ------------------- */
function toGarageBillingType(bt) {
  const map = { 'Flat price': 'FLAT_PRICE', 'Unit price': 'UNIT_PRICE', 'Tier flat price': 'TIER_FLAT_PRICE', 'Tier unit price': 'TIER_UNIT_PRICE' };
  return map[bt] || 'FLAT_PRICE';
}
function toGarageFrequencyWithMonths(s, months) {
  // Hard business rule: monthly → exactly 12 periods, period size = 1 month
  if (s?.frequency_unit === 'Month(s)') {
    return { frequency_unit: 'MONTH', period: 1, number_of_periods: 12 };
  }
  const every = pickNumber(s?.frequency_every, 1);
  const unit = s?.frequency_unit;
  const number_of_periods = periodsFromMonths(unit, every, months);
  if (!unit || unit === 'None') {
    return { frequency_unit: 'NONE', period: 1, number_of_periods: 1 };
  }
  if (unit === 'Month(s)') {
    if (every === 3) return { frequency_unit: 'QUARTER', period: 1, number_of_periods };
    return { frequency_unit: 'MONTH', period: every, number_of_periods };
  }
  if (unit === 'Year(s)')       return { frequency_unit: 'YEAR', period: every, number_of_periods };
  if (unit === 'Day(s)')        return { frequency_unit: 'DAYS', period: every, number_of_periods };
  if (unit === 'Semi_month(s)') return { frequency_unit: 'SEMI_MONTH', period: every, number_of_periods };
  if (unit === 'Week(s)')       return { frequency_unit: 'DAYS', period: every*7, number_of_periods };
  return { frequency_unit: 'NONE', period: 1, number_of_periods: 1 };
}
function polishOneTimeNameAndDescription(s, g) {
  const text = [s?.schedule_label, s?.item_name, s?.description, s?.rev_rec_category].filter(Boolean).join(' ').toLowerCase();
  const isOneTime = g.frequency_unit === 'NONE' || /one[-\s]?time|setup|implementation|professional services/.test(text);
  if (isOneTime) {
    if (!g.item_name) g.item_name = 'Implementation & One-Time Services';
    if (!g.item_description) g.item_description = 'Total one-time fees listed on order form';
  }
}
function monthsFromFrequencyOrDefault(s) {
  const every = pickNumber(s?.frequency_every, 1);
  const unit = s?.frequency_unit;
  const p = pickNumber(s?.periods, null);
  if (p != null && p > 0) {
    if (unit === 'Month(s)')      return every * p;
    if (unit === 'Year(s)')       return 12 * every * p;
    if (unit === 'Week(s)')       return Math.round((7 * every * p) / 30);
    if (unit === 'Day(s)')        return Math.round((every * p) / 30);
    if (unit === 'Semi_month(s)') return Math.round((15 * every * p) / 30);
  }
  if (!unit || unit === 'None') return 1; // default 1 month for one-time
  return 0;
}
function deriveMonthsOfService(s) {
  const byDates = monthsFromDates(s?.start_date, s?.calculated_end_date || s?.end_date);
  if (Number.isFinite(byDates) && byDates > 0) return byDates;
  const mosRaw = s?.months_of_service;
  if (mosRaw !== null && mosRaw !== undefined) {
    const mosNum = pickNumber(mosRaw, null);
    if (mosNum != null && mosNum > 0) return mosNum;
  }
  return monthsFromFrequencyOrDefault(s);
}
function toGarageRevenueStrict(s) {
  // 1) derive months first (for frequency only)
  let service_term = deriveMonthsOfService(s) || 0;
  if (s?.frequency_unit === 'Month(s)') service_term = 12;

  // 2) compute frequency fields
  const freq = toGarageFrequencyWithMonths(s, service_term);

  // 3) core fields
  const billing_type = toGarageBillingType(s?.billing_type);
  const qty = billing_type === 'FLAT_PRICE' ? 1 : pickNumber(s?.quantity, 1);
  const integration_item = mapIntegrationItem(s?.item_name) ?? s?.integration_item ?? null;

  // 4) PRICE (no total_value fallback)
  let finalPrice = positive(pickNumber(s?.total_price, null));
  if (finalPrice == null) {
    const tp = pickNumber(s?.total_price, null);
    if (tp === 0 && explicitZeroSignal(s)) {
      finalPrice = 0;
    } else {
      finalPrice = bestPrice(s); // may return positive number or 0 (if explicit zero)
    }
  }
  if (finalPrice == null) finalPrice = 0; // last resort

  const g = {
    service_start_date: s.start_date || '',
    service_term,
    revenue_category: null,
    item_name: s.item_name || '',
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
    net_terms: pickNumber(s?.net_terms, 0),
    quantity: qty,
    total_price: finalPrice,
    pricing_tiers: (Array.isArray(s?.tiers) && s.tiers.length)
      ? s.tiers.map((t, i) => ({
          tier: i+1,
          mantissa: t?.price != null ? String(pickNumber(t.price, 0)) : null,
          exponent: '0',
          condition_value: pickNumber(t?.min_quantity, null),
          condition_operator: t?.min_quantity != null ? 'GREATER_THAN_EQUAL' : null,
          name: t?.tier_name || t?.applied_when || null
        }))
      : []
  };

  // 5) one-time polish
  polishOneTimeNameAndDescription(s, g);
  return g;
}
function toGarageAllStrict(schedules) {
  return (schedules || []).map(toGarageRevenueStrict);
}

/* ------------------- QUALITY RERUN MONKEY-PATCH (max once; your conditions) ------------------- */
const __origResponsesCreate = client.responses.create.bind(client.responses);
client.responses.create = async function(args) {
  // First run
  const resp1 = await __origResponsesCreate(args);
  let data1;
  try { data1 = parseModelJson(resp1); } catch { return resp1; }
  const norm1 = normalizeSchedules(data1);

  // Rerun only if:
  // (A) any item_name missing/blank
  // (B) any start_date missing/blank
  // (C) all total_price === 0
  const hasMissingName  = Array.isArray(norm1) && norm1.some(s => !s?.item_name || !String(s.item_name).trim());
  const hasMissingStart = Array.isArray(norm1) && norm1.some(s => !s?.start_date || !String(s.start_date).trim());
  const allTotalsZero   = Array.isArray(norm1) && norm1.length > 0 && norm1.every(s => Number(s?.total_price) === 0);

  const shouldRerun = hasMissingName || hasMissingStart || allTotalsZero;
  if (!shouldRerun) return resp1;

  // One additional run with a focused hint
  const patched = { ...args };
  if (Array.isArray(patched.input)) {
    const idx = patched.input.findIndex(m => m && m.role === 'system');
    const hint = '\n\nRETRY FOCUS: Ensure every schedule has a non-empty item_name, a populated start_date, and a non-zero total_price (unless explicitly free/waived). Prefer amounts matching schedule frequency or a clearly labeled line total.';
    if (idx >= 0) {
      patched.input[idx] = { ...patched.input[idx], content: String(patched.input[idx].content || '') + hint };
    } else {
      patched.input.unshift({ role: 'system', content: hint });
    }
  }
  const resp2 = await __origResponsesCreate(patched);
  return resp2;
};

/* ------------------- PDF Processing Helper Function ------------------- */
/**
 * Extracts revenue schedules from a PDF contract using AI
 * @param {string} filePath - Path to the PDF file
 * @param {string} fileName - Name of the file (for OpenAI)
 * @param {Object} options - Processing options
 * @param {string} options.model - AI model ('o3', 'o4-mini', 'gpt-4o-mini', 'o3-mini')
 * @param {string} options.forceMulti - Multi-schedule detection ('auto', 'on', 'off')
 * @param {number} options.runs - Number of agreement runs (1-5)
 * @param {string} options.format - Output format ('garage' or 'full')
 * @returns {Object} Extracted revenue schedules in requested format
 */
export async function extractPdfSchedules(filePath, fileName, options = {}) {
  const {
    model = 'o3',
    forceMulti = 'auto',
    runs = 1,
    format = 'garage'
  } = options;

  const chosenModel = ['o3','o4-mini','gpt-4o-mini','o3-mini'].includes(model) ? model : 'o3';
  const agreementRuns = Math.max(1, Math.min(5, Number(runs) || 1));

  // Upload file to OpenAI
  const uploaded = await client.files.create({
    file: await toFile(fs.createReadStream(filePath), fileName || 'contract.pdf'),
    purpose: 'assistants'
  });

  // First extraction run
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

  // Agreement checking (if multiple runs requested)
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

  // Return format based on requested format
  if (String(format || '').toLowerCase() === 'garage') {
    return { revenue_schedule: garage };
  }

  return {
    model_used: chosenModel,
    runs: agreementRuns,
    schedules: norm1,
    garage_revenue_schedules: garage,
    model_recommendations: data1.model_recommendations ?? null,
    issues: Array.isArray(data1.issues) ? data1.issues : [],
    totals_check: data1.totals_check ?? null,
    agreement_summary: agreement ?? null
  };
}

/* ------------------- /api/extract ------------------- */
app.post('/api/extract', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { model = 'o3', forceMulti = 'auto', runs = '1', format } = req.query;
    
    const result = await extractPdfSchedules(req.file.path, req.file.originalname, {
      model,
      forceMulti,
      runs,
      format
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Extraction failed', debug: { message: err?.message } });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

/* ------------------- /api/use-contract-assistant (UNCHANGED) ------------------- */
app.get('/api/use-contract-assistant', async (req, res) => {
  const { contractID, model = 'o3', forceMulti = 'auto', format, env = 'dev' } = req.query;
  //const entryKey = req.headers['entrykey'] || req.headers['entryKey'];
  //if (!entryKey || entryKey !== process.env.USE_CONTRACT_PROCESSING_KEY) return res.status(401).json({ error: 'Invalid or missing entryKey' });
  if (!contractID) return res.status(400).json({ error: 'Missing contractID' });

  // Determine API endpoint and key based on env parameter
  const isProd = String(env || '').toLowerCase() === 'prod';
  const apiEndpoint = isProd ? 'https://integrators.prod.api.tabsplatform.com' : 'https://integrators.dev.api.tabsplatform.com';
  const apiKey = isProd ? process.env.USE_CONTRACT_PROCESSING_KEY : process.env.USE_CONTRACT_PROCESSING_KEY;
  console.log('apiEndpoint', apiEndpoint);
  console.log('apiKey', apiKey);
  let pdfResp;
  try {
    pdfResp = await fetch(`${apiEndpoint}/v3/contracts/${contractID}/file`, {
      headers: { 'accept': 'application/pdf', 'Authorization': `${apiKey}` }
    });
    if (!pdfResp.ok) throw new Error(`Failed to fetch PDF for contract ${contractID}: ${pdfResp.status}`);
  } catch (err) {
    console.error('PDF fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch PDF: ' + err.message });
  }
  
  // Convert response to buffer once, outside the retry loop
  const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
  
  const maxRetries = 3;
  const retryDelay = 5000; // 5 seconds
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const tempPath = `/tmp/${contractID}.pdf`;
      await fs.promises.writeFile(tempPath, pdfBuffer);

      const result = await extractPdfSchedules(tempPath, `${contractID}.pdf`, {
        model,
        forceMulti,
        runs: 1, // Single run for this endpoint
        format
      });

      fs.unlink(tempPath, () => {});
      console.log('result', result);
      res.json(result);
      return; // Success, exit the retry loop
    } catch (err) {
      lastError = err;
      console.error(`use-contract-assistant error (attempt ${attempt}/${maxRetries}):`, err);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  // All retries failed
  console.error('use-contract-assistant failed after all retries:', lastError);
  res.status(500).json({ error: lastError.message });
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

export default app;
if (!process.env.VERCEL) {
  const bindHost = process.env.HOST || '0.0.0.0';
  app.listen(PORT, bindHost, () => {
    console.log(`Garage assistant running on http://${bindHost}:${PORT}`);
  });
}