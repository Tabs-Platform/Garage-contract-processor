import OpenAI from 'openai';
import formidable from 'formidable';
import fs from 'fs/promises';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse form data
    const form = formidable({ multiples: false });
    const [fields, files] = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve([fields, files]);
      });
    });

    const file = files.file?.[0] || files.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { model = 'gpt-4o-mini' } = req.query;

    // Read file buffer
    const fileBuffer = await fs.readFile(file.filepath);
    
    // Upload to OpenAI
    const uploaded = await client.files.create({
      file: new File([fileBuffer], file.originalFilename || 'contract.pdf', {
        type: 'application/pdf'
      }),
      purpose: 'assistants'
    });

    // Simple extraction
    const response = await client.chat.completions.create({
      model: model === 'o3' || model === 'o4-mini' ? 'gpt-4o' : model,
      messages: [
        {
          role: 'system',
          content: 'Extract revenue schedules from the contract. Return JSON: {"schedules":[{"item_name":"...","total_price":0,"start_date":"YYYY-MM-DD","billing_type":"Flat price"}]}'
        },
        {
          role: 'user',
          content: `Extract from file ${uploaded.id}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);

    // Clean up temp file
    await fs.unlink(file.filepath).catch(() => {});

    return res.status(200).json({
      model_used: model,
      schedules: result.schedules || [],
      issues: []
    });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({
      error: 'Extraction failed',
      debug: {
        message: err.message,
        stack: err.stack?.split('\n').slice(0, 3).join('\n')
      }
    });
  }
}