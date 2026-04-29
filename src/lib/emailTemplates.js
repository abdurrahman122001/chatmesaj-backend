// Loads HTML email templates from project's `email/` folder, substitutes
// {{variables}} and returns the rendered HTML together with inline image
// attachments (CID) so they render in any mail client.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// server/src/lib -> project root is three levels up, then into chatbot/email
const EMAIL_DIR = path.resolve(__dirname, "..", "..", "..", "chatbot", "email");

const cache = new Map();
function readTemplate(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(EMAIL_DIR, `${name}.html`);
  const raw = fs.readFileSync(file, "utf8");
  cache.set(name, raw);
  return raw;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderVars(html, vars) {
  return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? "" : String(v);
  });
}

// Detect img src="..." that point to local files in email/ and rewrite them
// to cid:<name> while collecting attachments for nodemailer.
function extractInlineImages(html) {
  const attachments = [];
  const seen = new Map();
  const out = html.replace(/src="([^"]+)"/g, (match, src) => {
    if (/^(https?:|cid:|data:)/i.test(src)) return match;
    const filename = path.basename(src);
    const fullPath = path.join(EMAIL_DIR, filename);
    if (!fs.existsSync(fullPath)) return match;
    let cid = seen.get(filename);
    if (!cid) {
      cid = `${filename.replace(/[^a-z0-9]/gi, "_")}@chatmesaj`;
      seen.set(filename, cid);
      attachments.push({ filename, path: fullPath, cid, contentDisposition: "inline" });
    }
    return `src="cid:${cid}"`;
  });
  return { html: out, attachments };
}

function finalize(html) {
  return extractInlineImages(html);
}

const DEFAULT_BRAND = "ChatMesaj";

export function renderVerifyEmail({ token, frontendOrigin, siteName }) {
  const tpl = readTemplate("verify-email");
  return finalize(renderVars(tpl, { 
    token, 
    frontendOrigin,
    site_name: escapeHtml(siteName || DEFAULT_BRAND) 
  }));
}

export function renderResetPassword({ token, frontendOrigin, name, siteName }) {
  const tpl = readTemplate("reset-password");
  return finalize(renderVars(tpl, { 
    token, 
    frontendOrigin,
    name: escapeHtml(name || ""), 
    site_name: escapeHtml(siteName || DEFAULT_BRAND) 
  }));
}

export function renderAgentReply({
  siteName,
  siteUrl,
  agentName,
  customerName,
  messageText,
  language = "AZ",
}) {
  const tpl = readTemplate("agent-reply");
  const lang = language === "EN" ? "EN" : "AZ";
  const title = lang === "EN" ? "You have a new reply" : "Sizə yeni cavab gəldi";
  const subjectLabel = lang === "EN" ? "New reply" : "Yeni cavab";
  const greeting = lang === "EN"
    ? `Hello${customerName ? ` ${customerName}` : ""},`
    : `Salam${customerName ? ` ${customerName}` : ""},`;
  const lead = lang === "EN"
    ? `${agentName} replied to your request:`
    : `${agentName} sizin müraciətinizə cavab yazıb:`;
  const cta = lang === "EN"
    ? "Visit our website to continue the conversation."
    : "Söhbətə davam etmək üçün saytımızı ziyarət edin.";
  const ctaLabel = lang === "EN" ? "Continue chat" : "Söhbətə davam et";
  const regards = lang === "EN" ? "Regards," : "Hörmətlə,";

  const html = renderVars(tpl, {
    site_name: escapeHtml(siteName || DEFAULT_BRAND),
    site_url: siteUrl || "#",
    title: escapeHtml(title),
    subject_label: escapeHtml(subjectLabel),
    greeting: escapeHtml(greeting),
    lead: escapeHtml(lead),
    message_text: escapeHtml(messageText || "").replace(/\n/g, "<br/>"),
    agent_name: escapeHtml(agentName || ""),
    cta: escapeHtml(cta),
    cta_label: escapeHtml(ctaLabel),
    regards: escapeHtml(regards),
  });
  return finalize(html);
}

// messages: [{ from: 'VISITOR'|'AGENT'|'BOT', text, createdAt, authorName }]
export function renderChatTranscript({
  chatId,
  agentName,
  startedAt,
  endedAt,
  customerName,
  messages,
  frontendOrigin,
  language = "AZ",
  siteName,
}) {
  const tpl = readTemplate("chat-transcript");

  const startMarker = "<!-- {{#each messages}} loop start -->";
  const endMarker = "<!-- {{/each}} loop end -->";
  const startIdx = tpl.indexOf(startMarker);
  const endIdx = tpl.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error("chat-transcript.html missing loop markers");
  }
  const before = tpl.slice(0, startIdx);
  const loopBody = tpl.slice(startIdx + startMarker.length, endIdx);
  const after = tpl.slice(endIdx + endMarker.length);

  // Inside loopBody we have two example blocks: customer (left) and agent (right).
  // Extract them via comment markers.
  const custStart = loopBody.indexOf("<!-- Customer message -->");
  const agentStart = loopBody.indexOf("<!-- Agent message -->");
  const customerTpl = loopBody.slice(custStart, agentStart).trim();
  const agentTpl = loopBody.slice(agentStart).trim();

  const timeFmt = (d) =>
    new Date(d).toLocaleString(language === "EN" ? "en-US" : "az-Latn-AZ", {
      hour12: false,
    });

  const renderedMessages = messages
    .map((m) => {
      const time = timeFmt(m.createdAt);
      const text = escapeHtml(m.text || "").replace(/\n/g, "<br/>");
      if (m.from === "VISITOR") {
        return renderVars(customerTpl, {
          message_text: text,
          customer_name: escapeHtml(m.authorName || customerName || (language === "EN" ? "Visitor" : "Ziyarətçi")),
          time,
        });
      }
      // AGENT / BOT / SYSTEM all rendered on the agent side
      return renderVars(agentTpl, {
        message_text: text,
        agent_name: escapeHtml(
          m.authorName ||
            (m.from === "BOT" ? "Bot" : m.from === "AGENT" ? agentName : language === "EN" ? "System" : "Sistem")
        ),
        time,
      });
    })
    .join("\n");

  let combined = before + renderedMessages + after;

  // Replace transcript download URL host
  if (frontendOrigin) {
    combined = combined.replace(
      /https:\/\/chatmesaj\.cc\/chats\/\{\{chat_id\}\}\/transcript\.pdf/g,
      `${frontendOrigin}/chats/${encodeURIComponent(chatId)}/transcript.pdf`
    );
  }

  combined = renderVars(combined, {
    chat_id: escapeHtml(chatId),
    agent_name: escapeHtml(agentName || ""),
    started_at: escapeHtml(startedAt ? timeFmt(startedAt) : ""),
    ended_at: escapeHtml(endedAt ? timeFmt(endedAt) : ""),
    site_name: escapeHtml(siteName || DEFAULT_BRAND),
  });

  return finalize(combined);
}
