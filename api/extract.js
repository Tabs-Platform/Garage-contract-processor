import multiparty from 'multiparty';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import fs from 'fs';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper to parse multipart form data
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const form = new multiparty.Form();
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { fields, files } = await parseMultipart(req);
    
    if (!files.file || !files.file[0]) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const uploadedFile = files.file[0];
    console.log('Upload received:', {
      originalFilename: uploadedFile.originalFilename,
      size: uploadedFile.size
    });

    // Upload to OpenAI
    const model = (fields.model && fields.model[0]) || 'o3';
    const chosenModel = ['o3','o4-mini','gpt-4o-mini','o3-mini'].includes(model) ? model : 'o3';

    const openaiFile = await client.files.create({
      file: await toFile(
        fs.createReadStream(uploadedFile.path),
        uploadedFile.originalFilename || 'contract.pdf'
      ),
      purpose: 'assistants'
    });

    // Call the model (simplified for now)
    const response = await client.responses.create({
      model: chosenModel,
      input: [
        { 
          role: 'system', 
          content: 'You are a revenue operations analyst. Extract all billable items from this contract as JSON with fields: item_name, total_price, start_date, billing_type, quantity.' 
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Extract revenue schedules as JSON.' },
            { type: 'input_file', file_id: openaiFile.id }
          ]
        }
      ],
      text: { format: { type: 'json_object' } }
    });

    const raw = response.output_text ?? JSON.stringify(response);
    const data = JSON.parse(raw);

    // Clean up temp file
    fs.unlink(uploadedFile.path, () => {});

    return res.status(200).json({
      model_used: chosenModel,
      schedules: data.schedules || [],
      issues: data.issues || []
    });

  } catch (err) {
    console.error('Extraction error:', err);
    return res.status(500).json({ 
      error: 'Extraction failed', 
      debug: {
        message: err?.message,
        type: err?.type,
        code: err?.code
      }
    });
  }
}
