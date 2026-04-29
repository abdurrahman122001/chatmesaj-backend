import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../db.js";
import { signToken, requireAuth } from "../middleware/auth.js";
import { sendMail } from "../lib/mailer.js";
import { renderVerifyEmail, renderResetPassword } from "../lib/emailTemplates.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const speakeasy = require("speakeasy");

const router = Router();

// TOTP helpers (wraps speakeasy into an authenticator-like API)
const authenticator = {
  generateSecret() {
    return speakeasy.generateSecret({ length: 20 }).base32;
  },
  keyuri(account, issuer, secret) {
    return speakeasy.otpauthURL({
      secret,
      label: `${issuer}:${account}`,
      issuer,
      encoding: "base32",
    });
  },
  check(token, secret) {
    return speakeasy.totp.verify({
      secret,
      encoding: "base32",
      token: String(token),
      window: 1,
    });
  },
};

function generateBackupCodes(n = 8) {
  return Array.from({ length: n }, () =>
    crypto.randomBytes(5).toString("hex").toUpperCase().match(/.{1,5}/g).join("-")
  );
}
function hashCode(code) {
  return crypto.createHash("sha256").update(String(code).toUpperCase()).digest("hex");
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  siteName: z.string().min(1).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function randomKey(prefix = "site") {
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// Public registration - creates user with PENDING status, no site until approved
router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    const errors = parsed.error.flatten();
    console.error("Registration validation error:", errors);
    const fieldErrors = Object.entries(errors.fieldErrors)
      .map(([field, messages]) => `${field}: ${messages.join(", ")}`)
      .join("; ");
    return res.status(400).json({ error: fieldErrors || errors.formErrors[0] || "Invalid input" });
  }

  const { email, password, name } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.status === "DELETED") {
      return res.status(403).json({ error: "This email has been deleted and cannot be used for registration" });
    }
    return res.status(409).json({ error: "Email already registered" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  // Generate email verification token
  const emailVerificationToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  const emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
      role: "AGENT",
      status: "PENDING",
      emailVerificationToken,
      emailVerificationExpires,
    },
  });

  // Send verification email to new user
  const frontendOrigin = (process.env.FRONTEND_ORIGIN || "http://localhost:5173").replace(/\/+$/, "");
  const verificationUrl = `${frontendOrigin}/verify-email?token=${emailVerificationToken}`;
  const verifyTpl = renderVerifyEmail({ token: emailVerificationToken, frontendOrigin });
  await sendMail({
    to: email,
    subject: "Verify your email - ChatMesaj",
    text: `Please verify your email by clicking this link: ${verificationUrl}`,
    html: verifyTpl.html,
    attachments: verifyTpl.attachments,
  });

  // Send notification to superadmin
  const superadminEmail = "info@chatmesaj.cc";
  const dashboardUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
  await sendMail({
    to: superadminEmail,
    subject: `[Chatbot] Yeni qeydiyyat: ${name} (${email})`,
    text: `Yeni istifadəçi qeydiyyatdan keçib:\n\nAd: ${name}\nEmail: ${email}\n\nDashboard: ${dashboardUrl}`,
    html: `<p>Yeni istifadəçi qeydiyyatdan keçib:</p><p><strong>Ad:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><a href="${dashboardUrl}">Dashboard</a></p>`,
  });

  res.json({
    ok: true,
    message: "Registration successful. Please check your email to verify your account, then wait for superadmin approval.",
  });
});

// Email verification endpoint
router.post("/verify-email", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required" });

  const user = await prisma.user.findFirst({
    where: {
      emailVerificationToken: token,
      emailVerificationExpires: { gt: new Date() },
    },
  });

  if (!user) return res.status(400).json({ error: "Invalid or expired token" });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      status: "APPROVED", // Auto-approve after email verification
      emailVerificationToken: null,
      emailVerificationExpires: null,
    },
  });

  res.json({ ok: true, message: "Email verified successfully" });
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    const errors = parsed.error.flatten();
    const errorMessages = Object.entries(errors.fieldErrors)
      .map(([field, messages]) => `${field}: ${messages.join(", ")}`)
      .join("; ");
    return res.status(400).json({ error: errorMessages || errors.formErrors[0] || "Invalid input" });
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  // Check user status
  if (!user.emailVerified) {
    return res.status(403).json({ error: "Please verify your email before logging in. Check your inbox for the verification link." });
  }
  if (user.status === "PENDING") {
    return res.status(403).json({ error: "Account pending approval. Please wait for superadmin approval." });
  }
  if (user.status === "REJECTED") {
    return res.status(403).json({ error: "Account has been rejected. Please contact support." });
  }
  if (user.status === "DELETED") {
    return res.status(403).json({ error: "Account has been deleted." });
  }

  if (user.twoFactorEnabled) {
    // Stale demo flag (no secret yet) — auto-clear and let user log in
    if (!user.twoFactorSecret) {
      await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false } });
    } else {
      const tempToken = jwt.sign({ sub: user.id, kind: "2fa-pending" }, process.env.JWT_SECRET, { expiresIn: "5m" });
      return res.json({ requires2FA: true, tempToken });
    }
  }

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

// Second step of login when 2FA is enabled
router.post("/login/2fa", async (req, res) => {
  const { tempToken, code } = req.body || {};
  if (!tempToken || !code) return res.status(400).json({ error: "tempToken və code tələb olunur" });

  let payload;
  try { payload = jwt.verify(tempToken, process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: "Müddəti bitmiş və ya yanlış token" }); }
  if (payload.kind !== "2fa-pending") return res.status(401).json({ error: "Yanlış token növü" });

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) return res.status(401).json({ error: "2FA aktiv deyil" });

  const normalized = String(code).trim().replace(/\s+/g, "").toUpperCase();
  let valid = false;
  let usedBackup = false;

  // Try TOTP first (6 digits)
  if (/^\d{6}$/.test(normalized)) {
    valid = authenticator.check(normalized, user.twoFactorSecret);
  }
  // Try backup codes
  if (!valid && user.twoFactorBackupCodes?.length) {
    const h = hashCode(normalized);
    if (user.twoFactorBackupCodes.includes(h)) {
      valid = true; usedBackup = true;
      const remaining = user.twoFactorBackupCodes.filter((c) => c !== h);
      await prisma.user.update({ where: { id: user.id }, data: { twoFactorBackupCodes: remaining } });
    }
  }

  if (!valid) return res.status(401).json({ error: "Kod yanlışdır" });

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    usedBackup,
  });
});

router.get("/me", requireAuth, async (req, res) => {
  const sites = await prisma.site.findMany({
    where: { ownerId: req.user.id },
    select: { id: true, name: true, apiKey: true, quickActions: true, appearance: true, settings: true },
  });
  res.json({ user: req.user, sites });
});

router.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Hər iki şifrə tələb olunur" });
  if (String(newPassword).length < 8) return res.status(400).json({ error: "Yeni şifrə ən azı 8 simvol olmalıdır" });

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: "İstifadəçi tapılmadı" });

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Cari şifrə yanlışdır" });

  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    return res.status(400).json({ error: "Yeni şifrə köhnə şifrədən fərqli olmalıdır" });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } });
  res.json({ ok: true });
});

// === Real TOTP 2FA ===
// Step 1: generate a secret & QR code (not yet enabled)
router.post("/2fa/setup", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: "İstifadəçi tapılmadı" });
  if (user.twoFactorEnabled) return res.status(400).json({ error: "2FA artıq aktivdir" });

  const secret = authenticator.generateSecret();
  const issuer = "Chatbot";
  const label = `${issuer}:${user.email}`;
  const otpauthUrl = authenticator.keyuri(user.email, issuer, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

  // Store secret temporarily (not yet enabled) — user must verify first
  await prisma.user.update({
    where: { id: req.user.id },
    data: { twoFactorSecret: secret, twoFactorEnabled: false },
  });

  res.json({ secret, otpauthUrl, qrDataUrl, label });
});

// Step 2: verify the first code to enable 2FA; also returns backup codes
router.post("/2fa/verify-setup", requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: "Kod tələb olunur" });

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user?.twoFactorSecret) return res.status(400).json({ error: "Əvvəlcə setup başladın" });
  if (user.twoFactorEnabled) return res.status(400).json({ error: "2FA artıq aktivdir" });

  const valid = authenticator.check(String(code).trim(), user.twoFactorSecret);
  if (!valid) return res.status(401).json({ error: "Kod yanlışdır" });

  const backupCodes = generateBackupCodes(8);
  const hashed = backupCodes.map(hashCode);

  await prisma.user.update({
    where: { id: req.user.id },
    data: { twoFactorEnabled: true, twoFactorBackupCodes: hashed },
  });

  res.json({ ok: true, backupCodes });
});

// Step 3: disable — require password AND either TOTP code or backup code
router.post("/2fa/disable", requireAuth, async (req, res) => {
  const { password, code } = req.body || {};
  if (!password || !code) return res.status(400).json({ error: "Şifrə və 2FA kodu tələb olunur" });

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: "İstifadəçi tapılmadı" });
  if (!user.twoFactorEnabled) return res.status(400).json({ error: "2FA aktiv deyil" });

  const pwOk = await bcrypt.compare(password, user.passwordHash);
  if (!pwOk) return res.status(401).json({ error: "Şifrə yanlışdır" });

  const normalized = String(code).trim().replace(/\s+/g, "").toUpperCase();
  let valid = /^\d{6}$/.test(normalized) && authenticator.check(normalized, user.twoFactorSecret);
  if (!valid && user.twoFactorBackupCodes?.includes(hashCode(normalized))) valid = true;
  if (!valid) return res.status(401).json({ error: "2FA kodu yanlışdır" });

  await prisma.user.update({
    where: { id: req.user.id },
    data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: [] },
  });

  res.json({ ok: true });
});

router.patch("/profile", requireAuth, async (req, res) => {
  const { name, email, signature } = req.body;
  const data = {};
  if (name !== undefined) data.name = String(name).slice(0, 100);
  if (email !== undefined) {
    if (!/^[^@]+@[^@]+$/.test(email)) return res.status(400).json({ error: "Yanlış email formatı" });
    const taken = await prisma.user.findFirst({ where: { email, id: { not: req.user.id } } });
    if (taken) return res.status(409).json({ error: "Bu email artıq istifadə olunur" });
    data.email = email;
  }
  if (signature !== undefined) data.signature = String(signature);
  if (!Object.keys(data).length) return res.status(400).json({ error: "Heç bir dəyişiklik yoxdur" });
  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data,
    select: { id: true, email: true, name: true, role: true, signature: true, avatarUrl: true },
  });
  res.json(updated);
});

// Avatar upload — accepts base64 data URL (max ~2MB decoded)
router.post("/avatar", requireAuth, async (req, res) => {
  const { dataUrl } = req.body || {};
  if (dataUrl === null) {
    // Remove avatar
    const updated = await prisma.user.update({
      where: { id: req.user.id }, data: { avatarUrl: null },
      select: { id: true, avatarUrl: true },
    });
    return res.json(updated);
  }
  if (!dataUrl || typeof dataUrl !== "string") return res.status(400).json({ error: "dataUrl tələb olunur" });
  const match = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return res.status(400).json({ error: "Yanlış şəkil formatı (PNG/JPEG/GIF/WEBP)" });

  // Estimate decoded size: base64 length * 3/4
  const base64Len = match[2].length;
  const bytes = Math.floor(base64Len * 3 / 4);
  if (bytes > 2 * 1024 * 1024) return res.status(413).json({ error: "Şəkil 2MB-dan böyükdür" });

  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: { avatarUrl: dataUrl },
    select: { id: true, email: true, name: true, role: true, signature: true, avatarUrl: true },
  });
  res.json(updated);
});

// Forgot password - send reset email
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "Email tələb olunur" });

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) {
    // Don't reveal if email exists, just return success
    return res.json({ ok: true, message: "Əgər email mövcuddursa, reset linki göndəriləcək" });
  }

  // Generate reset token (valid for 1 hour)
  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.user.update({
    where: { id: user.id },
    data: { resetToken, resetExpires },
  });

  // Build reset URL
  const frontendOrigin = (process.env.FRONTEND_ORIGIN || "http://localhost:5173").replace(/\/+$/, "");
  const resetUrl = `${frontendOrigin}/reset-password?token=${resetToken}`;

  // Send email
  const subject = "Şifrənizi Sıfırlayın - ChatMesaj";
  const text = `Salam ${user.name},\n\nŞifrənizi sıfırlamaq üçün aşağıdakı linkə klikləyin:\n\n${resetUrl}\n\nBu link 1 saat ərzində etibarlıdır.\n\nƏgər şifrə sıfırlama tələbi sizin deyilsə, bu emaili nəzərə almayın.\n\nHörmətlə,\nChatMesaj komandası`;

  const resetTpl = renderResetPassword({ token: resetToken, frontendOrigin, name: user.name });

  await sendMail({ to: user.email, subject, text, html: resetTpl.html, attachments: resetTpl.attachments });
  res.json({ ok: true, message: "Əgər email mövcuddursa, reset linki göndəriləcək" });
});

// Reset password with token
router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: "Token və yeni şifrə tələb olunur" });
  if (String(newPassword).length < 8) return res.status(400).json({ error: "Yeni şifrə ən azı 8 simvol olmalıdır" });

  const user = await prisma.user.findFirst({
    where: {
      resetToken: token,
      resetExpires: { gte: new Date() },
    },
  });

  if (!user) return res.status(400).json({ error: "Yanlış və ya vaxtı keçmiş token" });

  const passwordHash = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      resetToken: null,
      resetExpires: null,
      twoFactorEnabled: false,
      twoFactorSecret: null,
    },
  });

  res.json({ ok: true, message: "Şifrə uğurla sıfırlandı" });
});

// Superadmin: Approve user (and optionally create initial site)
router.post("/admin/approve-user", requireAuth, async (req, res) => {
  const requestingUser = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (requestingUser.role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Only superadmin can approve users" });
  }

  const { userId, createSite = false, siteName } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { sites: true } });
  if (!user) return res.status(404).json({ error: "User not found" });
  // Idempotent: if already approved, just return success (avoids spurious "Failed to approve" on double-click / retry)
  if (user.status === "APPROVED") return res.json({ ok: true, user, alreadyApproved: true });
  if (!user.emailVerified) return res.status(400).json({ error: "User must verify email before approval" });

  const updateData = { status: "APPROVED" };
  
  // If creating site, include it in the transaction
  if (createSite) {
    const siteNameFinal = siteName || `${user.name}'s site`;
    const apiKey = randomKey();
    
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...updateData,
        sites: {
          create: {
            name: siteNameFinal,
            apiKey,
            members: {
              create: {
                userId: userId,
                role: "ADMIN", // User is admin of their own site
              },
            },
          },
        },
      },
      include: { sites: true },
    });
    
    res.json({ ok: true, user: updatedUser });
  } else {
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });
    
    res.json({ ok: true, user: updatedUser });
  }
});

// Superadmin: Reject user
router.post("/admin/reject-user", requireAuth, async (req, res) => {
  const requestingUser = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (requestingUser.role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Only superadmin can reject users" });
  }

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const user = await prisma.user.update({
    where: { id: userId },
    data: { status: "REJECTED" },
    select: { id: true, email: true, name: true, role: true, status: true, createdAt: true },
  });
  res.json({ ok: true, user });
});

// Superadmin: List all users
router.get("/admin/all-users", requireAuth, async (req, res) => {
  const requestingUser = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (requestingUser.role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Only superadmin can view all users" });
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      createdAt: true,
    },
  });

  res.json({ users });
});

// Superadmin: Delete user
router.post("/admin/delete-user", requireAuth, async (req, res) => {
  const requestingUser = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (requestingUser.role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Only superadmin can delete users" });
  }

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  if (userId === req.user.id) {
    return res.status(400).json({ error: "Cannot delete yourself" });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: "User not found" });

  // Mark as deleted instead of actually deleting
  await prisma.user.update({
    where: { id: userId },
    data: { status: "DELETED" },
  });

  res.json({ ok: true, message: "User deleted successfully" });
});

// Superadmin: Deactivate user
router.post("/admin/deactivate-user", requireAuth, async (req, res) => {
  const requestingUser = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (requestingUser.role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Only superadmin can deactivate users" });
  }

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  if (userId === req.user.id) {
    return res.status(400).json({ error: "Cannot deactivate yourself" });
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: "User not found" });

  await prisma.user.update({
    where: { id: userId },
    data: { status: "PENDING" }, // Reset to pending to deactivate
  });

  res.json({ ok: true, message: "User deactivated successfully" });
});

// Superadmin: List all users with pending status
router.get("/admin/pending-users", requireAuth, async (req, res) => {
  const requestingUser = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (requestingUser.role !== "SUPERADMIN") {
    return res.status(403).json({ error: "Only superadmin can view pending users" });
  }

  const pendingUsers = await prisma.user.findMany({
    where: { status: "PENDING" },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json({ users: pendingUsers });
});

export default router;
