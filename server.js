import express from "express";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import sanitize from "sanitize-filename";
import archiver from "archiver";
import sharp from "sharp";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// 🧩 Render proxy configuration
app.set("trust proxy", 1);

// 🌍 CORS (permitir frontend desde GitHub Pages y tu dominio Render)
app.use(
  cors({
    origin: [
      "https://leofun86.github.io/", // ⚠️ ← cambia esto por tu dominio real de GitHub Pages
      "https://mini-compress-img-src.onrender.com"
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
  })
);

// 🛡️ Seguridad general
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "connect-src": ["'self'", "https://mini-compress-img-src.onrender.com"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);
app.use(compression());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// 🚦 Rate limit (protege contra spam)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// 📁 Rutas de archivos
const DIST = path.join(__dirname, "dist");
const DOWNLOADS = path.join(DIST, "downloads");
fs.mkdirSync(DOWNLOADS, { recursive: true });
app.use(express.static(DIST, { fallthrough: true }));

// ⚙️ Configuración Multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/avif"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("Tipo de archivo no permitido"));
    cb(null, true);
  }
});

// 🧠 Verificación de firma real del archivo
async function validateMagic(buffer) {
  const ft = await fileTypeFromBuffer(buffer);
  if (!ft) return null;
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/avif"];
  if (!allowed.includes(ft.mime)) return null;
  return ft;
}

function safeName(original, ext) {
  const base = sanitize(path.parse(original).name) || "image";
  return `${base}-${uuidv4().slice(0, 8)}.${ext}`;
}

// 🧩 Endpoint principal de compresión
app.post("/api/compress", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No se recibió archivo" });

    const detected = await validateMagic(req.file.buffer);
    if (!detected) return res.status(415).json({ ok: false, error: "Archivo no soportado o corrupto" });

    const format = (req.body.format || "webp").toLowerCase();
    const allowedFormats = ["jpg", "jpeg", "png", "webp", "avif"];
    if (!allowedFormats.includes(format)) return res.status(400).json({ ok: false, error: "Formato solicitado inválido" });

    const targetFormat = format === "jpeg" ? "jpg" : format;
    const quality = Math.min(100, Math.max(40, parseInt(req.body.quality || "80", 10) || 80));

    const image = sharp(req.file.buffer, { failOn: "warning" });
    const meta = await image.metadata();

    const MAX_DIM = 6000;
    let pipeline = image.rotate();
    if ((meta.width || 0) > MAX_DIM || (meta.height || 0) > MAX_DIM) {
      pipeline = pipeline.resize({
        width: Math.min(meta.width || MAX_DIM, MAX_DIM),
        height: Math.min(meta.height || MAX_DIM, MAX_DIM),
        fit: "inside",
        withoutEnlargement: true
      });
    }

    // 📦 Procesar según formato
    switch (targetFormat) {
      case "jpg":
        pipeline = pipeline.jpeg({ quality, mozjpeg: true });
        break;
      case "png":
        pipeline = pipeline.png({ compressionLevel: 9 });
        break;
      case "webp":
        pipeline = pipeline.webp({ quality });
        break;
      case "avif":
        pipeline = pipeline.avif({ quality });
        break;
    }

    const outBuffer = await pipeline.toBuffer();
    const outExt = targetFormat === "jpg" ? "jpg" : targetFormat;
    const safe = safeName(req.file.originalname, outExt);
    const outPath = path.join(DOWNLOADS, safe);
    fs.writeFileSync(outPath, outBuffer);

    res.json({
      ok: true,
      filename: safe,
      url: `/downloads/${safe}`,
      bytesIn: req.file.size,
      bytesOut: outBuffer.length
    });
  } catch (err) {
    console.error("compress error:", err);
    res.status(500).json({ ok: false, error: "Error interno de compresión" });
  }
});

// 🧩 Endpoint para generar ZIP
app.post("/api/zip", async (req, res) => {
  try {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const files = parsed.files || [];
        if (!Array.isArray(files) || files.length === 0)
          return res.status(400).json({ ok: false, error: "Lista de archivos vacía" });

        const zipName = `batch-${uuidv4().slice(0, 8)}.zip`;
        const zipPath = path.join(DOWNLOADS, zipName);

        const output = fs.createWriteStream(zipPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        archive.pipe(output);

        for (const f of files) {
          const base = path.basename(f);
          const full = path.join(DOWNLOADS, base);
          if (fs.existsSync(full)) archive.file(full, { name: base });
        }

        archive.finalize();

        output.on("close", () => {
          res.json({ ok: true, zip: `/downloads/${zipName}`, size: archive.pointer() });
        });
      } catch (e) {
        res.status(400).json({ ok: false, error: "JSON inválido" });
      }
    });
  } catch (err) {
    console.error("zip error:", err);
    res.status(500).json({ ok: false, error: "Error interno al crear ZIP" });
  }
});

// 🎯 Fallback para el frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(DIST, "index.html"));
});

// 🛡️ Manejo de errores global
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).send("Error interno del servidor.");
});

// 🚀 Iniciar servidor
app.listen(PORT, () => {
  console.log(`🔐 Servidor activo en Render (puerto ${PORT})`);
});
