import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

async function userOwnsSite(userId, siteId) {
  const site = await prisma.site.findFirst({ where: { id: siteId, ownerId: userId } });
  return !!site;
}

async function resolveSiteId(req) {
  if (req.query.siteId) return req.query.siteId;
  const site = await prisma.site.findFirst({ where: { ownerId: req.user.id } });
  return site?.id;
}

// GET /api/suggestions
// Qayıdır: cavablanmamış və ya operator tərəfindən cavablanmış, amma
// Knowledge-də olmayan sual-cavabların siyahısı.
router.get("/", requireAuth, async (req, res) => {
  const siteId = await resolveSiteId(req);
  if (!siteId) return res.json([]);
  if (!(await userOwnsSite(req.user.id, siteId))) return res.status(403).json({ error: "Forbidden" });

  // Son 60 gündə PENDING_HUMAN və ya agent cavablanmış söhbətlər
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const conversations = await prisma.conversation.findMany({
    where: {
      siteId,
      createdAt: { gte: since },
      status: { in: ["PENDING_HUMAN", "SOLVED", "OPEN"] },
      addedToKnowledge: false,
    },
    include: {
      contact: { select: { id: true, name: true, email: true, phone: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, from: true, text: true, createdAt: true },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const suggestions = [];
  for (const conv of conversations) {
    // Son ziyarətçi sualını tap
    const msgs = conv.messages;
    let lastVisitor = null;
    let lastAgentAfter = null;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].from === "VISITOR" && msgs[i].text?.trim()) {
        lastVisitor = msgs[i];
      }
    }
    if (!lastVisitor) continue;

    // Ziyarətçi sualından sonrakı ilk agent cavabını tap
    const lastVisitorIdx = msgs.findIndex((m) => m.id === lastVisitor.id);
    for (let i = lastVisitorIdx + 1; i < msgs.length; i++) {
      if (msgs[i].from === "AGENT" && msgs[i].text?.trim()) {
        lastAgentAfter = msgs[i];
        break;
      }
    }

    suggestions.push({
      id: conv.id,
      conversationId: conv.id,
      question: lastVisitor.text.trim(),
      answer: lastAgentAfter?.text?.trim() || null,
      status: conv.status,
      answered: !!lastAgentAfter,
      contact: conv.contact,
      createdAt: lastVisitor.createdAt,
    });
  }

  // Son sualın tarixinə görə sırala
  suggestions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(suggestions);
});

// POST /api/suggestions/:id/dismiss — siyahıdan gizlət
router.post("/:id/dismiss", requireAuth, async (req, res) => {
  const conv = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conv) return res.status(404).json({ error: "Not found" });
  if (!(await userOwnsSite(req.user.id, conv.siteId))) return res.status(403).json({ error: "Forbidden" });
  await prisma.conversation.update({ where: { id: conv.id }, data: { addedToKnowledge: true } });
  res.json({ ok: true });
});

// POST /api/suggestions/:id/add-to-knowledge — KB entry yarat və conversation-ı işarələ
router.post("/:id/add-to-knowledge", requireAuth, async (req, res) => {
  const { title, content, tags } = req.body || {};
  if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: "title və content tələb olunur" });

  const conv = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!conv) return res.status(404).json({ error: "Not found" });
  if (!(await userOwnsSite(req.user.id, conv.siteId))) return res.status(403).json({ error: "Forbidden" });

  const [entry] = await prisma.$transaction([
    prisma.knowledgeEntry.create({
      data: {
        siteId: conv.siteId,
        title: title.trim(),
        content: content.trim(),
        tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
        status: "ACTIVE",
        source: "MANUAL",
      },
    }),
    prisma.conversation.update({ where: { id: conv.id }, data: { addedToKnowledge: true } }),
  ]);

  res.json({ ok: true, entry });
});

export default router;
