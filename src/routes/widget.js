import { Router } from "express";
import crypto from "crypto";
import { prisma } from "../db.js";
import { collectVisitorInfo } from "../lib/visitor.js";
import { searchKnowledge, formatBotAnswer, searchProducts, formatProductAnswer } from "../lib/knowledge.js";
import { notifyNewHumanRequest } from "../lib/mailer.js";
import { t as tI18n } from "../lib/i18n.js";

// Public endpoints — widget tərəfindən çağırılır, auth yoxdur, yalnız apiKey.
const router = Router();

async function getSiteByKey(apiKey) {
  if (!apiKey) return null;
  return prisma.site.findUnique({ where: { apiKey } });
}

// Widget config yüklənməsi
router.get("/config", async (req, res) => {
  const apiKey = req.query.apiKey;
  if (!apiKey) return res.status(400).json({ error: "apiKey required" });
  const site = await prisma.site.findUnique({
    where: { apiKey },
    include: { owner: { select: { name: true, avatarUrl: true } } },
  });
  if (!site) return res.status(404).json({ error: "Invalid site key" });

  const savedAppearance = site.appearance || {};
  const ownerName = site.owner?.name || "";

  // Title priority: if user explicitly set a custom title (not empty, not default "Dəstək"),
  // use it. Otherwise fall back to owner's name, then default.
  const rawTitle = (savedAppearance.title || "").trim();
  const isDefaultTitle = !rawTitle || rawTitle === "Dəstək" || rawTitle === "Support" || rawTitle === "Destek" || rawTitle === "Поддержка";
  const language = savedAppearance.language || "AZ";
  const title = isDefaultTitle ? (ownerName || tI18n("defaultTitle", language)) : rawTitle;

  const appearance = {
    brandColor: savedAppearance.brandColor || "#059669",
    brandColorDark: savedAppearance.brandColorDark || "#047857",
    title,
    subtitle: savedAppearance.subtitle || tI18n("defaultSubtitle", language),
    header: savedAppearance.header || "",
    message: savedAppearance.message || "",
    language,
  };

  res.json({
    siteId: site.id,
    name: site.name,
    quickActions: site.quickActions || {},
    agent: { name: ownerName, avatarUrl: site.owner?.avatarUrl || null },
    appearance,
  });
});

// Visitor session — ilk açılışda yaradılır (visitorToken brauzer localStorage-da saxlanılır)
router.post("/session", async (req, res) => {
  const { apiKey, visitorToken, metadata, currentUrl, referrer, language } = req.body;
  const site = await getSiteByKey(apiKey);
  if (!site) return res.status(404).json({ error: "Invalid site key" });

  const info = collectVisitorInfo(req, { currentUrl, referrer, language });

  let contact;
  if (visitorToken) {
    contact = await prisma.contact.findUnique({ where: { visitorToken } });
  }
  if (!contact) {
    const token = crypto.randomBytes(24).toString("hex");
    contact = await prisma.contact.create({
      data: {
        siteId: site.id,
        visitorToken: token,
        metadata: metadata || null,
        ...info,
      },
    });
  } else {
    contact = await prisma.contact.update({
      where: { id: contact.id },
      data: {
        lastSeenAt: new Date(),
        metadata: metadata || contact.metadata,
        // IP / cihaz məlumatlarını hər girişdə yenilə
        ip: info.ip || contact.ip,
        userAgent: info.userAgent || contact.userAgent,
        country: info.country || contact.country,
        countryName: info.countryName || contact.countryName,
        city: info.city || contact.city,
        region: info.region || contact.region,
        timezone: info.timezone || contact.timezone,
        browser: info.browser || contact.browser,
        os: info.os || contact.os,
        device: info.device || contact.device,
        referrer: info.referrer || contact.referrer,
        currentUrl: info.currentUrl || contact.currentUrl,
        language: info.language || contact.language,
      },
    });
  }

  // Aktiv söhbət tap (OPEN, BOT, PENDING_HUMAN hamısı aktivdir — yalnız SOLVED bağlıdır)
  let conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, status: { in: ["OPEN", "BOT", "PENDING_HUMAN"] } },
    orderBy: { updatedAt: "desc" },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { siteId: site.id, contactId: contact.id, channel: "chat" },
    });
  }

  conversation = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });

  const io = req.app.get("io");
  io.to(`site:${site.id}`).emit("visitor:session", {
    siteId: site.id,
    conversationId: conversation.id,
    contact,
    currentUrl: info.currentUrl || contact.currentUrl || null,
    referrer: info.referrer || contact.referrer || null,
    language: info.language || contact.language || null,
    at: new Date().toISOString(),
  });

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
  });

  if (messages.length === 0) {
    const language = site.appearance?.language || "AZ";
    const greetingText = (site.appearance?.message || "").trim() || tI18n("greeting", language);
    const greeting = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        from: "BOT",
        text: greetingText,
      },
    });
    messages.push(greeting);
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "BOT", updatedAt: new Date() } });
    io.to(`site:${site.id}`).emit("conversation:message", { conversationId: conversation.id, message: greeting, contact });
  }

  res.json({
    visitorToken: contact.visitorToken,
    siteId: site.id,
    contact: { id: contact.id, name: contact.name, email: contact.email, phone: contact.phone },
    conversation: { id: conversation.id, status: conversation.status, siteId: site.id },
    messages,
    quickActions: site.quickActions || {},
  });
});

// Visitor mesaj göndərir
router.post("/message", async (req, res) => {
  const { apiKey, visitorToken, text, attachments } = req.body;
  if (!text?.trim() && !attachments?.length) return res.status(400).json({ error: "Empty message" });

  const site = await getSiteByKey(apiKey);
  if (!site) return res.status(404).json({ error: "Invalid site key" });

  const contact = await prisma.contact.findUnique({ where: { visitorToken } });
  if (!contact || contact.siteId !== site.id) return res.status(404).json({ error: "Invalid visitor" });

  let conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, status: { in: ["OPEN", "BOT", "PENDING_HUMAN"] } },
    orderBy: { updatedAt: "desc" },
  });
  if (!conversation) {
    return res.status(409).json({ error: "Chat is closed", code: "CHAT_CLOSED" });
  }

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      from: "VISITOR",
      text: text?.trim() || "",
      attachments: attachments || null,
    },
  });

  await prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
  await prisma.contact.update({ where: { id: contact.id }, data: { lastSeenAt: new Date() } });

  const io = req.app.get("io");
  io.to(`site:${site.id}`).emit("conversation:message", { conversationId: conversation.id, message, contact });
  io.to(`conversation:${conversation.id}`).emit("message", message);

  // Knowledge bot cavab cəhdi (yalnız mətn olsa və söhbət agent tərəfindən götürülməmişsə)
  let botMessage = null;
  const agentTaken = conversation.assigneeId != null || conversation.status === "PENDING_HUMAN" || conversation.status === "SOLVED";
  if (text?.trim() && !agentTaken) {
    try {
      const [kb, prod] = await Promise.all([
        searchKnowledge(site.id, text),
        searchProducts(site.id, text),
      ]);
      const kbMatches = kb.matches;
      const prodMatches = prod.matches;
      const hasAny = kbMatches.length > 0 || prodMatches.length > 0;
      if (hasAny) {
        const parts = [];
        if (kbMatches.length) parts.push(formatBotAnswer(kbMatches));
        if (prodMatches.length) parts.push(formatProductAnswer(prodMatches));
        const answer = parts.join("\n\n---\n\n");
        botMessage = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            from: "BOT",
            text: answer,
            attachments: {
              sources: kbMatches.map((m) => ({ id: m.id, title: m.title, url: m.url })),
              products: prodMatches.map((p) => ({ id: p.id, name: p.name, price: p.price, currency: p.currency, url: p.url, imageUrl: p.imageUrl })),
              score: Math.max(kb.bestScore, prod.bestScore),
            },
          },
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "BOT" } });
        io.to(`site:${site.id}`).emit("conversation:message", { conversationId: conversation.id, message: botMessage, contact });
        io.to(`conversation:${conversation.id}`).emit("message", botMessage);
      } else {
        // Cavab tapılmadı → operatora ötür
        const needsContact = !contact.name || !contact.email || !contact.phone;
        const language = site.appearance?.language || "AZ";
        botMessage = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            from: "SYSTEM",
            text: needsContact
              ? tI18n("botNoAnswerWithContact", language)
              : tI18n("botNoAnswer", language),
            attachments: needsContact ? { contactForm: true } : null,
          },
        });
        await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "PENDING_HUMAN" } });
        io.to(`site:${site.id}`).emit("conversation:needs-human", { conversationId: conversation.id, contact });
        io.to(`site:${site.id}`).emit("conversation:message", { conversationId: conversation.id, message: botMessage, contact });
        io.to(`conversation:${conversation.id}`).emit("message", botMessage);
        notifyNewHumanRequest(conversation, message).catch(() => {});
      }
    } catch (err) {
      // FTS setup hələ edilməyibsə səssizcə davam edirik
      console.warn("Knowledge search failed:", err.message);
    }
  }

  res.json({ message, bot: botMessage });
});

// Visitor özünü təqdim edir (ad/email/nömrə) — PENDING_HUMAN formundan gəlir
router.post("/identify", async (req, res) => {
  const { apiKey, visitorToken, name, email, phone } = req.body;
  const site = await getSiteByKey(apiKey);
  if (!site) return res.status(404).json({ error: "Invalid site key" });
  const contact = await prisma.contact.findUnique({ where: { visitorToken } });
  if (!contact || contact.siteId !== site.id) return res.status(404).json({ error: "Invalid visitor" });

  const updated = await prisma.contact.update({
    where: { id: contact.id },
    data: {
      ...(name?.trim() ? { name: name.trim() } : {}),
      ...(email?.trim() ? { email: email.trim() } : {}),
      ...(phone?.trim() ? { phone: phone.trim() } : {}),
    },
  });

  // Aktiv söhbətə sistem mesajı əlavə et
  const conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, status: { in: ["PENDING_HUMAN", "OPEN", "BOT"] } },
    orderBy: { updatedAt: "desc" },
  });
  if (conversation) {
    const language = site.appearance?.language || "AZ";
    const parts = [];
    if (name?.trim()) parts.push(`${tI18n("labelName", language)}: ${name.trim()}`);
    if (email?.trim()) parts.push(`Email: ${email.trim()}`);
    if (phone?.trim()) parts.push(`${tI18n("labelPhone", language)}: ${phone.trim()}`);
    const sysMsg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        from: "SYSTEM",
        text: `${tI18n("contactSaved", language)} ${parts.join(" · ")}`,
      },
    });
    const io = req.app.get("io");
    io.to(`site:${site.id}`).emit("conversation:message", { conversationId: conversation.id, message: sysMsg, contact: updated });
    io.to(`conversation:${conversation.id}`).emit("message", sysMsg);
  }

  res.json({ ok: true, contact: updated });
});

// Visitor "bu cavab kömək etmədi" → operatora ötürmə
router.post("/escalate", async (req, res) => {
  const { apiKey, visitorToken } = req.body;
  const site = await getSiteByKey(apiKey);
  if (!site) return res.status(404).json({ error: "Invalid site key" });
  const contact = await prisma.contact.findUnique({ where: { visitorToken } });
  if (!contact || contact.siteId !== site.id) return res.status(404).json({ error: "Invalid visitor" });

  const conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, status: { in: ["BOT", "OPEN"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!conversation) return res.status(404).json({ error: "No active conversation" });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: "PENDING_HUMAN" },
  });

  const io = req.app.get("io");
  const needsContact = !contact.name || !contact.email || !contact.phone;
  const language = site.appearance?.language || "AZ";

  if (needsContact) {
    const formMsg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        from: "SYSTEM",
        text: tI18n("enterContactForOperator", language),
        attachments: { contactForm: true },
      },
    });
    io.to(`site:${site.id}`).emit("conversation:message", { conversationId: conversation.id, message: formMsg, contact });
    io.to(`conversation:${conversation.id}`).emit("message", formMsg);
  }

  const sysMsg = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      from: "SYSTEM",
      text: needsContact
        ? tI18n("afterInfoOperator", language)
        : tI18n("operatorConnected", language),
    },
  });
  io.to(`site:${site.id}`).emit("conversation:needs-human", { conversationId: conversation.id, contact });
  io.to(`conversation:${conversation.id}`).emit("message", sysMsg);
  notifyNewHumanRequest(conversation, sysMsg).catch(() => {});
  res.json({ ok: true });
});

// Visitor yeni mesajları poll edə bilər (socket-siz fallback)
router.get("/messages", async (req, res) => {
  const { apiKey, visitorToken, sinceId } = req.query;
  const site = await getSiteByKey(apiKey);
  if (!site) return res.status(404).json({ error: "Invalid site key" });
  const contact = await prisma.contact.findUnique({ where: { visitorToken } });
  if (!contact || contact.siteId !== site.id) return res.status(404).json({ error: "Invalid visitor" });

  const conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, status: "OPEN" },
    orderBy: { createdAt: "desc" },
  });
  if (!conversation) return res.json([]);

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id, ...(sinceId ? { id: { gt: sinceId } } : {}) },
    orderBy: { createdAt: "asc" },
  });
  res.json(messages);
});

// Visitor ticket yaradır
router.post("/ticket", async (req, res) => {
  const { apiKey, visitorToken, subject, description } = req.body;
  const site = await getSiteByKey(apiKey);
  if (!site) return res.status(404).json({ error: "Invalid site key" });
  const contact = await prisma.contact.findUnique({ where: { visitorToken } });
  if (!contact || contact.siteId !== site.id) return res.status(404).json({ error: "Invalid visitor" });
  if (!subject?.trim()) return res.status(400).json({ error: "Subject required" });

  const conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, status: { in: ["OPEN", "BOT", "PENDING_HUMAN"] } },
    orderBy: { updatedAt: "desc" },
  });

  const ticket = await prisma.ticket.create({
    data: {
      siteId: site.id,
      contactId: contact.id,
      conversationId: conversation?.id || null,
      subject: subject.trim(),
      description: (description || "").trim(),
    },
  });

  // Sistem mesajı söhbətə əlavə et
  if (conversation) {
    const language = site.appearance?.language || "AZ";
    const tid = ticket.id.slice(-6).toUpperCase();
    const sysMsg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        from: "SYSTEM",
        text: `${tI18n("ticketCreatedPrefix", language)}: ${subject.trim()} (ID: #${tid})`
      },
    });
    const io = req.app.get("io");
    io.to(`conversation:${conversation.id}`).emit("message", sysMsg);
    io.to(`site:${site.id}`).emit("conversation:message", { conversationId: conversation.id, message: sysMsg, contact });
    io.to(`site:${site.id}`).emit("ticket:created", { ...ticket, contact: { id: contact.id, name: contact.name, email: contact.email, phone: contact.phone } });
  }

  res.json({ ok: true, ticket });
});

// Visitor çatı bitirir
router.post("/end-chat", async (req, res) => {
  const { apiKey, visitorToken } = req.body;
  const site = await getSiteByKey(apiKey);
  if (!site) return res.status(404).json({ error: "Invalid site key" });
  const contact = await prisma.contact.findUnique({ where: { visitorToken } });
  if (!contact || contact.siteId !== site.id) return res.status(404).json({ error: "Invalid visitor" });
  const conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, status: { in: ["OPEN", "BOT", "PENDING_HUMAN"] } },
    orderBy: { updatedAt: "desc" },
  });
  if (!conversation) return res.status(404).json({ error: "No active conversation" });
  const language = site.appearance?.language || "AZ";
  await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "SOLVED" } });
  const sysMsg = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      from: "SYSTEM",
      text: tI18n("chatEndedByUser", language)
    },
  });
  const io = req.app.get("io");
  io.to(`conversation:${conversation.id}`).emit("message", sysMsg);
  io.to(`site:${site.id}`).emit("conversation:updated", { id: conversation.id, status: "SOLVED" });
  res.json({ ok: true, conversationId: conversation.id });
});

// Visitor söhbəti qiymətləndirir
router.post("/rate", async (req, res) => {
  const { apiKey, visitorToken, conversationId, rating, comment } = req.body;
  const site = await getSiteByKey(apiKey);
  if (!site) return res.status(404).json({ error: "Invalid site key" });
  const contact = await prisma.contact.findUnique({ where: { visitorToken } });
  if (!contact || contact.siteId !== site.id) return res.status(404).json({ error: "Invalid visitor" });
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating 1-5" });
  const conv = conversationId
    ? await prisma.conversation.findFirst({ where: { id: conversationId, contactId: contact.id } })
    : await prisma.conversation.findFirst({ where: { contactId: contact.id }, orderBy: { updatedAt: "desc" } });
  if (!conv) return res.status(404).json({ error: "No conversation" });
  await prisma.conversation.update({ where: { id: conv.id }, data: { rating: parseInt(rating), ratingComment: comment?.trim() || null } });
  const io = req.app.get("io");
  io.to(`site:${site.id}`).emit("conversation:rated", { conversationId: conv.id, rating, comment });
  res.json({ ok: true });
});

// Visitor subscribe olur
router.post("/subscribe", async (req, res) => {
  const { apiKey, email, name } = req.body;
  const site = await getSiteByKey(apiKey);
  if (!site) return res.status(404).json({ error: "Invalid site key" });
  if (!email?.trim()) return res.status(400).json({ error: "Email required" });
  const existing = await prisma.subscriber.findUnique({ where: { siteId_email: { siteId: site.id, email: email.trim().toLowerCase() } } });
  if (existing) return res.json({ ok: true, already: true });
  const sub = await prisma.subscriber.create({ data: { siteId: site.id, email: email.trim().toLowerCase(), name: name?.trim() || null } });
  const io = req.app.get("io");
  io.to(`site:${site.id}`).emit("subscriber:new", sub);
  res.json({ ok: true, subscriber: sub });
});

// Visitor page update — live page tracking
router.post("/page-update", async (req, res) => {
  const { apiKey, visitorToken, siteId, page } = req.body;
  const site = await getSiteByKey(apiKey);
  if (!site) return res.status(404).json({ error: "Invalid site key" });
  const contact = await prisma.contact.findUnique({ where: { visitorToken } });
  if (!contact || contact.siteId !== site.id) return res.status(404).json({ error: "Invalid visitor" });

  // Update contact's current URL
  await prisma.contact.update({
    where: { id: contact.id },
    data: { currentUrl: page, lastSeenAt: new Date() }
  });

  // Broadcast to admin
  const io = req.app.get("io");
  io.to(`site:${site.id}`).emit("visitor:page-update", {
    contactId: contact.id,
    conversationId: siteId,
    page,
    at: new Date().toISOString()
  });

  res.json({ ok: true });
});

export default router;
