import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { notifyConversationEndedTranscript, notifyVisitorAgentMessage, notifyVisitorReply } from "../lib/mailer.js";
import { t as tI18n } from "../lib/i18n.js";
import { sendTelegramMessage } from "./telegram.js";

const router = Router();

// Aktiv istifadəçinin sahib olduğu site-ların ID-lərini qaytarır
async function userSiteIds(userId) {
  const sites = await prisma.site.findMany({ where: { ownerId: userId }, select: { id: true } });
  return sites.map((s) => s.id);
}

// GET /api/conversations?status=OPEN&siteId=...
router.get("/", requireAuth, async (req, res) => {
  const siteIds = await userSiteIds(req.user.id);
  const where = {
    siteId: { in: req.query.siteId ? [req.query.siteId] : siteIds },
  };
  if (req.query.status) where.status = req.query.status;

  const list = await prisma.conversation.findMany({
    where,
    include: {
      contact: true,
      assignee: { select: { id: true, name: true, email: true } },
      messages: { orderBy: { createdAt: "desc" } },
    },
    orderBy: { updatedAt: "desc" },
  });
  res.json(list);
});

router.get("/:id", requireAuth, async (req, res) => {
  const siteIds = await userSiteIds(req.user.id);
  const convo = await prisma.conversation.findFirst({
    where: { id: req.params.id, siteId: { in: siteIds } },
    include: {
      contact: true,
      assignee: { select: { id: true, name: true, email: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!convo) return res.status(404).json({ error: "Not found" });
  res.json(convo);
});

// Agent mesaj göndərir
router.post("/:id/messages", requireAuth, async (req, res) => {
  const { text, attachments, deliveryMode } = req.body;
  if (!text?.trim() && !attachments?.length) return res.status(400).json({ error: "Empty message" });

  const siteIds = await userSiteIds(req.user.id);
  const convo = await prisma.conversation.findFirst({
    where: { id: req.params.id, siteId: { in: siteIds } },
  });
  if (!convo) return res.status(404).json({ error: "Not found" });

  const requestedMode = String(deliveryMode || "chat").toLowerCase();
  const mode = ["chat", "email", "both"].includes(requestedMode) ? requestedMode : "chat";
  const sendChat = mode === "chat" || mode === "both";
  const sendEmail = mode === "email" || mode === "both";

  const message = await prisma.message.create({
    data: {
      conversationId: convo.id,
      from: "AGENT",
      text: text?.trim() || "",
      authorId: req.user.id,
      attachments: attachments || null,
    },
    include: { author: { select: { id: true, name: true } } },
  });

  // Agent cavab yazdıqda söhbəti öz üzərinə götürür — bot artıq cavablandırmasın.
  await prisma.conversation.update({
    where: { id: convo.id },
    data: {
      updatedAt: new Date(),
      assigneeId: convo.assigneeId || req.user.id,
      status: "OPEN",
    },
  });

  // Socket.IO via req.app
  const io = req.app.get("io");
  const roomSize = io.sockets.adapter.rooms.get(`conversation:${convo.id}`)?.size || 0;
  console.log(`[agent-send] convo=${convo.id} room-size=${roomSize}`);
  io.to(`site:${convo.siteId}`).emit("conversation:message", { conversationId: convo.id, message });
  if (sendChat) {
    io.to(`conversation:${convo.id}`).emit("message", message);
  }

  if (sendEmail) {
    const site = await prisma.site.findUnique({ where: { id: convo.siteId }, select: { appearance: true } });
    const language = ["AZ", "EN", "TR", "RU"].includes(site?.appearance?.language) ? site.appearance.language : "AZ";
    notifyVisitorAgentMessage(convo, message, { language }).catch((e) => console.error("[agent-send] email xəta:", e.message));
  }

  // Müştəri online deyilsə, cavabı emailə göndər
  // roomSize === 0 → heç kim yoxdur; roomSize === 1 → yalnız admin panel socket-i ola bilər
  // Widget socketləri "conversation:XXX" otağına join edir, admin panel isə "site:XXX" otağına
  if (sendChat && !sendEmail && roomSize <= 0) {
    notifyVisitorReply(convo, message).catch((e) => console.error("[agent-send] email xəta:", e.message));
  }

  // Send to Telegram if conversation channel is telegram
  if (convo.channel === 'telegram' && convo.channelUserId) {
    sendTelegramMessage(convo.channelUserId, message.text || '')
      .catch((e) => console.error("[agent-send] Telegram xəta:", e.message));
  }

  res.json(message);
});

// Status / assignee dəyişmək
router.patch("/:id", requireAuth, async (req, res) => {
  const siteIds = await userSiteIds(req.user.id);
  const exists = await prisma.conversation.findFirst({
    where: { id: req.params.id, siteId: { in: siteIds } },
    include: { contact: true },
  });
  if (!exists) return res.status(404).json({ error: "Not found" });

  const { status, assigneeId } = req.body;
  const updated = await prisma.conversation.update({
    where: { id: req.params.id },
    data: {
      ...(status ? { status } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
    },
    include: { assignee: { select: { id: true, name: true } } },
  });
  const io = req.app.get("io");

  if (status === "PENDING" && exists.status !== "PENDING") {
    const site = await prisma.site.findUnique({ where: { id: exists.siteId }, select: { appearance: true } });
    const language = site?.appearance?.language || "AZ";
    const closeMsg = await prisma.message.create({
      data: {
        conversationId: exists.id,
        from: "SYSTEM",
        text: tI18n("chatClosed", language),
      },
    });
    io.to(`conversation:${exists.id}`).emit("message", closeMsg);
    io.to(`site:${exists.siteId}`).emit("conversation:message", { conversationId: exists.id, message: closeMsg, contact: exists.contact });
    notifyConversationEndedTranscript(exists.id, { language }).catch((e) => console.error("[conversation-end] transcript email xəta:", e.message));
  }

  io.to(`site:${exists.siteId}`).emit("conversation:updated", updated);
  io.to(`conversation:${exists.id}`).emit("conversation:updated", updated);
  res.json(updated);
});

export default router;
