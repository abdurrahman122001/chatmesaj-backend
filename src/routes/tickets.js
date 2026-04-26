import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { sendMail } from "../lib/mailer.js";

const router = Router();

async function userSiteIds(userId) {
  const sites = await prisma.site.findMany({ where: { ownerId: userId }, select: { id: true } });
  return sites.map((s) => s.id);
}

const STATUS_LABELS = {
  OPEN: "Ticket qeydə alındı",
  IN_REVIEW: "Ticket komandamız tərəfindən nəzərdən keçirilir",
  IN_PROGRESS: "Ticket üzərində işlənir",
  RESOLVED: "Ticket həll olundu",
  CANCELLED: "Ticket ləğv olundu",
};

async function notifyTicketStatus(ticket) {
  try {
    const contact = await prisma.contact.findUnique({ where: { id: ticket.contactId } });
    if (!contact?.email) return;
    const site = await prisma.site.findUnique({
      where: { id: ticket.siteId },
      include: { owner: { select: { email: true } } },
    });
    const siteName = site?.name || "Dəstək";
    const ownerEmail = site?.owner?.email || undefined;
    const label = STATUS_LABELS[ticket.status] || ticket.status;
    const tid = ticket.id.slice(-6).toUpperCase();
    const subject = `[${siteName}] ${label} — #${tid}`;
    const text = `Salam${contact.name ? ` ${contact.name}` : ""},\n\n📋 Mövzu: ${ticket.subject}\n📌 Status: ${label}\n🆔 ID: #${tid}\n${ticket.notes ? `💬 Qeyd: ${ticket.notes}\n` : ""}\nHörmətlə, ${siteName}`;
    const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto"><h3>${siteName}</h3><p>Salam${contact.name ? ` <b>${contact.name}</b>` : ""},</p><p><b>Mövzu:</b> ${ticket.subject}<br><b>Status:</b> <span style="color:#2563eb">${label}</span><br><b>ID:</b> #${tid}</p>${ticket.notes ? `<p><b>Qeyd:</b> ${ticket.notes}</p>` : ""}<p style="color:#94a3b8;font-size:12px">Hörmətlə, ${siteName}</p></div>`;
    await sendMail({ to: contact.email, subject, text, html, replyTo: ownerEmail, fromName: siteName });
  } catch (err) { console.error("[tickets] email:", err.message); }
}

router.get("/", requireAuth, async (req, res) => {
  const siteIds = await userSiteIds(req.user.id);
  const where = { siteId: { in: siteIds } };
  if (req.query.status) where.status = req.query.status;
  const list = await prisma.ticket.findMany({
    where,
    include: { contact: { select: { id: true, name: true, email: true, phone: true } }, assignee: { select: { id: true, name: true } } },
    orderBy: { updatedAt: "desc" },
  });
  res.json(list);
});

router.get("/:id", requireAuth, async (req, res) => {
  const siteIds = await userSiteIds(req.user.id);
  const ticket = await prisma.ticket.findFirst({
    where: { id: req.params.id, siteId: { in: siteIds } },
    include: { contact: true, assignee: { select: { id: true, name: true } } },
  });
  if (!ticket) return res.status(404).json({ error: "Not found" });
  res.json(ticket);
});

router.patch("/:id", requireAuth, async (req, res) => {
  const siteIds = await userSiteIds(req.user.id);
  const exists = await prisma.ticket.findFirst({ where: { id: req.params.id, siteId: { in: siteIds } } });
  if (!exists) return res.status(404).json({ error: "Not found" });
  const { status, priority, assigneeId, notes } = req.body;
  const oldStatus = exists.status;
  const updated = await prisma.ticket.update({
    where: { id: req.params.id },
    data: {
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
      ...(notes !== undefined ? { notes } : {}),
    },
    include: { contact: { select: { id: true, name: true, email: true } }, assignee: { select: { id: true, name: true } } },
  });
  if (status && status !== oldStatus) notifyTicketStatus(updated).catch(() => {});
  const io = req.app.get("io");
  io.to(`site:${exists.siteId}`).emit("ticket:updated", updated);
  res.json(updated);
});

router.delete("/:id", requireAuth, async (req, res) => {
  const siteIds = await userSiteIds(req.user.id);
  const exists = await prisma.ticket.findFirst({ where: { id: req.params.id, siteId: { in: siteIds } } });
  if (!exists) return res.status(404).json({ error: "Not found" });
  await prisma.ticket.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

export default router;
