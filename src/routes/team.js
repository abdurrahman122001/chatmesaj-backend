import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// Get team members for current user's sites
router.get("/", requireAuth, async (req, res) => {
  // Get all sites where the user is either owner or member
  const userSites = await prisma.site.findMany({
    where: {
      OR: [
        { ownerId: req.user.id },
        { members: { some: { userId: req.user.id } } },
      ],
    },
    select: { id: true },
  });

  if (userSites.length === 0) {
    // User has no sites, return only themselves
    const me = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
    return res.json(me ? [me] : []);
  }

  const siteIds = userSites.map(s => s.id);

  // Get all members of these sites
  const members = await prisma.siteMember.findMany({
    where: { siteId: { in: siteIds } },
    include: {
      user: {
        select: { id: true, email: true, name: true, role: true, createdAt: true },
      },
    },
  });

  // Also include site owners
  const sites = await prisma.site.findMany({
    where: { id: { in: siteIds } },
    include: {
      owner: {
        select: { id: true, email: true, name: true, role: true, createdAt: true },
      },
    },
  });

  // Combine owners and members, deduplicate by user ID
  const userMap = new Map();
  
  // Add owners
  for (const site of sites) {
    userMap.set(site.owner.id, site.owner);
  }
  
  // Add members
  for (const member of members) {
    userMap.set(member.user.id, member.user);
  }

  res.json(Array.from(userMap.values()));
});

// Yeni agent yarat — site owner və ya site admin-lər
router.post("/", requireAuth, async (req, res) => {
  const { email, name, password, role } = req.body;
  if (!email?.trim() || !password?.trim()) return res.status(400).json({ error: "email və password tələb olunur" });
  if (password.length < 8) return res.status(400).json({ error: "Password minimum 8 simvol olmalıdır" });

  // Check if user has a site (owner or admin)
  const userSite = await prisma.site.findFirst({
    where: {
      OR: [
        { ownerId: req.user.id },
        { members: { some: { userId: req.user.id, role: "ADMIN" } } },
      ],
    },
  });

  if (!userSite) {
    return res.status(403).json({ error: "Yalnız site owner və ya admin-lər yeni istifadəçi yarada bilər" });
  }

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (existing) return res.status(409).json({ error: "Bu email artıq qeydiyyatdadır" });

  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase().trim(),
      name: name?.trim() || email.split("@")[0],
      passwordHash: hash,
      role: role === "ADMIN" ? "ADMIN" : "AGENT",
      status: "APPROVED", // Team members are auto-approved
    },
    select: { id: true, email: true, name: true, role: true, createdAt: true },
  });

  // Add user to the site as a team member
  await prisma.siteMember.create({
    data: {
      siteId: userSite.id,
      userId: user.id,
      role: "MEMBER",
    },
  });

  res.json(user);
});

// Rolu yenilə
router.patch("/:id", requireAuth, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Forbidden" });
  const { role, name, password } = req.body;
  const data = {};
  if (role && ["ADMIN", "AGENT"].includes(role)) data.role = role;
  if (name !== undefined) data.name = name.trim();
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: "Password minimum 8 simvol" });
    data.passwordHash = await bcrypt.hash(password, 10);
  }
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data,
    select: { id: true, email: true, name: true, role: true },
  });
  res.json(user);
});

// Sil
router.delete("/:id", requireAuth, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Forbidden" });
  if (req.params.id === req.user.id) return res.status(400).json({ error: "Özünüzü silə bilməzsiniz" });
  await prisma.user.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

export default router;
