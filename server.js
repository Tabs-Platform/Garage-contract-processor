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
// /tmp is the only writable dir on Vercel; use it in prod
const uploadDir = process.env.NODE_ENV === 'production' ? '/tmp/uploads/' : 'uploads/';
try { fs.mkdirSync(uploadDir, { recursive: true }); } catch {}
const upload = multer({ dest: uploadDir });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

// ---- Enums aligned with your Garage options for the extractor normalizer ----
const BILLING_TYPES = ['Flat price','Unit price','Tier flat price','Tier unit price'];
const FREQ_UNITS   = ['None','Day(s)','Week(s)','Semi_month(s)','Month(s)','Year(s)'];

// -------- helpers for normalizing model output --------
function clampEnum(value, allowed, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  const byLower = new Map(allowed.map(v => [v.toLowerCase(), v]));
  return byLower.get(value.toLowerCase()) || fallback;
}

// Detect “Luxury Presence” from item text or evidence
function isLuxuryPresenceHint(s) {
  const parts = []
    .concat(s?.item_name || [], s?.description || [])
    .concat(Array.isArray(s?.evidence) ? s.evidence.map(e => e?.snippet || '') : []);
  const hay = parts.join(' ').toLowerCase();
  return /luxury\s+presence/.test(hay); // strict and safe
}

// Require strong evidence before accepting Unit/Tier usage pricing
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

  // “Strong” = explicit per-X/usage wording, OR clear rate (ppu + unit), OR actual tiers
  return perPattern.test(hay) || usageWords.test(hay) || (hasPPU && hasUnitLabel) || tierCount > 0;
}

// Tighten the billing type normalizer: prefer Flat unless there’s strong proof
function normalizeBillingType(bt, hint = {}) {
  // Brand rule first
  if (isLuxuryPresenceHint(hint)) return 'Flat price';

  // If real tiers, treat as tiered (likely unit-priced tiers)
  if (Array.isArray(hint?.tiers) && hint.tiers.length) return 'Tier unit price';

  // Only accept Unit price if there is strong usage/per-unit evidence
  if (hasStrongUnitEvidence(hint)) return 'Unit price';

  // Fall back on the literal label if it clearly names a tier type
  const t = (bt || '').toLowerCase();
  if (t.includes('tier') && t.includes('unit')) return 'Tier unit price';
  if (t.includes('tier') && t.includes('flat')) return 'Tier flat price';

  // Otherwise, default to Flat price (safe, conservative)
  return 'Flat price';
}

function normalizeFrequency(rawText, rawEvery, rawUnit, fallback = 'None') {
  let every = Number.isInteger(rawEvery) ? rawEvery : 1;
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
  // Review-only; not sent in Garage JSON
  const periods = s.frequency_unit === 'None' ? 1 : pickNumber(s.periods, 1);
  const price   = pickNumber(s.total_price, null);
  if (price != null) return +(price * periods).toFixed(2);
  const ppu = pickNumber(s.price_per_unit, null);
  if (ppu != null) return +(ppu * periods).toFixed(2);
  return null;
}

// -------- prompt tuned to enumerate multi-schedules & return JSON only --------
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
- If you cannot provide such evidence in the evidence[].snippet for that item, use "Flat price" instead and add an issue describing the ambiguity.
- Never populate event_to_track unless the contract explicitly defines the tracked event; otherwise keep it null.

OUTPUT:
Return ONE JSON object only (no prose) with:
{
  "schedules": [
    {
      "schedule_label": "string|null",
      "item_name": "string",
      "description": "string|null",
      "billing_type": "Flat price|Unit price|Tier flat price|Tier unit price",
      "total_price": number|null,
      "quantity": number|null,
      "start_date": "YYYY-MM-DD|null",

      "frequency_every": number|null,
      "frequency_unit": "None|Day(s)|Week(s)|Semi_month(s)|Month(s)|Year(s)",

      "months_of_service": number|null,
      "periods": number|null,
      "calculated_end_date": "YYYY-MM-DD|null",
      "net_terms": number|null,
      "rev_rec_category": "string|null",

      "event_to_track": "string|null",
      "unit_label": "string|null",
      "price_per_unit": number|null,
      "volume_based": boolean|null,
      "tiers": [
        { "tier_name":"string|null","price":number|null,"applied_when":"string|null","min_quantity":number|null }
      ],

      "evidence": [{ "page": number, "snippet": "string" }]
    }
  ],
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

// ---- healthcheck (also confirms API key) ----
app.get('/health', async (_req, res) => {
  try {
    const models = await client.models.list();
    res.json({ ok: true, models: models.data.slice(0, 3).map(m => m.id) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- parsing & normalization helpers ----------
function parseModelJson(apiResponse) {
  const raw = apiResponse?.output_text ?? JSON.stringify(apiResponse || {});
  try { return JSON.parse(raw); }
  catch {
    const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
    return (a >= 0 && b > a) ? JSON.parse(raw.slice(a, b + 1)) : { schedules: [], issues: ['Could not parse model JSON'] };
  }
}

function normalizeSchedules(data) {
  const schedules = Array.isArray(data?.schedules) ? data.schedules : [];
  return schedules.map((s) => {
    const issues = Array.isArray(s.issues) ? [...s.issues] : [];

    // 1) Determine billing type with stricter heuristics + brand rule
    let bt = clampEnum(normalizeBillingType(s.billing_type, s), BILLING_TYPES, 'Flat price');

    // 2) Frequency normalization
    const { every, unit } = normalizeFrequency(s.frequency, s.frequency_every, s.frequency_unit, 'None');

    // 3) Base object
    let qty = pickNumber(s.quantity, null);
    if (bt === 'Flat price') qty = 1; // default quantity for flat price

    const out = {
      schedule_label: s.schedule_label ?? null,
      item_name: String(s.item_name || '').trim(),
      description: s.description ?? null,
      billing_type: bt,
      total_price: pickNumber(s.total_price, null),
      quantity: qty,
      start_date: s.start_date || null,

      frequency_every: pickNumber(every, 1),
      frequency_unit: clampEnum(unit, FREQ_UNITS, 'None'),

      months_of_service: pickNumber(s.months_of_service, null),
      periods: pickNumber(s.periods, 1),
      calculated_end_date: s.calculated_end_date || null,
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

    // 4) Enforce Luxury Presence policy & anti‑guessing guardrails
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
      // Demote weak “Unit price” guesses to Flat price
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
      // If Tier type but no actual tiers, demote to Flat price
      if ((out.billing_type === 'Tier unit price' || out.billing_type === 'Tier flat price') && (!out.tiers || out.tiers.length === 0)) {
        out.billing_type = 'Flat price';
        out.quantity = 1;
        out.issues.push('Demoted Tier → Flat: no tiers found.');
      }
    }

    // Derived, for UI only (not returned in Garage JSON)
    out.total_value = computeTotalValue(out);
    return out;
  });
}

// ---------- agreement & confidence ----------
function clamp01(x){ return Math.max(0, Math.min(1, Number(x)||0)); }
function tokenize(s) {
  if (!s) return [];
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(x => x && x.length > 1);
}
function jaccardTokens(a, b) {
  const A = new Set(tokenize(a)); const B = new Set(tokenize(b));
  if (!A.size && !B.size) return 1;
  const inter = [...A].filter(x => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
}
function numericSimilarity(a, b) {
  if (a == null && b == null) return 1;
  if (a == null || b == null) return 0;
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  const diff = Math.abs(x - y);
  const denom = Math.max(1, Math.abs(x), Math.abs(y));
  return clamp01(1 - diff / denom); // relative difference
}
function dateSimilarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const da = new Date(a), db = new Date(b);
  if (isNaN(da) || isNaN(db)) return 0;
  const days = Math.abs((db - da) / (1000*60*60*24));
  return clamp01(Math.exp(-days/30)); // ~1 within few days; decays over ~1 month
}
function enumSimilarity(a, b) { return (a && b && String(a) === String(b)) ? 1 : (!a && !b ? 1 : 0); }
function tiersSimilarity(ta, tb) {
  if (!Array.isArray(ta) && !Array.isArray(tb)) return 1;
  if (!Array.isArray(ta) || !Array.isArray(tb)) return 0;
  if (ta.length === 0 && tb.length === 0) return 1;
  const len = Math.max(ta.length, tb.length);
  if (!len) return 1;
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
  const w = {
    item_name: 0.35, total_price: 0.25, start_date: 0.10,
    frequency_unit: 0.10, frequency_every: 0.05,
    unit_label: 0.05, event_to_track: 0.05, tiers: 0.05
  };
  const sim =
    w.item_name*fields.item_name +
    w.total_price*fields.total_price +
    w.start_date*fields.start_date +
    w.frequency_unit*fields.frequency_unit +
    w.frequency_every*fields.frequency_every +
    w.unit_label*fields.unit_label +
    w.event_to_track*fields.event_to_track +
    w.tiers*fields.tiers;
  return { sim: clamp01(sim), fields };
}
function keyCompletenessPenalty(s) {
  const keys = ['item_name','total_price','start_date','frequency_unit','periods'];
  const missing = keys.reduce((acc, k) => acc + (s[k]==null || s[k]==='' ? 1 : 0), 0);
  return clamp01(1 - (missing / keys.length) * 0.5); // up to -50% if all missing
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
    const confidence = clamp01(0.2 + 0.8 * best.sim * missingPenalty); // 20% floor
    const flag_for_review = confidence < 0.75 || best.sim < 0.70;
    return {
      confidence,
      flag_for_review,
      agreement: {
        matched_index_in_run2: best.j,
        similarity: best.sim,
        fields: best.fields
      }
    };
  });
  const avg = enriched.length ? (enriched.reduce((s, e) => s + e.confidence, 0) / enriched.length) : null;
  const min = enriched.length ? enriched.reduce((m, e) => Math.min(m, e.confidence), 1) : null;
  return {
    enriched,
    summary: {
      avg_confidence: avg,
      min_confidence: min,
      total_items_run1: first.length,
      total_items_run2: second.length,
      unmatched_in_run2: Math.max(0, first.length - used.size)
    }
  };
}

// ---- main extraction ----
app.post('/api/extract', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  console.log('Upload received:', { originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size });

  try {
    const { model = 'o3', forceMulti = 'auto', runs = '2' } = req.query;
    const chosenModel = ['o3','o4-mini','gpt-4o-mini','o3-mini'].includes(model) ? model : 'o3';
    const agreementRuns = Math.max(1, Math.min(5, Number(runs) || 1)); // cap @ 5

    // 1) Upload PDF with a real filename so the API knows it's a PDF
    const uploaded = await client.files.create({
      file: await toFile(fs.createReadStream(req.file.path), req.file.originalname || 'contract.pdf'),
      purpose: 'assistants'
    });
    console.log('OpenAI file_id:', uploaded.id);

    // 2) Ask for a single JSON object (Run #1)
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

    // 3) Parse and normalize Run #1
    const data1 = parseModelJson(response1);
    const norm1 = normalizeSchedules(data1);

    // 4) Optional Run #2 — identical prompt/model/PDF for agreement scoring
    let norm2 = null;
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
      norm2 = normalizeSchedules(data2);
      agreement = computeAgreement(norm1, norm2);
      // Attach per-item confidence onto Run #1 items only
      agreement.enriched.forEach((extra, idx) => {
        Object.assign(norm1[idx], extra);
      });
    }

    res.json({
      model_used: chosenModel,
      runs: agreementRuns,
      schedules: norm1,
      model_recommendations: data1.model_recommendations ?? null,
      issues: Array.isArray(data1.issues) ? data1.issues : [],
      totals_check: data1.totals_check ?? null,
      agreement_summary: agreement?.summary ?? null
    });
  } catch (err) {
    const debug = {
      message: err?.message,
      status: err?.status,
      name: err?.name,
      type: err?.type,
      code: err?.code,
      request_id: err?.headers?.['x-request-id'],
      data: err?.error ?? err?.response?.data ?? err?.response_body ?? null
    };
    console.error('OpenAI error:', JSON.stringify(debug, null, 2));
    res.status(500).json({ error: 'Extraction failed', debug });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// -------------- Contract Assistant Endpoint --------------
app.get('/api/use-contract-assistant', async (req, res) => {
  const { contractID, model = 'o3', forceMulti = 'auto' } = req.query;
  if (!contractID) return res.status(400).json({ error: 'Missing contractID' });

  try {
    // 1️⃣ Fetch the PDF from Tabs API
    const pdfResp = await fetch(`https://integrators.prod.api.tabsplatform.com/v3/contracts/${contractID}/file`, {
      headers: {
        'accept': 'application/pdf',
        'Authorization': `${process.env.LUXURY_PRESENCE_TABS_SANDBOX_API_KEY}`
      }
    });
    print('Hitting tabs api with contractID ', contractID);
    print('pdfResp', pdfResp);
    if (!pdfResp.ok) {
      throw new Error(`Failed to fetch PDF for contract ${contractID}: ${pdfResp.status}`);
    }

    // 2️⃣ Write PDF to temp file
    const tempPath = `/tmp/${contractID}.pdf`;
    const buf = Buffer.from(await pdfResp.arrayBuffer());
    await fs.promises.writeFile(tempPath, buf);
    print('Wrote pdf to temp file');
    // 3️⃣ Reuse existing /api/extract logic by simulating a file upload
    const uploaded = await client.files.create({
      file: await toFile(fs.createReadStream(tempPath), `${contractID}.pdf`),
      purpose: 'assistants'
    });
    print('Created file id', uploaded.id);
    // 4️⃣ Call the same OpenAI extraction flow used in /api/extract
    const response = await client.responses.create({
      model,
      input: [
        { role: 'system', content: buildSystemPrompt(forceMulti) },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Extract Garage-ready revenue schedules as a single JSON object.' },
            { type: 'input_file', file_id: uploaded.id }
          ]
        }
      ],
      text: { format: { type: 'json_object' } }
    });
    print('Response from OpenAI', response);
    const data = parseModelJson(response);
    const normalized = normalizeSchedules(data);
    print('Normalized data', normalized);
    res.json({
      model_used: model,
      schedules: normalized,
      model_recommendations: data.model_recommendations ?? null,
      issues: Array.isArray(data.issues) ? data.issues : [],
      totals_check: data.totals_check ?? null
    });
    print('Response sent to client', res.json);
    fs.unlink(tempPath, () => {});
  } catch (err) {
    console.error('use-contract-assistant error:', err);
    res.status(500).json({ error: err.message });
  }
});


// local dev; on Vercel we export the handler
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Garage assistant running on http://localhost:${PORT}`));
}
export default app;
