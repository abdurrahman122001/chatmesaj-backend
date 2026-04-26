import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 10);

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const hash = crypto.randomBytes(12).toString("hex");
    cb(null, `${Date.now()}-${hash}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

const router = Router();

// Public upload (widget də istifadə edir). Auth yoxdur çünki visitor tərəfindən çağırılır.
// Real production-da nisbi rate limit + apiKey yoxlaması əlavə edin.
router.post("/", upload.array("files", 5), (req, res) => {
  const files = (req.files || []).map((f) => ({
    name: f.originalname,
    size: f.size,
    type: f.mimetype,
    url: `/uploads/${f.filename}`,
  }));
  res.json(files);
});

export default router;
