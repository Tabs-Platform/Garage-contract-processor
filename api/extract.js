import OpenAI from 'openai';
import { Readable } from 'stream';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Parse multipart form data manually (Vercel doesn't support multer)
async function parseMultipart(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  
  // Extract file from multipart boundary
  const boundary = req.headers['content-type']?.split('boundary=')[1];
  if (!boundary) throw new Error('No boundary found');
  
  const parts = buffer.toString('binary').split(`--${boundary}`);
  for (const part of parts) {
    if (part.includes('filename=')) {
      const fileStart = part.indexOf('\r\n\r\n') + 4;
      const fileEnd = part.lastIndexOf('\r\n');
      return Buffer.from(part.substring(fileStart, fileEnd), 'binary');
    }
  }
  throw new Error('No file found in request');
}

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { model = 'gpt-4o-mini', forceMulti = 'auto' } = req.query;
    
    // Parse the PDF from multipart form data
    const fileBuffer = await parseMultipart(req);
    
    // Upload to OpenAI
    const file = new File([fileBuffer], 'contract.pdf', { type: 'application/pdf' });
    const uploaded = await client.files.create({
      file: file,
      purpose: 'assistants'
    });

    // Simple prompt for now
    const systemPrompt = `Extract revenue schedule information from this contract PDF.
Return JSON with: { "schedules": [{ "item_name": "...", "total_price": 0, "start_date": "YYYY-MM-DD" }] }`;

    // Call OpenAI
    const response = await client.chat.completions.create({
      model: model === 'o3' ? 'gpt-4o' : model,
      messages: [
        { role: 'system', content: systemPrompt },
        { 
          role: 'user', 
          content: `Extract schedules from file ID: ${uploaded.id}` 
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);
    
    res.status(200).json({
      model_used: model,
      schedules: result.schedules || [],
      issues: []
    });
    
  } catch (err) {
    console.error('Extraction error:', err);
    res.status(500).json({ 
      error: 'Extraction failed', 
      debug: {
        message: err.message,
        name: err.name
      }
    });
  }
}

export const config = {
  api: {
    bodyParser: false, // We parse manually
  },
};
