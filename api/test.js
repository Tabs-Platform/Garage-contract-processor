export default function handler(req, res) {
  res.status(200).json({ 
    message: 'Vercel serverless is working!',
    env: {
      hasOpenAIKey: !!process.env.OPENAI_API_KEY,
      nodeEnv: process.env.NODE_ENV
    }
  });
}
