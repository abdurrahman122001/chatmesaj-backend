import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { scrapeProductUrl } from "../lib/productScraper.js";

const router = Router();

// Sadə CSV parser (dırnaq dəstəkli)
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
  const site = await prisma.site.findFirst({ where: { ownerId: req.user.id } });
  return site?.id;
}

function parsePrice(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.,-]/g, "").replace(",", "."));
  return isNaN(n) ? null : n;
}

// GET /api/products?siteId=...&status=...
router.get("/", requireAuth, async (req, res) => {
  const siteId = await resolveSiteId(req);
  if (!siteId) return res.json([]);
  if (!(await userOwnsSite(req.user.id, siteId))) return res.status(403).json({ error: "Forbidden" });

  const where = { siteId };
  if (req.query.status) where.status = req.query.status;

  const list = await prisma.product.findMany({
    where,
    orderBy: { updatedAt: "desc" },
  });
  res.json(list);
});

router.post("/", requireAuth, async (req, res) => {
  const { siteId: rawSiteId, name, description, price, currency, imageUrl, url, sku, tags = [], status = "ACTIVE", source = "MANUAL" } = req.body;
  const siteId = rawSiteId || (await resolveSiteId(req));
  if (!siteId) return res.status(400).json({ error: "siteId required" });
  if (!(await userOwnsSite(req.user.id, siteId))) return res.status(403).json({ error: "Forbidden" });
  if (!name?.trim()) return res.status(400).json({ error: "name required" });

  const product = await prisma.product.create({
    data: {
      siteId,
      name: name.trim(),
      description: (description || "").trim(),
      price: parsePrice(price),
      currency: currency || "AZN",
      imageUrl: imageUrl || null,
      url: url || null,
      sku: sku || null,
      tags: Array.isArray(tags) ? tags : [],
      source,
      status,
    },
  });
  res.json(product);
});

router.patch("/:id", requireAuth, async (req, res) => {
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!(await userOwnsSite(req.user.id, existing.siteId))) return res.status(403).json({ error: "Forbidden" });

  const { name, description, price, currency, imageUrl, url, sku, tags, status } = req.body;
  const updated = await prisma.product.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(price !== undefined ? { price: parsePrice(price) } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(imageUrl !== undefined ? { imageUrl } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(sku !== undefined ? { sku } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  });
  res.json(updated);
});

router.delete("/:id", requireAuth, async (req, res) => {
  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!(await userOwnsSite(req.user.id, existing.siteId))) return res.status(403).json({ error: "Forbidden" });

  await prisma.product.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// URL-dən məhsul scrape et
router.post("/scrape", requireAuth, async (req, res) => {
  const { url, siteId: rawSiteId } = req.body;
  const siteId = rawSiteId || (await resolveSiteId(req));
  if (!siteId) return res.status(400).json({ error: "siteId required" });
  if (!(await userOwnsSite(req.user.id, siteId))) return res.status(403).json({ error: "Forbidden" });

  try {
    const p = await scrapeProductUrl(url);
    const product = await prisma.product.create({
      data: {
        siteId,
        name: p.name,
        description: p.description || "",
        price: p.price,
        currency: p.currency || "AZN",
        imageUrl: p.imageUrl,
        url: p.url,
        sku: p.sku,
        tags: [],
        source: "URL",
        status: "ACTIVE",
      },
    });
    res.json(product);
  } catch (err) {
    res.status(400).json({ error: err.message || "Scrape failed" });
  }
});

// CSV import — body: { csv }
// Sütunlar: name,description,price,currency,imageUrl,url,sku,tags
router.post("/import-csv", requireAuth, async (req, res) => {
  const { csv, siteId: rawSiteId } = req.body;
  const siteId = rawSiteId || (await resolveSiteId(req));
  if (!siteId) return res.status(400).json({ error: "siteId required" });
  if (!(await userOwnsSite(req.user.id, siteId))) return res.status(403).json({ error: "Forbidden" });
  if (!csv?.trim()) return res.status(400).json({ error: "CSV boşdur" });

  const rows = parseCSV(csv);
  if (!rows.length) return res.status(400).json({ error: "Heç bir sətir tapılmadı" });

  // Header tapmaq (ilk sətir)
  const headerCandidates = ["name", "description", "price", "currency", "imageurl", "url", "sku", "tags"];
  const first = rows[0].map((c) => c.trim().toLowerCase());
  let headerMap = null;
  let startIdx = 0;
  if (first.some((h) => headerCandidates.includes(h))) {
    headerMap = first;
    startIdx = 1;
  } else {
    // Default sıra
    headerMap = ["name", "description", "price", "currency", "imageurl", "url", "sku", "tags"];
  }

  function col(row, key) {
    const idx = headerMap.indexOf(key);
    return idx >= 0 ? (row[idx] || "").trim() : "";
  }

  const created = [];
  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i];
    const name = col(row, "name");
    if (!name) continue;
    const tagsStr = col(row, "tags");
    const tags = tagsStr ? tagsStr.split(/[,;|]/).map((t) => t.trim()).filter(Boolean) : [];
    const product = await prisma.product.create({
      data: {
        siteId,
        name,
        description: col(row, "description"),
        price: parsePrice(col(row, "price")),
        currency: col(row, "currency") || "AZN",
        imageUrl: col(row, "imageurl") || null,
        url: col(row, "url") || null,
        sku: col(row, "sku") || null,
        tags,
        source: "IMPORT",
        status: "ACTIVE",
      },
    });
    created.push(product);
  }
  res.json({ count: created.length, products: created });
});

export default router;
