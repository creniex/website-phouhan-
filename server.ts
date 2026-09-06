import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, GenerateVideosOperation } from '@google/genai';
import { getDb } from './db/database';
import authRouter from './routes/auth';
import apiRouter from './routes/api';
import adminRouter from './routes/admin';

dotenv.config();

function getGenAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in the environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Initialize SQLite Database schema & seeds
  await getDb();

  // EJS View Engine Configuration
  app.set('view engine', 'ejs');
  app.set('views', path.join(process.cwd(), 'views'));

  // Cookie Parser Middleware
  app.use(cookieParser());

  // JSON payload parser for large image base64 data & forms
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Static uploads directory serving
  app.use('/uploads', express.static(path.join(process.cwd(), 'public', 'uploads')));
  app.use(express.static(path.join(process.cwd(), 'public')));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Authentication Routes
  app.use('/api/auth', authRouter);

  // General CMS REST API Routes
  app.use('/api', apiRouter);

  // Admin Dashboard & Pages
  app.use('/admin', adminRouter);

  // 1. Generate Video from Image (Veo 3.1 Fast Generate Preview)
  app.post('/api/video/generate', async (req, res) => {
    try {
      const { imageBase64, mimeType = 'image/jpeg', prompt, aspectRatio = '16:9' } = req.body;

      if (!imageBase64) {
        return res.status(400).json({ error: 'imageBase64 is required for image-to-video animation.' });
      }

      const validAspectRatios = ['16:9', '9:16'];
      const targetAspectRatio = validAspectRatios.includes(aspectRatio) ? aspectRatio : '16:9';

      // Clean base64 header if present
      const cleanBase64 = imageBase64.replace(/^data:image\/[a-z0-9+.-]+;base64,/, '');

      const ai = getGenAI();

      const videoPrompt =
        prompt && prompt.trim().length > 0
          ? prompt.trim()
          : 'Subtle cinematic slow camera glide, warm natural golden lighting, serene heritage movement, realistic atmospheric motion, ultra-smooth 60fps luxury resort feel';

      const operation = await ai.models.generateVideos({
        model: 'veo-3.1-fast-generate-preview',
        prompt: videoPrompt,
        image: {
          imageBytes: cleanBase64,
          mimeType: mimeType || 'image/jpeg',
        },
        config: {
          numberOfVideos: 1,
          resolution: '720p',
          aspectRatio: targetAspectRatio as '16:9' | '9:16',
        },
      });

      if (!operation || !operation.name) {
        throw new Error('Veo model did not return a valid operation name.');
      }

      return res.json({
        success: true,
        operationName: operation.name,
        aspectRatio: targetAspectRatio,
      });
    } catch (err: any) {
      console.error('Error starting video generation:', err);
      return res.status(500).json({
        error: err?.message || 'Failed to start video generation with Veo.',
      });
    }
  });

  // 2. Poll Video Generation Status
  app.post('/api/video/status', async (req, res) => {
    try {
      const { operationName } = req.body;
      if (!operationName) {
        return res.status(400).json({ error: 'operationName is required' });
      }

      const ai = getGenAI();
      const op = new GenerateVideosOperation();
      op.name = operationName;

      const updated = await ai.operations.getVideosOperation({ operation: op });

      if (updated.error) {
        return res.json({
          done: true,
          error: updated.error,
        });
      }

      return res.json({
        done: Boolean(updated.done),
      });
    } catch (err: any) {
      console.error('Error checking video status:', err);
      return res.status(500).json({
        error: err?.message || 'Failed to retrieve video status.',
      });
    }
  });

  // 3. Download / Stream Video
  app.post('/api/video/download', async (req, res) => {
    try {
      const { operationName } = req.body;
      if (!operationName) {
        return res.status(400).json({ error: 'operationName is required' });
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'API key not configured' });
      }

      const ai = getGenAI();
      const op = new GenerateVideosOperation();
      op.name = operationName;

      const updated = await ai.operations.getVideosOperation({ operation: op });

      if (!updated.done) {
        return res.status(400).json({ error: 'Video generation is not yet complete.' });
      }

      const uri = updated.response?.generatedVideos?.[0]?.video?.uri;
      if (!uri) {
        return res.status(500).json({ error: 'Generated video URI not found in operation response.' });
      }

      const videoRes = await fetch(uri, {
        headers: { 'x-goog-api-key': apiKey },
      });

      if (!videoRes.ok) {
        throw new Error(`Failed to fetch video binary from upstream (status: ${videoRes.status})`);
      }

      const arrayBuffer = await videoRes.arrayBuffer();
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'inline; filename="chouhan-palace-animated.mp4"');
      return res.send(Buffer.from(arrayBuffer));
    } catch (err: any) {
      console.error('Error downloading video:', err);
      return res.status(500).json({
        error: err?.message || 'Failed to download generated video.',
      });
    }
  });

  // Vite development middleware or static production handler for SPA fallback
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Chouhan Palace server running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
