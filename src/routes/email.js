import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { randomUUID } from "crypto";
import dns from "dns/promises";

const router = Router();

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const CF_OAUTH_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const CF_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauthStateStore = new Map();

function pruneOAuthStateStore() {
  const now = Date.now();
  for (const [key, item] of oauthStateStore.entries()) {
    if (!item?.createdAt || now - item.createdAt > OAUTH_STATE_TTL_MS) {
      oauthStateStore.delete(key);
    }
  }
}

function getOAuthRedirectUri(req) {
  return process.env.CLOUDFLARE_OAUTH_REDIRECT_URI || `${req.protocol}://${req.get("host")}/api/email/cloudflare/oauth/callback`;
}

function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function oauthPopupHtml({ ok, message, targetOrigin = "*" }) {
  const safeMessage = escapeHtml(message || "");
  const payload = JSON.stringify({ type: "cloudflare-oauth-result", ok: Boolean(ok), message: message || "" });
  const safeTargetOrigin = JSON.stringify(targetOrigin || "*");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Cloudflare Connect</title></head>
  <body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; padding: 20px; color: #0f172a;">
    <div style="max-width:480px;margin:0 auto;">
      <h2 style="margin:0 0 8px;">${ok ? "Connected" : "Connection failed"}</h2>
      <p style="margin:0 0 16px; color:#475569;">${safeMessage}</p>
      <p style="font-size:12px;color:#64748b;">You can close this window.</p>
    </div>
    <script>
      (function () {
        var payload = ${payload};
        var targetOrigin = ${safeTargetOrigin};
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, targetOrigin);
          }
        } catch (e) {}
        setTimeout(function () { window.close(); }, 500);
      })();
    </script>
  </body>
</html>`;
}

function looksLikeGlobalApiKey(value) {
  return /^[a-f0-9]{37}$/i.test(String(value || "").trim());
}

function isPlaceholderSecret(value) {
  const v = String(value || "").trim();
  if (!v) return true;
  if (/^YOUR_[A-Z0-9_]+_HERE$/i.test(v)) return true;
  if (/^CHANGE_ME$/i.test(v)) return true;
  return false;
}

function pickCloudflareToken(siteToken, envToken) {
  const site = String(siteToken || "").trim();
  if (site && !isPlaceholderSecret(site)) return site;
  const env = String(envToken || "").trim();
  if (env && !isPlaceholderSecret(env)) return env;
  return "";
}

function resolveCloudflareAuth(rawToken, fallbackEmail = "") {
  const token = String(rawToken || "").trim();
  const email = String(fallbackEmail || "").trim();
  if (!token) return { mode: "none", token: "", email: "" };

  if (looksLikeGlobalApiKey(token)) {
    return { mode: "globalKey", token, email };
  }

  return { mode: "apiToken", token, email };
}

function authHeadersForMode(mode, token, email) {
  if (mode === "globalKey") {
    return {
      "X-Auth-Key": token,
      "X-Auth-Email": email,
    };
  }
  return {
    Authorization: `Bearer ${token}`,
  };
}

function isHeaderOrAuthFormatError(message = "") {
  const m = String(message || "").toLowerCase();
  return m.includes("invalid request headers") || m.includes("invalid format") || m.includes("authentication error");
}

async function cfRequest(path, rawToken, options = {}, fallbackEmail = "") {
  const auth = resolveCloudflareAuth(rawToken, fallbackEmail);
  if (auth.mode === "none") {
    throw new Error("Cloudflare credential is missing");
  }
  if (looksLikeGlobalApiKey(auth.token) && !auth.email) {
    throw new Error("Cloudflare Global API Key requires account email (set CLOUDFLARE_EMAIL or save email in Cloudflare settings)");
  }

  const mode = auth.mode;
  const res = await fetch(`${CF_API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeadersForMode(mode, auth.token, auth.email),
      ...(options.headers || {}),
    },
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (res.ok && payload?.success !== false) {
    return payload?.result;
  }

  const rawMsg = payload?.errors?.[0]?.message || payload?.message || `Cloudflare request failed (${res.status})`;
  const msgLower = String(rawMsg || "").toLowerCase();
  if (msgLower.includes("invalid request headers")) {
    if (mode === "globalKey") {
      throw new Error("Invalid Cloudflare Global API Key headers. Ensure API Key is correct and account email is provided.");
    }
    throw new Error("Invalid Cloudflare API token. Reconnect Cloudflare or enter a valid API token.");
  }

  throw new Error(rawMsg);
}

// Email settings-i gətir (site.settings-dan)
router.get("/", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  res.json(emailSettings);
});

// Email settings-i yadda saxla (site.settings-dan)
router.put("/", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const emailSettings = req.body;
  const currentSettings = site.settings || {};
  const updatedSettings = {
    ...currentSettings,
    email: emailSettings,
  };

  const updated = await prisma.site.update({
    where: { id: site.id },
    data: { settings: updatedSettings },
  });

  res.json(updated.settings?.email || {});
});

// Mailbox əlavə et
router.post("/mailbox", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const { email, provider, status = "unverified" } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  const newMailbox = {
    id: randomUUID(),
    email,
    provider,
    status,
    createdAt: new Date().toISOString(),
  };

  emailSettings.mailboxes.push(newMailbox);

  const updated = await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json(newMailbox);
});

// Mailbox sil
router.delete("/mailbox/:id", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const mailboxId = req.params.id;
  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  emailSettings.mailboxes = emailSettings.mailboxes.filter((m) => m.id !== mailboxId);

  const updated = await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json({ ok: true });
});

// Mailbox verify təlimatlarını gətir
router.get("/mailbox/:id/instructions", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const mailboxId = req.params.id;
  const settings = site.settings || {};
  const emailSettings = settings.email || { mailboxes: [] };
  const mailboxItem = (emailSettings.mailboxes || []).find((m) => m.id === mailboxId);
  if (!mailboxItem) return res.status(404).json({ error: "Mailbox not found" });

  res.json({
    email: mailboxItem.email,
    provider: mailboxItem.provider,
    status: mailboxItem.status,
    instructions: mailboxItem.provider === "gmail"
      ? "Go to Gmail Settings > Forwarding and POP/IMAP > Add a forwarding address."
      : mailboxItem.provider === "outlook"
      ? "Go to Outlook Settings > Mail > Forwarding > Enable forwarding."
      : "Configure forwarding in your email provider settings to forward all emails to your system.",
  });
});

// Mailbox statusunu verified et
router.post("/mailbox/:id/verify", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const mailboxId = req.params.id;
  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  const mailboxes = emailSettings.mailboxes || [];
  const idx = mailboxes.findIndex((m) => m.id === mailboxId);
  if (idx === -1) return res.status(404).json({ error: "Mailbox not found" });

  mailboxes[idx] = {
    ...mailboxes[idx],
    status: "verified",
    verifiedAt: new Date().toISOString(),
  };
  emailSettings.mailboxes = mailboxes;

  await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json(mailboxes[idx]);
});

// Sender address əlavə et
router.post("/sender-address", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const { email, senderType = "custom", status = "unverified" } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  const newSenderAddress = {
    id: randomUUID(),
    email,
    senderType,
    status,
    createdAt: new Date().toISOString(),
  };

  emailSettings.senderAddresses = emailSettings.senderAddresses || [];
  emailSettings.senderAddresses.push(newSenderAddress);

  if (!emailSettings.defaultSenderAddressId) {
    emailSettings.defaultSenderAddressId = newSenderAddress.id;
  }

  await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json(newSenderAddress);
});

// Sender address sil
router.delete("/sender-address/:id", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const senderAddressId = req.params.id;
  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  emailSettings.senderAddresses = (emailSettings.senderAddresses || []).filter((s) => s.id !== senderAddressId);

  if (emailSettings.defaultSenderAddressId === senderAddressId) {
    emailSettings.defaultSenderAddressId = emailSettings.senderAddresses[0]?.id || null;
  }

  await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json({ ok: true });
});

// Default sender address seç
router.put("/sender-address/default", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const { senderAddressId } = req.body;
  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  if (senderAddressId) {
    const exists = (emailSettings.senderAddresses || []).some((s) => s.id === senderAddressId);
    if (!exists) return res.status(400).json({ error: "Sender address not found" });
  }

  emailSettings.defaultSenderAddressId = senderAddressId || null;

  await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json({ ok: true, defaultSenderAddressId: emailSettings.defaultSenderAddressId });
});

// Sender address verify et
router.post("/sender-address/:id/verify", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const senderAddressId = req.params.id;
  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  const senderAddresses = emailSettings.senderAddresses || [];
  const idx = senderAddresses.findIndex((s) => s.id === senderAddressId);
  if (idx === -1) return res.status(404).json({ error: "Sender address not found" });

  const sender = senderAddresses[idx];
  const senderDomain = String(sender.email || "").split("@")[1]?.toLowerCase();
  const hasVerifiedDomain = (emailSettings.domains || []).some(
    (d) => d.domain?.toLowerCase() === senderDomain && d.status === "verified"
  );

  if (sender.senderType !== "tidio" && !hasVerifiedDomain) {
    return res.status(400).json({ error: "Domain is not verified for this sender address" });
  }

  senderAddresses[idx] = {
    ...sender,
    status: "verified",
    verifiedAt: new Date().toISOString(),
  };
  emailSettings.senderAddresses = senderAddresses;

  await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json(senderAddresses[idx]);
});

// Domain əlavə et
router.post("/domain", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const { domain, status = "unverified" } = req.body;
  if (!domain) return res.status(400).json({ error: "Domain required" });
  const normalizedDomain = String(domain).trim().toLowerCase();
  const verificationToken = randomUUID();

  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  const newDomain = {
    id: randomUUID(),
    domain: normalizedDomain,
    status,
    createdAt: new Date().toISOString(),
    verification: {
      txtName: `_chatbot-verify.${normalizedDomain}`,
      txtValue: `chatbot-verify=${verificationToken}`,
      checkedAt: null,
      error: null,
    },
  };

  emailSettings.domains.push(newDomain);

  const updated = await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json(newDomain);
});

// Domain verify təlimatlarını gətir
router.get("/domain/:id/instructions", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const domainId = req.params.id;
  const settings = site.settings || {};
  const emailSettings = settings.email || { domains: [] };
  const domainItem = (emailSettings.domains || []).find((d) => d.id === domainId);
  if (!domainItem) return res.status(404).json({ error: "Domain not found" });

  res.json({
    domain: domainItem.domain,
    status: domainItem.status,
    verification: domainItem.verification || null,
  });
});

// Domain verify et (DNS TXT yoxlaması)
router.post("/domain/:id/verify", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const domainId = req.params.id;
  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  const domains = emailSettings.domains || [];
  const idx = domains.findIndex((d) => d.id === domainId);
  if (idx === -1) return res.status(404).json({ error: "Domain not found" });

  const domainItem = domains[idx];
  const verification = domainItem.verification || {};
  const expectedTxtName = verification.txtName;
  const expectedTxtValue = verification.txtValue;
  if (!expectedTxtName || !expectedTxtValue) {
    return res.status(400).json({ error: "Verification instructions are missing for this domain" });
  }

  let foundTxt = [];
  let matched = false;
  let verifyError = null;

  try {
    const txtRecords = await dns.resolveTxt(expectedTxtName);
    foundTxt = txtRecords.map((entry) => entry.join(""));
    matched = foundTxt.includes(expectedTxtValue);
  } catch (err) {
    verifyError = err?.code || err?.message || "DNS lookup failed";
  }

  domains[idx] = {
    ...domainItem,
    status: matched ? "verified" : "unverified",
    verification: {
      ...verification,
      checkedAt: new Date().toISOString(),
      error: matched ? null : verifyError || "TXT record not found",
      lastFoundValues: foundTxt,
    },
  };

  emailSettings.domains = domains;
  await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json({
    ok: matched,
    status: domains[idx].status,
    verification: domains[idx].verification,
  });
});

// Cloudflare config gətir (site.settings.email.cloudflare)
router.get("/cloudflare/config", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const settings = site.settings || {};
  const emailSettings = settings.email || {};
  const cloudflare = emailSettings.cloudflare || {};
  const effectiveSiteToken = String(cloudflare.apiToken || "").trim();
  const effectiveEnvToken = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
  const effectiveToken = pickCloudflareToken(effectiveSiteToken, effectiveEnvToken);
  const source = effectiveToken
    ? (effectiveSiteToken && !isPlaceholderSecret(effectiveSiteToken) ? "site" : "env")
    : "none";

  res.json({
    hasApiToken: Boolean(effectiveToken),
    zoneId: cloudflare.zoneId || process.env.CLOUDFLARE_ZONE_ID || "",
    email: cloudflare.email || process.env.CLOUDFLARE_EMAIL || "",
    authType: cloudflare.authType || (cloudflare.apiToken ? "manual" : "none"),
    updatedAt: cloudflare.updatedAt || null,
    connectedAt: cloudflare.connectedAt || null,
    source,
  });
});

// Cloudflare config saxla
router.put("/cloudflare/config", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const { apiToken, zoneId = "", email = "" } = req.body || {};
  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };
  const existingCloudflare = emailSettings.cloudflare || {};
  const incomingToken = String(apiToken || "").trim();
  const resolvedToken = pickCloudflareToken(
    incomingToken || String(existingCloudflare.apiToken || "").trim(),
    String(process.env.CLOUDFLARE_API_TOKEN || "").trim()
  );
  if (!resolvedToken) {
    return res.status(400).json({ error: "Cloudflare API token is required" });
  }

  emailSettings.cloudflare = {
    ...existingCloudflare,
    apiToken: incomingToken && !isPlaceholderSecret(incomingToken)
      ? incomingToken
      : (pickCloudflareToken(String(existingCloudflare.apiToken || "").trim(), "") || existingCloudflare.apiToken),
    zoneId: String(zoneId || "").trim(),
    email: String(email || "").trim(),
    authType: incomingToken ? "manual" : (existingCloudflare.authType || "manual"),
    updatedAt: new Date().toISOString(),
  };

  await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json({ ok: true, hasApiToken: true, zoneId: emailSettings.cloudflare.zoneId, email: emailSettings.cloudflare.email || "" });
});

// Cloudflare token-i təmizlə (site settings)
router.delete("/cloudflare/config/token", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };
  const cloudflare = emailSettings.cloudflare || {};

  emailSettings.cloudflare = {
    ...cloudflare,
    apiToken: "",
    authType: "none",
    connectedAt: null,
    updatedAt: new Date().toISOString(),
  };

  await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  const envToken = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
  return res.json({
    ok: true,
    hasApiToken: Boolean(pickCloudflareToken("", envToken)),
    source: pickCloudflareToken("", envToken) ? "env" : "none",
    zoneId: emailSettings.cloudflare.zoneId || process.env.CLOUDFLARE_ZONE_ID || "",
    email: emailSettings.cloudflare.email || process.env.CLOUDFLARE_EMAIL || "",
    authType: "none",
  });
});

router.get("/cloudflare/oauth/start", requireAuth, async (req, res) => {
  const clientId = process.env.CLOUDFLARE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: "Cloudflare OAuth is not configured. Set CLOUDFLARE_OAUTH_CLIENT_ID and CLOUDFLARE_OAUTH_CLIENT_SECRET." });
  }

  const site = await prisma.site.findFirst({ where: { ownerId: req.user.id } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  pruneOAuthStateStore();
  const state = randomUUID();
  const frontendOrigin = String(req.query.frontendOrigin || "").trim();
  oauthStateStore.set(state, {
    userId: req.user.id,
    siteId: site.id,
    createdAt: Date.now(),
    frontendOrigin,
  });

  const redirectUri = getOAuthRedirectUri(req);
  const scope = process.env.CLOUDFLARE_OAUTH_SCOPES || "com.cloudflare.api.account.zone.read com.cloudflare.api.account.zone.dns";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    prompt: "consent",
    state,
  });

  return res.json({
    authorizeUrl: `${CF_OAUTH_AUTHORIZE_URL}?${params.toString()}`,
    state,
  });
});

router.get("/cloudflare/oauth/callback", async (req, res) => {
  const state = String(req.query.state || "");
  const code = String(req.query.code || "");
  const oauthError = String(req.query.error || "");
  const oauthErrorDescription = String(req.query.error_description || "");

  const stateItem = oauthStateStore.get(state);
  const targetOrigin = stateItem?.frontendOrigin || "*";

  if (oauthError) {
    return res.status(400).send(oauthPopupHtml({
      ok: false,
      message: oauthErrorDescription || oauthError,
      targetOrigin,
    }));
  }

  if (!state || !stateItem) {
    return res.status(400).send(oauthPopupHtml({
      ok: false,
      message: "Invalid or expired OAuth state.",
      targetOrigin: "*",
    }));
  }

  oauthStateStore.delete(state);
  if (Date.now() - stateItem.createdAt > OAUTH_STATE_TTL_MS) {
    return res.status(400).send(oauthPopupHtml({
      ok: false,
      message: "OAuth session expired. Please try connecting again.",
      targetOrigin,
    }));
  }

  if (!code) {
    return res.status(400).send(oauthPopupHtml({
      ok: false,
      message: "Authorization code is missing.",
      targetOrigin,
    }));
  }

  try {
    const clientId = process.env.CLOUDFLARE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("Cloudflare OAuth server config is missing.");
    }

    const redirectUri = getOAuthRedirectUri(req);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    });

    const tokenRes = await fetch(CF_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData?.access_token) {
      const reason = tokenData?.error_description || tokenData?.error || "Token exchange failed";
      throw new Error(reason);
    }

    const site = await prisma.site.findFirst({
      where: { id: stateItem.siteId, ownerId: stateItem.userId },
    });
    if (!site) throw new Error("Site not found for OAuth state");

    const settings = site.settings || {};
    const emailSettings = settings.email || {
      mailboxes: [],
      senderAddresses: [],
      domains: [],
      blockedEmails: [],
    };

    emailSettings.cloudflare = {
      ...(emailSettings.cloudflare || {}),
      apiToken: String(tokenData.access_token).trim(),
      authType: "oauth",
      tokenType: String(tokenData.token_type || "Bearer"),
      updatedAt: new Date().toISOString(),
      connectedAt: new Date().toISOString(),
      expiresAt: tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString() : null,
    };

    await prisma.site.update({
      where: { id: site.id },
      data: { settings: { ...settings, email: emailSettings } },
    });

    return res.send(oauthPopupHtml({
      ok: true,
      message: "Cloudflare account connected. You can return to settings.",
      targetOrigin,
    }));
  } catch (err) {
    return res.status(400).send(oauthPopupHtml({
      ok: false,
      message: err.message || "Cloudflare OAuth failed",
      targetOrigin,
    }));
  }
});

// Cloudflare zone siyahısı
router.get("/cloudflare/zones", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const site = await prisma.site.findFirst({ where: { ownerId: userId } });
    if (!site) return res.status(404).json({ error: "Site not found" });

    const settings = site.settings || {};
    const emailSettings = settings.email || {};
    const cloudflare = emailSettings.cloudflare || {};

    const token = pickCloudflareToken(cloudflare.apiToken, process.env.CLOUDFLARE_API_TOKEN);
    const authEmail = cloudflare.email || process.env.CLOUDFLARE_EMAIL || req.user?.email || "";
    if (!token) {
      return res.status(400).json({ error: "Cloudflare token is not configured" });
    }

    const zones = await cfRequest("/zones?per_page=100&status=active", token, {}, authEmail);
    res.json({
      zones: (zones || []).map((z) => ({ id: z.id, name: z.name })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to load Cloudflare zones" });
  }
});

// Cloudflare üzərindən TXT record-u avtomatik yarat
router.post("/domain/:id/cloudflare-sync", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const site = await prisma.site.findFirst({ where: { ownerId: userId } });
    if (!site) return res.status(404).json({ error: "Site not found" });

    const settings = site.settings || {};
    const emailSettings = settings.email || { domains: [] };
    const cloudflareConfig = emailSettings.cloudflare || {};

    const token = pickCloudflareToken(cloudflareConfig.apiToken, process.env.CLOUDFLARE_API_TOKEN);
    const authEmail = cloudflareConfig.email || process.env.CLOUDFLARE_EMAIL || req.user?.email || "";
    const configuredZoneId = cloudflareConfig.zoneId || process.env.CLOUDFLARE_ZONE_ID;
    if (!token) {
      return res.status(400).json({ error: "Cloudflare token is not configured (env or Email settings)" });
    }

    const domainId = req.params.id;
    const domainItem = (emailSettings.domains || []).find((d) => d.id === domainId);
    if (!domainItem) return res.status(404).json({ error: "Domain not found" });

    const verification = domainItem.verification || {};
    const txtName = verification.txtName;
    const txtValue = verification.txtValue;
    if (!txtName || !txtValue) {
      return res.status(400).json({ error: "Verification instructions are missing for this domain" });
    }

    let zoneId = configuredZoneId;
    if (!zoneId) {
      const zones = await cfRequest(`/zones?name=${encodeURIComponent(domainItem.domain)}`, token, {}, authEmail);
      zoneId = zones?.[0]?.id;
      if (!zoneId) {
        return res.status(400).json({ error: "Cloudflare zone not found. Set CLOUDFLARE_ZONE_ID or verify zone name." });
      }
    }

    const existing = await cfRequest(
      `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(txtName)}`,
      token,
      {},
      authEmail
    );

    let record;
    if (existing?.length) {
      record = await cfRequest(`/zones/${zoneId}/dns_records/${existing[0].id}`, token, {
        method: "PUT",
        body: JSON.stringify({
          type: "TXT",
          name: txtName,
          content: txtValue,
          ttl: 120,
        }),
      }, authEmail);
    } else {
      record = await cfRequest(`/zones/${zoneId}/dns_records`, token, {
        method: "POST",
        body: JSON.stringify({
          type: "TXT",
          name: txtName,
          content: txtValue,
          ttl: 120,
        }),
      }, authEmail);
    }

    res.json({ ok: true, zoneId, recordId: record.id, name: record.name, content: record.content });
  } catch (err) {
    res.status(400).json({ error: err.message || "Cloudflare DNS sync failed" });
  }
});

// Domain sil
router.delete("/domain/:id", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const domainId = req.params.id;
  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  emailSettings.domains = emailSettings.domains.filter((d) => d.id !== domainId);

  const updated = await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json({ ok: true });
});

// Blocked email əlavə et
router.post("/blocked", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  const newBlocked = {
    id: randomUUID(),
    email,
    createdAt: new Date().toISOString(),
  };

  emailSettings.blockedEmails.push(newBlocked);

  const updated = await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json(newBlocked);
});

// Blocked email sil
router.delete("/blocked/:id", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  if (!site) return res.status(404).json({ error: "Site not found" });

  const blockedId = req.params.id;
  const settings = site.settings || {};
  const emailSettings = settings.email || {
    mailboxes: [],
    senderAddresses: [],
    domains: [],
    blockedEmails: [],
  };

  emailSettings.blockedEmails = emailSettings.blockedEmails.filter((b) => b.id !== blockedId);

  const updated = await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, email: emailSettings } },
  });

  res.json({ ok: true });
});

export default router;
