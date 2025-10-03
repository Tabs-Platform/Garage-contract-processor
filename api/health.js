import OpenAI from 'openai';

export default async function handler(req, res) {
  try {
    const hasKey = !!process.env.OPENAI_API_KEY;
    const keyPrefix = process.env.OPENAI_API_KEY 
      ? process.env.OPENAI_API_KEY.substring(0, 10) + '...' 
      : 'NOT_SET';
    
    // Test OpenAI connection
    let modelsOk = false;
    let errorMsg = null;
    
    if (hasKey) {
      try {
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const models = await client.models.list();
        modelsOk = models.data && models.data.length > 0;
      } catch (e) {
        errorMsg = e.message;
      }
    }
    
    res.status(200).json({
      status: 'ok',
      hasApiKey: hasKey,
      keyPrefix,
      openaiConnected: modelsOk,
      error: errorMsg,
      nodeEnv: process.env.NODE_ENV
    });
  } catch (err) {
    res.status(500).json({ 
      status: 'error', 
      message: err.message,
      hasApiKey: !!process.env.OPENAI_API_KEY
    });
  }
}
