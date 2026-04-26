import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

async function getOwnedSiteIds(userId) {
  const sites = await prisma.site.findMany({ where: { ownerId: userId }, select: { id: true } });
  return sites.map((s) => s.id);
}

function daysBuckets(days, raw) {
  const today = new Date();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setHours(0, 0, 0, 0);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const match = raw.find((x) => new Date(x.day).toISOString().slice(0, 10) === key);
    out.push({ day: d.toISOString(), count: match ? Number(match.count) : 0 });
  }
  return out;
}

// Human support: söhbətlər operatora keçdi, ortalama reaksiya vaxtı, agent üzrə bölgü
router.get("/human", requireAuth, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
  const type = req.query.type || "live";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const siteIds = await getOwnedSiteIds(req.user.id);
  if (!siteIds.length) return res.json({ days, type, conversations: 0, replied: 0, firstResponseMs: null, avgResponseMs: null, perDay: [], byAgent: [] });

  // --- Tickets analytics ---
  if (type === "tickets") {
    const tickets = await prisma.ticket.findMany({
      where: { siteId: { in: siteIds }, createdAt: { gte: since } },
      include: { contact: { select: { id: true, name: true, email: true } }, assignee: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
    const total = tickets.length;
    const byStatus = {};
    const byPriority = {};
    const perDayMap = {};
    const byAssignee = {};
    for (const t of tickets) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
      const day = new Date(t.createdAt).toISOString().slice(0, 10);
      perDayMap[day] = (perDayMap[day] || 0) + 1;
      if (t.assignee) {
        const key = t.assignee.id;
        if (!byAssignee[key]) byAssignee[key] = { name: t.assignee.name, count: 0 };
        byAssignee[key].count++;
      }
    }
    const perDayRaw = Object.entries(perDayMap).map(([day, count]) => ({ day, count }));
    const perDay = daysBuckets(days, perDayRaw);
    const recent = tickets.slice(0, 20).map((t) => ({
      id: t.id, subject: t.subject, status: t.status, priority: t.priority,
      contact: t.contact, assignee: t.assignee, createdAt: t.createdAt,
    }));
    return res.json({ days, type: "tickets", total, byStatus, byPriority, perDay, byAssignee: Object.values(byAssignee).sort((a, b) => b.count - a.count), recent });
  }

  // --- Ratings analytics ---
  if (type === "ratings") {
    const convs = await prisma.conversation.findMany({
      where: { siteId: { in: siteIds }, rating: { not: null }, updatedAt: { gte: since } },
      include: { contact: { select: { id: true, name: true, email: true } } },
      orderBy: { updatedAt: "desc" },
    });
    const total = convs.length;
    const avgRating = total ? (convs.reduce((s, c) => s + c.rating, 0) / total).toFixed(1) : 0;
    const byRating = {};
    const perDayMap = {};
    const recent = convs.slice(0, 20).map((c) => ({
      id: c.id, rating: c.rating, ratingComment: c.ratingComment,
      contact: c.contact, status: c.status, updatedAt: c.updatedAt,
    }));
    for (const c of convs) {
      byRating[c.rating] = (byRating[c.rating] || 0) + 1;
      const day = new Date(c.updatedAt).toISOString().slice(0, 10);
      perDayMap[day] = (perDayMap[day] || 0) + 1;
    }
    const perDayRaw = Object.entries(perDayMap).map(([day, count]) => ({ day, count }));
    const perDay = daysBuckets(days, perDayRaw);
    return res.json({ days, type: "ratings", total, avgRating, byRating, perDay, recent });
  }

  // --- Live conversations ---
  const statusFilter = ["OPEN", "PENDING_HUMAN"];
  const conversations = await prisma.conversation.findMany({
    where: {
      siteId: { in: siteIds },
      createdAt: { gte: since },
      status: { in: statusFilter },
    },
    include: {
      messages: { orderBy: { createdAt: "asc" }, select: { id: true, from: true, authorId: true, createdAt: true } },
      assignee: { select: { id: true, name: true, email: true } },
    },
  });

  const humanConvs = conversations.filter((c) => c.messages.some((m) => m.from === "AGENT"));
  let replied = 0;
  const responseMs = [];
  let firstResponseMs = null;
  const perDayMap = {};
  const agentMap = {};

  for (const c of humanConvs) {
    const firstVisitor = c.messages.find((m) => m.from === "VISITOR");
    const firstAgent = c.messages.find((m) => m.from === "AGENT");
    if (firstVisitor && firstAgent && firstAgent.createdAt > firstVisitor.createdAt) {
      replied++;
      const diff = new Date(firstAgent.createdAt) - new Date(firstVisitor.createdAt);
      responseMs.push(diff);
      if (firstResponseMs === null || diff < firstResponseMs) firstResponseMs = diff;
    }
    const day = new Date(c.createdAt).toISOString().slice(0, 10);
    perDayMap[day] = (perDayMap[day] || 0) + 1;
    if (c.assignee) {
      const key = c.assignee.id;
      if (!agentMap[key]) agentMap[key] = { name: c.assignee.name || c.assignee.email, count: 0 };
      agentMap[key].count++;
    }
  }

  const avgResponseMs = responseMs.length ? Math.round(responseMs.reduce((a, b) => a + b, 0) / responseMs.length) : null;
  const perDayRaw = Object.entries(perDayMap).map(([day, count]) => ({ day, count }));
  const perDay = daysBuckets(days, perDayRaw);
  const byAgent = Object.values(agentMap).sort((a, b) => b.count - a.count);

  res.json({
    days,
    type: "live",
    conversations: humanConvs.length,
    replied,
    firstResponseMs,
    avgResponseMs,
    perDay,
    byAgent,
  });
});

// AI support: bot tərəfindən cavablandırılmış söhbətlər, transferlər, ən çox verilən suallar
// type: live | emails | knowledge
router.get("/ai", requireAuth, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
  const type = ["emails", "knowledge"].includes(req.query.type) ? req.query.type : "live";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const siteIds = await getOwnedSiteIds(req.user.id);
  if (!siteIds.length) {
    return res.json({
      days, type, aiConversations: 0, resolved: 0, resolutionRate: 0, transfers: 0,
      perDay: [], topQuestions: [], knowledgeEntries: [], knowledgeStats: { total: 0, active: 0, draft: 0 },
    });
  }

  // Knowledge performance: KB entries + statistika
  if (type === "knowledge") {
    const entries = await prisma.knowledgeEntry.findMany({
      where: { siteId: { in: siteIds } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, status: true, tags: true, createdAt: true, updatedAt: true },
    });
    const active = entries.filter((e) => e.status === "ACTIVE").length;
    const draft = entries.filter((e) => e.status === "DRAFT").length;
    return res.json({
      days, type,
      knowledgeStats: { total: entries.length, active, draft },
      knowledgeEntries: entries,
    });
  }

  // Emails mode: yalnız email-i olan kontaktlar
  const contactFilter = type === "emails" ? { email: { not: null } } : {};

  const conversations = await prisma.conversation.findMany({
    where: {
      siteId: { in: siteIds },
      createdAt: { gte: since },
      contact: contactFilter,
    },
    include: {
      messages: { orderBy: { createdAt: "asc" }, select: { from: true, text: true, createdAt: true } },
      contact: { select: { email: true } },
    },
  });

  let aiConvs = 0;
  let resolved = 0;
  let transfers = 0;
  const perDayMap = {};
  const questionFreq = {};

  for (const c of conversations) {
    const hasBot = c.messages.some((m) => m.from === "BOT");
    if (!hasBot) continue;
    aiConvs++;
    const hasAgent = c.messages.some((m) => m.from === "AGENT");
    if (c.status === "PENDING_HUMAN" || hasAgent) transfers++;
    else if (c.status === "SOLVED" || c.status === "BOT") resolved++;

    const day = new Date(c.createdAt).toISOString().slice(0, 10);
    perDayMap[day] = (perDayMap[day] || 0) + 1;

    // Ziyarətçi suallarını topla
    for (const m of c.messages) {
      if (m.from === "VISITOR" && m.text?.trim() && m.text.length > 3) {
        const q = m.text.trim().toLowerCase().slice(0, 120);
        questionFreq[q] = (questionFreq[q] || 0) + 1;
      }
    }
  }

  const perDayRaw = Object.entries(perDayMap).map(([day, count]) => ({ day, count }));
  const perDay = daysBuckets(days, perDayRaw);
  const topQuestions = Object.entries(questionFreq)
    .map(([q, c]) => ({ question: q, count: c }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const resolutionRate = aiConvs ? Math.round((resolved / aiConvs) * 100) : 0;

  res.json({ days, type, aiConversations: aiConvs, resolved, resolutionRate, transfers, perDay, topQuestions });
});

// Leads: yeni kontaktlar
router.get("/leads", requireAuth, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const siteIds = await getOwnedSiteIds(req.user.id);
  if (!siteIds.length) return res.json({ days, leadsAcquired: 0, newSubscribers: 0, conversionRate: 0, perDay: [], bySource: [] });

  const [allContacts, leadContacts, newSubscribers] = await Promise.all([
    prisma.contact.count({ where: { siteId: { in: siteIds }, createdAt: { gte: since } } }),
    prisma.contact.findMany({
      where: {
        siteId: { in: siteIds },
        createdAt: { gte: since },
        OR: [{ email: { not: null } }, { phone: { not: null } }],
      },
      select: { id: true, email: true, phone: true, country: true, countryName: true, createdAt: true },
    }),
    prisma.subscriber.count({ where: { siteId: { in: siteIds }, createdAt: { gte: since } } }),
  ]);

  const perDayMap = {};
  const sourceMap = {};
  for (const c of leadContacts) {
    const day = new Date(c.createdAt).toISOString().slice(0, 10);
    perDayMap[day] = (perDayMap[day] || 0) + 1;
    const src = c.countryName || c.country || "Naməlum";
    sourceMap[src] = (sourceMap[src] || 0) + 1;
  }
  const perDayRaw = Object.entries(perDayMap).map(([day, count]) => ({ day, count }));
  const perDay = daysBuckets(days, perDayRaw);
  const bySource = Object.entries(sourceMap).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);

  const conversionRate = allContacts ? Math.round((leadContacts.length / allContacts) * 100) : 0;

  res.json({
    days,
    leadsAcquired: leadContacts.length,
    newSubscribers,
    conversionRate,
    perDay,
    bySource,
  });
});

router.get("/", requireAuth, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const sites = await prisma.site.findMany({ where: { ownerId: req.user.id }, select: { id: true } });
  const siteIds = sites.map((s) => s.id);
  if (!siteIds.length) {
    return res.json({ days, totalContacts: 0, totalConversations: 0, byStatus: {}, byDay: [], topCountries: [], botVsHuman: { bot: 0, agent: 0, visitor: 0 }, knowledgeCount: 0 });
  }

  const [totalContacts, totalConversations, byStatusRaw, byDayRaw, topCountriesRaw, msgByFromRaw, knowledgeCount] = await Promise.all([
    prisma.contact.count({ where: { siteId: { in: siteIds } } }),
    prisma.conversation.count({ where: { siteId: { in: siteIds } } }),
    prisma.conversation.groupBy({ by: ["status"], where: { siteId: { in: siteIds } }, _count: true }),
    prisma.$queryRawUnsafe(
      `SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS count
       FROM "Conversation"
       WHERE "siteId" = ANY($1) AND "createdAt" >= $2
       GROUP BY day ORDER BY day ASC`,
      siteIds,
      since
    ),
    prisma.contact.groupBy({
      by: ["countryName"],
      where: { siteId: { in: siteIds }, countryName: { not: null } },
      _count: true,
      orderBy: { _count: { countryName: "desc" } },
    }),
    prisma.$queryRawUnsafe(
      `SELECT m."from", COUNT(*)::int AS count
       FROM "Message" m
       JOIN "Conversation" c ON c.id = m."conversationId"
       WHERE c."siteId" = ANY($1) AND m."createdAt" >= $2
       GROUP BY m."from"`,
      siteIds,
      since
    ),
    prisma.knowledgeEntry.count({ where: { siteId: { in: siteIds }, status: "ACTIVE" } }),
  ]);

  const byStatus = Object.fromEntries(byStatusRaw.map((r) => [r.status, r._count]));
  const byDay = byDayRaw.map((r) => ({ day: r.day, count: Number(r.count) }));
  const topCountries = topCountriesRaw.map((r) => ({ country: r.countryName, count: r._count }));
  const botVsHuman = { bot: 0, agent: 0, visitor: 0, system: 0 };
  msgByFromRaw.forEach((r) => {
    const k = r.from?.toLowerCase();
    if (k in botVsHuman) botVsHuman[k] = Number(r.count);
  });

  res.json({ days, totalContacts, totalConversations, byStatus, byDay, topCountries, botVsHuman, knowledgeCount });
});

export default router;
