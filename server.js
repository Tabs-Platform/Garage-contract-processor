import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

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
function normalizeBillingType(bt, hint = {}) {
  const t = (bt || '').toLowerCase();
  if (t.includes('tier') && t.includes('unit')) return 'Tier unit price';
  if (t.includes('tier') && t.includes('flat')) return 'Tier flat price';
  if (t.includes('unit')) return 'Unit price';
  const { tiers, price_per_unit, unit_label } = hint || {};
  if (Array.isArray(tiers) && tiers.length) return 'Tier unit price';
  if (price_per_unit || unit_label) return 'Unit price';
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

// ---- main extraction ----
app.post('/api/extract', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  console.log('Upload received:', { originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size });

  try {
    const { model = 'o3', forceMulti = 'auto' } = req.query;
    const chosenModel = ['o3','o4-mini','gpt-4o-mini','o3-mini'].includes(model) ? model : 'o3';

    // 1) Upload PDF with a real filename so the API knows it's a PDF
    const uploaded = await client.files.create({
      file: await toFile(fs.createReadStream(req.file.path), req.file.originalname || 'contract.pdf'),
      purpose: 'assistants'
    });
    console.log('OpenAI file_id:', uploaded.id);

    // 2) Ask for a single JSON object
    const response = await client.responses.create({
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

    // 3) Parse and normalize (drop any confidence fields)
    const raw = response.output_text ?? JSON.stringify(response);
    let data;
    try { data = JSON.parse(raw); }
    catch {
      const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
      data = (a >= 0 && b > a) ? JSON.parse(raw.slice(a, b + 1)) : { schedules: [], issues: ['Could not parse model JSON'] };
    }

    const schedules = Array.isArray(data.schedules) ? data.schedules : [];
    const normalized = schedules.map((s) => {
      const issues = Array.isArray(s.issues) ? [...s.issues] : [];

      const bt = clampEnum(normalizeBillingType(s.billing_type, s), BILLING_TYPES, 'Flat price');
      const { every, unit } = normalizeFrequency(s.frequency, s.frequency_every, s.frequency_unit, 'None');

      // Quantity heuristic: default Flat price to 1; otherwise leave as provided or null
      let qty = pickNumber(s.quantity, null);
      if (bt === 'Flat price') qty = 1;

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

      // Derived, for UI only (not returned in Garage JSON)
      out.total_value = computeTotalValue(out);
      return out;
    });

    res.json({
      model_used: chosenModel,
      schedules: normalized,
      model_recommendations: data.model_recommendations ?? null,
      issues: Array.isArray(data.issues) ? data.issues : [],
      totals_check: data.totals_check ?? null
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

// local dev; on Vercel we export the handler
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Garage assistant running on http://localhost:${PORT}`));
}
export default app;
