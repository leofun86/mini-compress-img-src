
// server.mjs (secure v2 with per-file errors + modal UX support)
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'node:path';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import archiver from 'archiver';
import prettyBytes from 'pretty-bytes';
import pc from 'picocolors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import sharp from 'sharp';

import { compressBuffer } from './lib/compress.js';

const app = express();
const PORT = process.env.PORT || 3080;
const __dirname = path.resolve();
const TMP_ROOT = path.join(__dirname, 'tmp');

await fs.ensureDir(TMP_ROOT);

// Security headers
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "connect-src": ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// CORS (ajustar origin para producción)
app.use(cors({ origin: true }));

// Rate limits
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false });
const dlLimiter = rateLimit({ windowMs: 60 * 1000, max: 24, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);
app.use(['/download', '/zip'], dlLimiter);

// Static UI
app.use('/', express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  etag: true,
  cacheControl: true
}));

// Multer: permitir cualquier mimetype; validar después con sharp.metadata()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 20 } // 20MB/file, máx 20 archivos
});

// Jobs con token firmado y expiración
const jobs = new Map();
const JOB_TTL_MS = 1000 * 60 * 60; // 1h

function newJob() {
  const jobId = uuidv4();
  const token = crypto.randomBytes(16).toString('hex');
  const meta = { token, expires: Date.now() + JOB_TTL_MS, files: new Set() };
  jobs.set(jobId, meta);
  return { jobId, token, meta };
}

function assertJobAndToken(jobId, token) {
  const j = jobs.get(jobId);
  if (!j || j.expires < Date.now()) {
    jobs.delete(jobId);
    throw new Error('Job inexistente o expirado');
  }
  if (!token || token !== j.token) throw new Error('Token inválido');
  return j;
}

async function validateImageBuffer(buf) {
  const meta = await sharp(buf).metadata();
  if (!meta || !meta.format) throw new Error('Archivo no es una imagen válida');
  return meta.format;
}

// API de compresión con errores por archivo
app.post('/api/compress', upload.fields([{ name: 'images' }, { name: 'profileRef', maxCount: 1 }]), async (req, res) => {
  try {
    const format = (req.body.format || 'webp').toLowerCase();
    const quality = Math.max(1, Math.min(Number(req.body.quality || 78), 100));

    const images = (req.files?.images || []).filter(f => !!f && !!f.buffer);
    if (!images.length) return res.status(400).json({ error: 'No se recibieron archivos.' });
    if (images.length > 20) return res.status(413).json({ error: 'Máximo 20 archivos por solicitud.' });

    let iccBuffer = null;
    if (req.files?.profileRef?.[0]) {
      try {
        const meta = await sharp(req.files.profileRef[0].buffer).metadata();
        if (meta.icc) iccBuffer = Buffer.from(meta.icc);
      } catch {}
    }

    const { jobId, token, meta: jobMeta } = newJob();
    const jobDir = path.join(TMP_ROOT, jobId);
    await fs.ensureDir(jobDir);

    const results = [];
    const errors = [];

    for (const file of images) {
      const originalName = file.originalname || 'archivo';
      try {
        await validateImageBuffer(file.buffer);

        const base = path.parse(originalName).name;
        const { outBuffer, outExt, originalBytes, outBytes, savedBytes } = await compressBuffer(file.buffer, { format, quality, iccBuffer });
        const outName = `${base}.${outExt}`;
        const outPath = path.join(jobDir, outName);
        await fs.writeFile(outPath, outBuffer);
        jobMeta.files.add(outName);

        results.push({
          jobId, token, originalName, outputName: outName,
          originalBytes, outputBytes: outBytes, savedBytes,
          savedHuman: savedBytes > 0 ? prettyBytes(savedBytes) : 'sin mejora',
          url: `/download/${jobId}/${encodeURIComponent(outName)}?t=${token}`
        });
      } catch (e) {
        errors.push({
          file: originalName,
          friendly: 'Este archivo no se pudo procesar. Solo se admiten imágenes válidas (JPG, PNG, WebP, AVIF) o el archivo podría estar dañado.',
          technical: (e && e.message) ? String(e.message) : 'Error desconocido'
        });
      }
      await new Promise(r => setTimeout(r, 5));
    }

    const payload = { jobId, token, count: results.length, results, errors, expiresInMs: JOB_TTL_MS };
    if (results.length) payload.zipUrl = `/zip/${jobId}?t=${token}`;
    res.json(payload);
  } catch (err) {
    console.error(pc.red(err.stack || err.message));
    res.status(400).json({ error: err.message || 'Solicitud inválida' });
  }
});

// Descargas con token
app.get('/download/:jobId/:file', async (req, res) => {
  try {
    const job = assertJobAndToken(req.params.jobId, req.query.t);
    const file = req.params.file;
    if (!job.files.has(file)) return res.status(404).send('Archivo no encontrado para este job.');

    const filePath = path.join(TMP_ROOT, req.params.jobId, file);
    if (!await fs.pathExists(filePath)) return res.status(404).send('Archivo no encontrado.');
    res.download(filePath);
  } catch {
    res.status(403).send('No autorizado o enlace vencido.');
  }
});

app.get('/zip/:jobId', async (req, res) => {
  try {
    const job = assertJobAndToken(req.params.jobId, req.query.t);
    const jobDir = path.join(TMP_ROOT, req.params.jobId);
    if (!await fs.pathExists(jobDir)) return res.status(404).send('Job no encontrado.');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="compressed_${req.params.jobId}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', () => { try { res.end(); } catch {} });
    archive.pipe(res);
    for (const name of job.files) archive.file(path.join(jobDir, name), { name });
    await archive.finalize();
  } catch {
    res.status(403).send('No autorizado o enlace vencido.');
  }
});

// Limpieza periódica
setInterval(async () => {
  try {
    for (const [id, meta] of jobs) {
      if (meta.expires < Date.now()) {
        const dir = path.join(TMP_ROOT, id);
        await fs.remove(dir).catch(()=>{});
        jobs.delete(id);
      }
    }
    const dirs = await fs.readdir(TMP_ROOT);
    for (const d of dirs) {
      const full = path.join(TMP_ROOT, d);
      const stat = await fs.stat(full);
      if (stat.isDirectory() && (Date.now() - stat.mtimeMs > 1000*60*60*4)) {
        await fs.remove(full).catch(()=>{});
      }
    }
  } catch {}
}, 1000 * 60 * 10);

app.listen(PORT, () => {
  console.log(pc.green(`🔒 TinyPNG-like (secure v2) en http://localhost:${PORT}`));
});
