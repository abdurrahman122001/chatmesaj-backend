import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { searchKnowledge } from "../lib/knowledge.js";
import { scrapeUrl } from "../lib/scraper.js";

const router = Router();

// Sadə CSV parser (title,content[,tags,url]).
// Vergül/ifadə dırnaq içərisini də dəstəkləyir.
function parseCSV(text) {
  const rows = [];
  let cur = [];
  let field = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
      else if (c === "\r") {} // skip
      else field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

async function userOwnsSite(userId, siteId) {
  const site = await prisma.site.findFirst({ where: { id: siteId, ownerId: userId } });
  return !!site;
}

async function resolveSiteId(req) {
  if (req.query.siteId) return req.query.siteId;
  // default: istifadəçinin ilk site-ı
  const site = await prisma.site.findFirst({ where: { ownerId: req.user.id } });
  return site?.id;
}

// GET /api/knowledge?siteId=...&q=...
router.get("/", requireAuth, async (req, res) => {
  const siteId = await resolveSiteId(req);
  if (!siteId) return res.json([]);
  if (!(await userOwnsSite(req.user.id, siteId))) return res.status(403).json({ error: "Forbidden" });

  const where = { siteId };
  if (req.query.status) where.status = req.query.status;

  const list = await prisma.knowledgeEntry.findMany({
    where,
    orderBy: { updatedAt: "desc" },
  });
  res.json(list);
});

router.post("/", requireAuth, async (req, res) => {
  const { siteId: rawSiteId, title, content, url, source = "MANUAL", tags = [], status = "ACTIVE" } = req.body;
  const siteId = rawSiteId || (await resolveSiteId(req));
  if (!siteId) return res.status(400).json({ error: "siteId required" });
  if (!(await userOwnsSite(req.user.id, siteId))) return res.status(403).json({ error: "Forbidden" });
  if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: "title and content required" });

  const entry = await prisma.knowledgeEntry.create({
    data: { siteId, title: title.trim(), content: content.trim(), url: url || null, source, tags, status },
  });
  res.json(entry);
});

router.patch("/:id", requireAuth, async (req, res) => {
  const existing = await prisma.knowledgeEntry.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!(await userOwnsSite(req.user.id, existing.siteId))) return res.status(403).json({ error: "Forbidden" });

  const { title, content, url, tags, status } = req.body;
  const updated = await prisma.knowledgeEntry.update({
    where: { id: req.params.id },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  });
  res.json(updated);
});

router.delete("/:id", requireAuth, async (req, res) => {
  const existing = await prisma.knowledgeEntry.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!(await userOwnsSite(req.user.id, existing.siteId))) return res.status(403).json({ error: "Forbidden" });

  await prisma.knowledgeEntry.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// Admin test endpoint: axtarışı yoxla
router.get("/search", requireAuth, async (req, res) => {
  const siteId = await resolveSiteId(req);
  if (!siteId) return res.json({ matches: [], bestScore: 0 });
  const result = await searchKnowledge(siteId, (req.query.q || "").toString());
  res.json(result);
});

// URL-dən scrape et və knowledge entry yarat
router.post("/scrape", requireAuth, async (req, res) => {
  const { url, siteId: rawSiteId } = req.body;
  const siteId = rawSiteId || (await resolveSiteId(req));
  if (!siteId) return res.status(400).json({ error: "siteId required" });
  if (!(await userOwnsSite(req.user.id, siteId))) return res.status(403).json({ error: "Forbidden" });

  try {
    const { title, content } = await scrapeUrl(url);
    const entry = await prisma.knowledgeEntry.create({
      data: { siteId, title, content, url, source: "URL", status: "ACTIVE", tags: [] },
    });
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message || "Scrape failed" });
  }
});

// CSV import — body: { csv: "title,content,tags,url\n..." }
router.post("/import-csv", requireAuth, async (req, res) => {
  const { csv, siteId: rawSiteId } = req.body;
  const siteId = rawSiteId || (await resolveSiteId(req));
  if (!siteId) return res.status(400).json({ error: "siteId required" });
  if (!(await userOwnsSite(req.user.id, siteId))) return res.status(403).json({ error: "Forbidden" });
  if (!csv?.trim()) return res.status(400).json({ error: "CSV boşdur" });

  const rows = parseCSV(csv);
  if (!rows.length) return res.status(400).json({ error: "Heç bir sətir tapılmadı" });

  // İlk sətir header-dirsə skip
  let startIdx = 0;
  const first = rows[0].map((c) => c.trim().toLowerCase());
  if (first.includes("title") && first.includes("content")) startIdx = 1;

  const created = [];
  for (let i = startIdx; i < rows.length; i++) {
    const [title, content, tagsStr, url] = rows[i];
    if (!title?.trim() || !content?.trim()) continue;
    const tags = (tagsStr || "").split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
    const entry = await prisma.knowledgeEntry.create({
      data: {
        siteId,
        title: title.trim(),
        content: content.trim(),
        url: url?.trim() || null,
        tags,
        source: "IMPORT",
        status: "ACTIVE",
      },
    });
    created.push(entry);
  }
  res.json({ count: created.length, entries: created });
});

export default router;
