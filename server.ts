import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import multer from 'multer';
import JSZip from 'jszip';
import type { JobProgressEvent, SynthesisEngineChoice } from './src/types/dubstudio.ts';
import { generateSampleClip, runDubbingPipeline } from './server/dubPipeline.ts';
import { SUPPORTED_LANGUAGES, VOICE_CATALOG } from './server/voices.ts';

function loadOptionalDotEnv(): void {
  const candidates = [
    path.join(process.cwd(), '.env'),
    ...(process.env.SADAVOX_DATA_DIR
      ? [path.join(process.env.SADAVOX_DATA_DIR, '.env')]
      : []),
  ];
  for (const envFile of candidates) {
    try {
      if (!fs.existsSync(envFile)) continue;
      const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key && !(key in process.env)) {
          process.env[key] = val;
        }
      }
    } catch {
      // Optional .env file missing or unreadable; keyless local mode remains active
    }
  }
}

loadOptionalDotEnv();

const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const WORK_ROOT = process.env.SADAVOX_DATA_DIR
  ? path.join(process.env.SADAVOX_DATA_DIR, 'workspace')
  : path.join(os.tmpdir(), 'sadavox_studio');
const UPLOAD_DIR = path.join(WORK_ROOT, 'uploads');
const CHUNK_DIR = path.join(WORK_ROOT, 'chunks');
const OUTPUT_DIR = path.join(WORK_ROOT, 'outputs');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(CHUNK_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

interface JobRecord {
  state: JobProgressEvent;
  startedAt: number;
  listeners: Set<(evt: JobProgressEvent) => void>;
}

const jobs = new Map<string, JobRecord>();
const pendingChunkUploads = new Map<string, { partPath: string; originalName: string }>();
const completedUploads = new Map<string, { path: string; originalName: string }>();
const localSourcePaths = new Map<string, string>();

function updateJob(jobId: string, patch: Partial<JobProgressEvent>): void {
  const record = jobs.get(jobId);
  if (!record) return;
  const elapsedSec = Number(((Date.now() - record.startedAt) / 1000).toFixed(1));
  record.state = {
    ...record.state,
    ...patch,
    elapsedSec,
  };
  for (const listener of record.listeners) {
    listener(record.state);
  }
}

export interface StudioServerOptions {
  port?: number;
  host?: string;
  staticDistDir?: string;
  useViteDev?: boolean;
}

export async function startStudioServer(options: StudioServerOptions = {}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/catalog', (_req, res) => {
    const elKey = process.env.ELEVENLABS_API_KEY;
    const elevenlabsConfigured = Boolean(
      elKey && elKey !== 'MY_ELEVENLABS_API_KEY' && elKey !== 'your_elevenlabs_api_key_here'
    );
    res.json({
      languages: SUPPORTED_LANGUAGES,
      voices: VOICE_CATALOG,
      elevenlabsConfigured,
    });
  });

  app.post('/api/sample-audio', async (req, res) => {
    try {
      const lang = req.body?.lang === 'ps' ? 'ps' : 'en';
      const sample = await generateSampleClip(lang);
      res.setHeader('Content-Type', sample.mimeType);
      res.setHeader('X-Sample-Transcript', encodeURIComponent(sample.transcript));
      res.send(sample.audioBuffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate sample audio.';
      res.status(500).json({ error: message });
    }
  });

  // Chunked upload endpoints so large videos (up to 3 GB) bypass proxy payload limits
  app.post('/api/upload/init', async (req, res, next) => {
    try {
      const requestedSize = Number(req.body?.fileSize || 0);
      if (Number.isFinite(requestedSize) && requestedSize > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: 'File exceeds the 3 GB studio upload limit.' });
        return;
      }
      const uploadId = randomUUID().slice(0, 16);
      const originalName =
        typeof req.body?.filename === 'string' && req.body.filename.trim()
          ? path.basename(req.body.filename.trim())
          : 'upload.mp4';
      const partPath = path.join(CHUNK_DIR, `${uploadId}.part`);
      await fsp.writeFile(partPath, Buffer.alloc(0));
      pendingChunkUploads.set(uploadId, { partPath, originalName });
      res.json({ uploadId, originalName });
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/upload/chunk',
    express.raw({ type: '*/*', limit: '16mb' }),
    async (req, res, next) => {
      try {
        let uploadId = path.basename(String(req.headers['x-upload-id'] || ''));
        let chunkIndex = Number(req.headers['x-chunk-index']);
        let chunkOffset = req.headers['x-chunk-offset'] !== undefined ? Number(req.headers['x-chunk-offset']) : NaN;
        let bodyBuf: Buffer;

        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('application/json')) {
          const parsed = (Buffer.isBuffer(req.body)
            ? JSON.parse(req.body.toString('utf8'))
            : req.body) as {
            uploadId?: string;
            chunkIndex?: number;
            offset?: number;
            dataBase64?: string;
          };
          uploadId = path.basename(String(parsed?.uploadId || ''));
          chunkIndex = Number(parsed?.chunkIndex);
          chunkOffset = parsed?.offset !== undefined ? Number(parsed.offset) : NaN;
          bodyBuf = Buffer.from(String(parsed?.dataBase64 || ''), 'base64');
        } else {
          bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
        }

        if (!uploadId || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
          res.status(400).json({ error: 'Missing uploadId or chunkIndex.' });
          return;
        }

        const pending = pendingChunkUploads.get(uploadId);
        const partPath = pending?.partPath || path.join(CHUNK_DIR, `${uploadId}.part`);
        if (!fs.existsSync(partPath)) {
          res.status(404).json({ error: 'Upload session not found.' });
          return;
        }

        if (Number.isFinite(chunkOffset) && chunkOffset >= 0) {
          if (chunkOffset + bodyBuf.length > MAX_UPLOAD_BYTES) {
            res.status(413).json({ error: 'File exceeds the 3 GB studio upload limit.' });
            return;
          }
          const fh = await fsp.open(partPath, 'r+');
          try {
            await fh.write(bodyBuf, 0, bodyBuf.length, chunkOffset);
          } finally {
            await fh.close();
          }
        } else {
          await fsp.appendFile(partPath, bodyBuf);
        }

        res.json({ ok: true, chunkIndex });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post('/api/upload/complete', async (req, res, next) => {
    try {
      const uploadId = path.basename(String(req.body?.uploadId || ''));
      const pending = pendingChunkUploads.get(uploadId);
      const originalName =
        typeof req.body?.filename === 'string' && req.body.filename.trim()
          ? path.basename(req.body.filename.trim())
          : pending?.originalName || 'upload.mp4';
      const totalChunks = Number(req.body?.totalChunks);
      const partPath = pending?.partPath || path.join(CHUNK_DIR, `${uploadId}.part`);

      if (!uploadId || !fs.existsSync(partPath) || !Number.isInteger(totalChunks) || totalChunks <= 0) {
        res.status(400).json({ error: 'Invalid upload completion payload.' });
        return;
      }

      const ext = path.extname(originalName) || '.mp4';
      const assembledPath = path.join(UPLOAD_DIR, `${uploadId}${ext}`);
      await fsp.rename(partPath, assembledPath);
      pendingChunkUploads.delete(uploadId);

      completedUploads.set(uploadId, { path: assembledPath, originalName });
      res.json({ uploadId });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/dub', upload.single('media'), (req, res) => {
    const jobId = randomUUID().slice(0, 12);
    const jobDir = path.join(OUTPUT_DIR, jobId);

    const mode = req.body?.mode === 'audio' ? 'audio' : 'video';
    const videoUrl = typeof req.body?.videoUrl === 'string' ? req.body.videoUrl.trim() : '';
    const uploadId = typeof req.body?.uploadId === 'string' ? req.body.uploadId.trim() : '';
    const rawLocalPath = typeof req.body?.localFilePath === 'string' ? req.body.localFilePath.trim() : '';
    const canUseLocalPaths = Boolean(process.env.SADAVOX_DATA_DIR || process.env.SADAVOX_ALLOW_LOCAL_PATHS === '1');
    const localFilePath =
      canUseLocalPaths && rawLocalPath && fs.existsSync(rawLocalPath) && fs.statSync(rawLocalPath).isFile()
        ? rawLocalPath
        : undefined;

    const sourceLang = typeof req.body?.sourceLang === 'string' ? req.body.sourceLang : 'auto';
    const targetLang = typeof req.body?.targetLang === 'string' ? req.body.targetLang : 'ps';
    const voiceIdentifier =
      typeof req.body?.voiceId === 'string' ? req.body.voiceId : 'clone_original_speaker';
    const preserveBgAudio = Math.min(
      0.35,
      Math.max(0, Number(req.body?.bgMix ?? 0.08) || 0)
    );
    const rawEngine = req.body?.engine;
    const engine: SynthesisEngineChoice =
      rawEngine === 'elevenlabs' || rawEngine === 'gemini' || rawEngine === 'edge'
        ? rawEngine
        : 'auto';

    let uploadedFilePath = req.file?.path;
    let uploadedOriginalName =
      typeof req.body?.originalName === 'string' && req.body.originalName.trim()
        ? req.body.originalName.trim()
        : req.file?.originalname;

    if (!uploadedFilePath && !localFilePath && uploadId) {
      const assembled = completedUploads.get(uploadId);
      if (!assembled) {
        res.status(400).json({ error: 'Chunked upload expired or was not found. Please try uploading again.' });
        return;
      }
      uploadedFilePath = assembled.path;
      uploadedOriginalName = assembled.originalName;
      completedUploads.delete(uploadId);
    }

    if (!uploadedFilePath && !localFilePath && !videoUrl) {
      res.status(400).json({
        error: 'Upload a video or MP3/audio file, record from your microphone, or paste a direct media URL.',
      });
      return;
    }

    if (localFilePath) {
      localSourcePaths.set(jobId, localFilePath);
    }

    const initialState: JobProgressEvent = {
      jobId,
      status: 'processing',
      progress: 3,
      stage: 'Queued dubbing pipeline...',
      elapsedSec: 0,
    };

    jobs.set(jobId, {
      state: initialState,
      startedAt: Date.now(),
      listeners: new Set(),
    });

    void (async () => {
      try {
        const result = await runDubbingPipeline({
          jobId,
          jobDir,
          mode,
          uploadedFilePath,
          uploadedOriginalName,
          localFilePath,
          videoUrl: videoUrl || undefined,
          sourceLang,
          targetLang,
          voiceIdentifier,
          preserveBgAudio,
          engine,
          onProgress: (progress, stage) => {
            updateJob(jobId, { status: 'processing', progress, stage });
          },
        });
        updateJob(jobId, {
          status: 'completed',
          progress: 100,
          stage: 'Dubbing complete',
          result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Dubbing pipeline failed.';
        updateJob(jobId, {
          status: 'error',
          stage: 'Failed',
          error: message,
        });
      } finally {
        if (uploadedFilePath) {
          await fsp.unlink(uploadedFilePath).catch(() => {});
        }
      }
    })();

    res.status(202).json({ jobId });
  });

  app.get('/api/dub/status/:jobId', (req, res) => {
    const record = jobs.get(req.params.jobId);
    if (!record) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(record.state);
  });

  app.get('/api/dub/events/:jobId', (req, res) => {
    const record = jobs.get(req.params.jobId);
    if (!record) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (evt: JobProgressEvent) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
      if (evt.status === 'completed' || evt.status === 'error') {
        res.end();
      }
    };

    sendEvent(record.state);
    if (record.state.status === 'completed' || record.state.status === 'error') {
      return;
    }

    record.listeners.add(sendEvent);
    req.on('close', () => {
      record.listeners.delete(sendEvent);
    });
  });

  app.get('/api/outputs/:jobId/:filename', (req, res) => {
    const safeJobId = path.basename(req.params.jobId);
    const safeFilename = path.basename(req.params.filename);
    let targetPath = path.join(OUTPUT_DIR, safeJobId, safeFilename);

    if (!fs.existsSync(targetPath) && safeFilename.startsWith('source_input')) {
      const mappedLocal = localSourcePaths.get(safeJobId);
      if (mappedLocal && fs.existsSync(mappedLocal)) {
        targetPath = mappedLocal;
      }
    }

    const isAllowedOutput = targetPath.startsWith(OUTPUT_DIR);
    const isMappedLocal = targetPath === localSourcePaths.get(safeJobId);
    if ((!isAllowedOutput && !isMappedLocal) || !fs.existsSync(targetPath)) {
      res.status(404).json({ error: 'Output artifact not found' });
      return;
    }

    if (req.query.download === '1') {
      res.download(targetPath, safeFilename);
      return;
    }

    res.sendFile(targetPath);
  });

  app.get('/api/project-zip', async (_req, res, next) => {
    try {
      const rootDir = process.cwd();
      const zip = new JSZip();
      const projectFolder = zip.folder('sadavox-studio');
      if (!projectFolder) {
        throw new Error('Failed to initialize project archive.');
      }

      const rootFiles = [
        'package.json',
        'tsconfig.json',
        'vite.config.ts',
        'index.html',
        'metadata.json',
        '.env.example',
        '.gitignore',
        '.npmrc',
        'README.md',
        'electron-builder.yml',
        'SadaVox-Desktop.bat',
        'Build-Windows-EXE.bat',
        'SadaVox-Desktop.sh',
        'server.ts',
      ];

      for (const relPath of rootFiles) {
        const absPath = path.join(rootDir, relPath);
        if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
          const content = await fsp.readFile(absPath);
          projectFolder.file(relPath, content);
        }
      }

      const addDirRecursively = async (dirRelPath: string): Promise<void> => {
        const absDir = path.join(rootDir, dirRelPath);
        if (!fs.existsSync(absDir)) return;
        const entries = await fsp.readdir(absDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') {
            continue;
          }
          const childRel = path.posix.join(dirRelPath.split(path.sep).join('/'), entry.name);
          if (childRel === 'dist/assets/aistudio') {
            continue;
          }
          const childAbs = path.join(rootDir, childRel);
          if (entry.isDirectory()) {
            await addDirRecursively(childRel);
          } else if (entry.isFile()) {
            const content = await fsp.readFile(childAbs);
            projectFolder.file(childRel, content);
          }
        }
      };

      await addDirRecursively('server');
      await addDirRecursively('src');
      await addDirRecursively('electron');
      await addDirRecursively('scripts');
      await addDirRecursively('dist');
      await addDirRecursively('dist-desktop');

      const archiveBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="sadavox-studio-desktop.zip"');
      res.setHeader('Content-Length', String(archiveBuffer.length));
      res.send(archiveBuffer);
    } catch (error) {
      next(error);
    }
  });

  // Strict JSON boundaries for /api/* so Express/Vite never return HTML on API errors
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  app.use(
    '/api',
    (
      err: Error & { code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const msg =
        err?.code === 'LIMIT_FILE_SIZE'
          ? 'Uploaded file exceeds the 3 GB limit.'
          : err?.message || 'Unexpected server error while handling request.';
      res.status(400).json({ error: msg });
    }
  );

  const shouldUseVite =
    options.useViteDev ?? (process.env.NODE_ENV !== 'production' && !options.staticDistDir);

  if (shouldUseVite) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = options.staticDistDir || path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const listenPort = options.port ?? DEFAULT_PORT;
  const listenHost = options.host ?? '0.0.0.0';

  return await new Promise<{
    app: express.Express;
    server: ReturnType<express.Express['listen']>;
    port: number;
    outputDir: string;
  }>((resolve) => {
    const server = app.listen(listenPort, listenHost, () => {
      const addr = server.address();
      const resolvedPort = typeof addr === 'object' && addr ? addr.port : listenPort;
      console.log(`SadaVox Studio server running on http://${listenHost}:${resolvedPort}`);
      resolve({ app, server, port: resolvedPort, outputDir: OUTPUT_DIR });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 120_000;
  });
}

const isDirectEntry = (() => {
  if (process.env.SADAVOX_NO_AUTOSTART === '1' || !process.argv[1]) return false;
  try {
    return (
      typeof import.meta?.url === 'string' &&
      import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();

if (isDirectEntry) {
  void startStudioServer();
}
