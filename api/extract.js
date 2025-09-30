// api/extract.js
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import multer from 'multer';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const upload = multer({ dest: '/tmp' });

// --- Schemas (copied from server.js) ---
const ScheduleSchema = z.object({
  schedule_label: z.string().optional(),
  item_name: z.string(),
  description: z.string().optional(),
  billing_type: z.enum(["Flat price", "Unit price", "Recurring", "Usage", "Other"]).default("Flat price"),
  total_price: z.number(),
  quantity: z.number().default(1),
  start_date: z.string(),
  months_of_service: z.number().int().optional(),
  frequency: z.string().default("None"),
  periods: z.number().int().default(1),
  calculated_end_date: z.string().optional(),
  net_terms: z.number().int().default(30),
  rev_rec_category: z.string().optional(),
  evidence: z.array(z.object({ page: z.number().int(), snippet: z.string() })).default([]),
  confidences: z.record(z.number()).default({}),
  overall_confidence: z.number()
});

const ExtractSchema = z.object({
  customer: z.object({
    legal_name: z.string().optional(),
    address: z.string().optional(),
    tax_id: z.string().optional()
  }).optional(),
  schedules: z.array(ScheduleSchema),
  totals_check: z.object({
    sum_of_items: z.number().optional(),
    contract_total_if_any: z.number().optional(),
    matches: z.boolean().optional(),
    notes: z.string().optional()
  }).optional(),
  model_recommendations: z.object({
    force_multi: z.boolean().optional(),
    reasons: z.array(z.string()).optional()
  }).optional(),
  issues: z.array(z.string()).default([])
});

function buildSystemPrompt(forceMulti = 'auto') {
  const multiHint = forceMulti === 'on'
    ? 'ALWAYS enumerate multiple schedules if plausible.'
    : forceMulti === 'off'
      ? 'Return exactly the items you are certain of; do not search for additional schedules.'
      : 'Decide whether multiple schedules exist; if there is evidence (multiple fees, renewal tables, “co-term”, “expansion”, etc.) set model_recommendations.force_multi=true and enumerate them.';
  return `You are an expert Revenue Operations analyst for Tabs Platform's Garage.

TASK:\nGiven a contract PDF, enumerate EVERY billable item and map each to Garage fields for Revenue Schedules. If anything is ambiguous, return a conservative result and add an issue explaining what to check.\n\n${multiHint}\n\nOUTPUT:\nReturn STRICT JSON matching the provided JSON Schema. Do not include prose outside JSON.`;
}

export const config = {
  api: {
    bodyParser: false // we handle multipart via multer
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // parse multipart
  await new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => (err ? reject(err) : resolve()));
  });

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { model = 'o3', forceMulti = 'auto' } = req.query;

  try {
    const uploaded = await client.files.create({
      file: fs.createReadStream(req.file.path),
      purpose: 'assistants'
    });

    const response = await client.responses.create({
      model: ['o3', 'o4-mini', 'gpt-4o-mini', 'o3-mini'].includes(model) ? model : 'o3',
      input: [
        { role: 'system', content: buildSystemPrompt(forceMulti) },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Extract revenue schedules per schema.' },
            { type: 'input_file', file_id: uploaded.id }
          ]
        }
      ],
      text: {
        format: 'json_schema',
        schema: {
          name: 'Extract',
          schema: zodToJsonSchema(ExtractSchema, 'Extract'),
          strict: true
        }
      }
    });

    const extracted = ExtractSchema.parse(JSON.parse(response.output_text));
    res.json(extracted);
  } catch (err) {
    const debug = {
      message: err.message,
      status: err.status,
      code: err.code,
      type: err.type,
      request_id: err.request_id
    };
    console.error('OpenAI error', debug);
    res.status(err.status || 500).json({ error: 'Extraction failed', debug });
  } finally {
    await fsPromises.unlink(req.file.path).catch(() => {});
  }
}
