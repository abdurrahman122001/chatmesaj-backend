import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { searchKnowledge, searchProducts, formatBotAnswer, formatProductAnswer } from "../lib/knowledge.js";

const router = Router();

async function resolveSite(req) {
  if (req.query.siteId || req.body.siteId) {
    const id = req.query.siteId || req.body.siteId;
    return prisma.site.findFirst({ where: { id, ownerId: req.user.id } });
  }
  return prisma.site.findFirst({ where: { ownerId: req.user.id }, orderBy: { createdAt: "asc" } });
}

// POST /api/playground/test
// Body: { message, mode?: "live" | "email" }
// Real KB və products istifadə edib cavab qaytarır. Heç nəyə save etmir.
router.post("/test", requireAuth, async (req, res) => {
  const message = String(req.body?.message || "").trim();
  const mode = req.body?.mode === "email" ? "email" : "live";
  if (!message) return res.status(400).json({ error: "message tələb olunur" });

  const site = await resolveSite(req);
  if (!site) return res.status(404).json({ error: "Site tapılmadı" });

  const settings = (site.settings && typeof site.settings === "object") ? site.settings : {};
  const agentName = settings.agentName || "Lyro";
  const companyDescription = settings.companyDescription || "";

  const [kb, prod] = await Promise.all([
    searchKnowledge(site.id, message),
    searchProducts(site.id, message),
  ]);
  const kbMatches = kb.matches || [];
  const prodMatches = prod.matches || [];
  const found = kbMatches.length > 0 || prodMatches.length > 0;

  let answer = null;
  if (found) {
    const parts = [];
    if (kbMatches.length) parts.push(formatBotAnswer(kbMatches));
    if (prodMatches.length) parts.push(formatProductAnswer(prodMatches));
    answer = parts.filter(Boolean).join("\n\n---\n\n");
  } else {
    // Fallback cavab
    answer = mode === "email"
      ? `Salam,\n\nMüraciətiniz üçün təşəkkür edirik. Hazırda bu sual üçün bilgi bazamızda dəqiq cavab tapılmadı. Komandamız tezliklə sizinlə əlaqə saxlayacaq.\n\nHörmətlə,\n${agentName}${companyDescription ? `\n${companyDescription}` : ""}`
      : `Bağışlayın, bu suala cavab tapa bilmədim. Operator tezliklə sizinlə əlaqə saxlayacaq.`;
  }

  res.json({
    answer,
    found,
    matches: {
      knowledge: kbMatches.map((m) => ({ id: m.id, title: m.title, score: m.score })),
      products: prodMatches.map((p) => ({ id: p.id, name: p.name, score: p.score })),
    },
    agentName,
    mode,
  });
});

// GET /api/playground/prompts — son ziyarətçi suallarından nümunələr
router.get("/prompts", requireAuth, async (req, res) => {
  const mode = req.query.mode === "email" ? "email" : "live";
  const site = await resolveSite(req);
  if (!site) return res.json([]);

  // Knowledge entries və products-dan title-ları nümunə kimi göstər
  const [entries, products] = await Promise.all([
    prisma.knowledgeEntry.findMany({
      where: { siteId: site.id, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      select: { title: true },
    }),
    prisma.product.findMany({
      where: { siteId: site.id, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      select: { name: true },
    }),
  ]);

  const prompts = [];
  for (const e of entries) {
    const t = e.title.replace(/\?+$/, "");
    prompts.push(mode === "email" ? `${t} haqqında məlumat verə bilərsinizmi?` : `${t}?`);
  }
  for (const p of products) {
    prompts.push(mode === "email" ? `${p.name} mövcuddurmu?` : `${p.name} qiyməti?`);
  }

  // Fallback nümunələr
  if (prompts.length === 0) {
    prompts.push(
      "Çatdırılma nə qədər vaxt aparır?",
      "İş saatlarınız nədir?",
      "Geri qaytarma siyasətiniz necədir?",
    );
  }

  res.json(prompts);
});

export default router;
