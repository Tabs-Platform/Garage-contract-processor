// api/health.js
import OpenAI from 'openai';

export default async function handler(_req, res) {
  try {
    const client = new OpenAI();
    const list = await client.models.list();
    res.json({ ok: true, models: list.data.slice(0, 5).map(m => m.id) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
