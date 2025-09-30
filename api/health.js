import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  try {
    const models = await client.models.list();
    res.status(200).json({ 
      ok: true, 
      models: models.data.slice(0, 3).map((m) => m.id) 
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
