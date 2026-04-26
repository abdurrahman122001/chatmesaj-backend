// Sadə email göndərici. SMTP konfiqurasiyası varsa real göndərir, yoxsa konsola yazır.
import nodemailer from "nodemailer";
import { prisma } from "../db.js";
import { renderChatTranscript, renderAgentReply } from "./emailTemplates.js";

let transporter = null;
let warned = false;

function getTransporter() {
  if (transporter !== null) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST) {
    if (!warned) {
      console.log("[mailer] SMTP konfiqurasiya edilməyib — emaillər konsola yazılacaq");
      warned = true;
    }
    transporter = false; // explicit "yoxdur"
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  return transporter;
}

// Default "From" address (e.g. "ChatMesaj <info@chatmesaj.cc>"). Email həmişə bu ünvandan gedir
// (DKIM/SPF düzgün konfiqurasiya olunmalıdır), lakin `replyTo` site sahibinin emailinə yönəldilə bilər
// — beləliklə müştəri "Reply" basanda cavab birbaşa istifadəçiyə gedir.
function parseDefaultFrom() {
  const raw = process.env.SMTP_FROM || "Chatbot <noreply@chatbot.local>";
  const m = raw.match(/^\s*(.+?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ""), address: m[2].trim() };
  return { name: "Chatbot", address: raw.trim() };
}

export async function sendMail({ to, subject, text, html, attachments, replyTo, fromName }) {
  const t = getTransporter();
  const def = parseDefaultFrom();
  const displayName = fromName ? String(fromName).replace(/[<>"]/g, "").trim() : def.name;
  const from = `"${displayName}" <${def.address}>`;
  if (!t) {
    console.log(`[mailer:dev] From: ${from}${replyTo ? ` | Reply-To: ${replyTo}` : ""} | To: ${to} | Subject: ${subject}\n${text || html}`);
    return { dev: true };
  }
  try {
    return await t.sendMail({ from, to, subject, text, html, attachments, ...(replyTo ? { replyTo } : {}) });
  } catch (err) {
    console.error("[mailer] xəta:", err.message);
    return { error: err.message };
  }
}

async function getConversationEmailContext(conversationOrId) {
  const conversation = typeof conversationOrId === "string"
    ? await prisma.conversation.findUnique({ where: { id: conversationOrId } })
    : conversationOrId;
  if (!conversation) return null;

  const [contact, site] = await Promise.all([
    prisma.contact.findUnique({ where: { id: conversation.contactId } }),
    prisma.site.findUnique({
      where: { id: conversation.siteId },
      include: { owner: { select: { email: true, name: true } } },
    }),
  ]);
  if (!contact?.email) return null;

  const settings = site?.settings && typeof site.settings === "object" ? site.settings : {};
  const agentName = settings.agentName || "Dəstək komandası";
  return {
    conversation,
    contact,
    site,
    siteName: site?.name || "Dəstək",
    agentName,
    ownerEmail: site?.owner?.email || null,
  };
}

export async function notifyVisitorAgentMessage(conversationOrId, agentMessage, options = {}) {
  try {
    const ctx = await getConversationEmailContext(conversationOrId);
    if (!ctx) return;

    const lang = options.language === "EN" ? "EN" : "AZ";
    const subject = options.subject || `[${ctx.siteName}] ${lang === "EN" ? "New reply" : "Yeni cavab"}: ${ctx.agentName}`;
    const lead = lang === "EN"
      ? `${ctx.agentName} replied to your request:`
      : `${ctx.agentName} sizin müraciətinizə cavab yazıb:`;
    const cta = options.callToAction || (lang === "EN" ? "Visit our website to continue the conversation." : "Söhbətə davam etmək üçün saytımızı ziyarət edin.");
    const greeting = lang === "EN"
      ? `Hello${ctx.contact.name ? ` ${ctx.contact.name}` : ""},`
      : `Salam${ctx.contact.name ? ` ${ctx.contact.name}` : ""},`;
    const regards = lang === "EN" ? "Regards," : "Hörmətlə,";

    const text = [
      greeting,
      "",
      lead,
      "",
      `"${agentMessage?.text || ""}"`,
      "",
      cta,
      "",
      regards,
      ctx.siteName,
    ].join("\n");

    const siteUrl = ctx.site?.domain
      ? (/^https?:\/\//i.test(ctx.site.domain) ? ctx.site.domain : `https://${ctx.site.domain}`)
      : (process.env.FRONTEND_ORIGIN || "#");
    const { html, attachments } = renderAgentReply({
      siteName: ctx.siteName,
      siteUrl,
      agentName: ctx.agentName,
      customerName: ctx.contact.name,
      messageText: agentMessage?.text || "",
      language: lang,
    });

    await sendMail({ to: ctx.contact.email, subject, text, html, attachments, replyTo: ctx.ownerEmail || undefined, fromName: ctx.siteName });
  } catch (err) {
    console.error("[mailer] notifyVisitorAgentMessage:", err.message);
  }
}

export async function notifyConversationEndedTranscript(conversationId, options = {}) {
  try {
    const ctx = await getConversationEmailContext(conversationId);
    if (!ctx) return;

    const messages = await prisma.message.findMany({
      where: { conversationId: ctx.conversation.id },
      include: { author: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (!messages.length) return;

    const lang = options.language === "EN" ? "EN" : "AZ";
    const labelFor = (m) => {
      if (m.from === "VISITOR") return ctx.contact.name || (lang === "EN" ? "Visitor" : "Ziyarətçi");
      if (m.from === "AGENT") return m.author?.name || ctx.agentName;
      if (m.from === "BOT") return "Bot";
      return lang === "EN" ? "System" : "Sistem";
    };
    const timeFmt = (d) => new Date(d).toLocaleString(lang === "EN" ? "en-US" : "az-Latn-AZ", { hour12: false });
    const transcriptLines = messages.map((m) => `[${timeFmt(m.createdAt)}] ${labelFor(m)}: ${m.text || ""}`);

    const subject = options.subject || `[${ctx.siteName}] ${lang === "EN" ? "Chat ended" : "Çat bitirildi"}`;
    const greeting = lang === "EN"
      ? `Hello${ctx.contact.name ? ` ${ctx.contact.name}` : ""},`
      : `Salam${ctx.contact.name ? ` ${ctx.contact.name}` : ""},`;
    const intro = lang === "EN"
      ? "Your conversation has been ended by support. Full transcript is below:"
      : "Söhbətiniz dəstək tərəfindən bitirildi. Tam çat tarixçəsi aşağıdadır:";
    const text = [greeting, "", intro, "", ...transcriptLines].join("\n");

    const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
    const { html, attachments } = renderChatTranscript({
      chatId: ctx.conversation.id,
      agentName: ctx.agentName,
      startedAt: ctx.conversation.createdAt || messages[0]?.createdAt,
      endedAt: ctx.conversation.updatedAt || messages[messages.length - 1]?.createdAt || new Date(),
      customerName: ctx.contact.name,
      messages: messages.map((m) => ({
        from: m.from,
        text: m.text,
        createdAt: m.createdAt,
        authorName: m.from === "AGENT" ? (m.author?.name || ctx.agentName) : (m.from === "VISITOR" ? ctx.contact.name : null),
      })),
      frontendOrigin,
      language: lang,
      siteName: ctx.siteName,
    });

    await sendMail({ to: ctx.contact.email, subject, text, html, attachments, replyTo: ctx.ownerEmail || undefined, fromName: ctx.siteName });
  } catch (err) {
    console.error("[mailer] notifyConversationEndedTranscript:", err.message);
  }
}

// Müştəri offline olduqda agentin cavabını emailə göndər
export async function notifyVisitorReply(conversation, agentMessage) {
  return notifyVisitorAgentMessage(conversation, agentMessage, { language: "AZ" });
}

// Yeni operator-eskalasiya zamanı yalnız konkret saytın sahibinə + komanda üzvlərinə bildiriş göndər
export async function notifyNewHumanRequest(conversation, lastMessage) {
  try {
    if (!conversation?.siteId) return;
    const site = await prisma.site.findUnique({
      where: { id: conversation.siteId },
      include: {
        owner: { select: { email: true, name: true } },
        members: { include: { user: { select: { email: true, name: true } } } },
      },
    });
    if (!site) return;

    const recipientsMap = new Map();
    if (site.owner?.email) recipientsMap.set(site.owner.email, site.owner);
    for (const m of site.members || []) {
      if (m.user?.email) recipientsMap.set(m.user.email, m.user);
    }
    const recipients = Array.from(recipientsMap.values());
    if (!recipients.length) return;

    const siteName = site.name || "Chatbot";
    const subject = `[${siteName}] Yeni operator sorğusu`;
    const dashboardUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
    const text = [
      `Yeni söhbət operator gözləyir.`,
      ``,
      `Sayt: ${siteName}`,
      `Söhbət ID: ${conversation.id}`,
      `Son mesaj: "${lastMessage?.text || "-"}"`,
      ``,
      `Inbox: ${dashboardUrl}`,
    ].join("\n");
    await Promise.all(recipients.map((u) => sendMail({ to: u.email, subject, text })));
  } catch (err) {
    console.error("[mailer] notifyNewHumanRequest:", err.message);
  }
}
