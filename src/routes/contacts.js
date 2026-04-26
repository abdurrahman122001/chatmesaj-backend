import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  const sites = await prisma.site.findMany({ where: { ownerId: req.user.id }, select: { id: true } });
  const siteIds = sites.map((s) => s.id);

  const q = (req.query.q || "").toString().trim();
  const showAll = req.query.includeAnonymous === "true";

  const conditions = [{ siteId: { in: siteIds } }];
  // Anonim ziyarətçiləri gizlət (adı və emaili olmayan)
  if (!showAll) {
    conditions.push({ OR: [{ name: { not: null } }, { email: { not: null } }] });
  }
  if (q) {
    conditions.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { country: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  const list = await prisma.contact.findMany({
    where: { AND: conditions },
    orderBy: { lastSeenAt: "desc" },
  });
  res.json(list);
});

router.patch("/:id", requireAuth, async (req, res) => {
  const sites = await prisma.site.findMany({ where: { ownerId: req.user.id }, select: { id: true } });
  const siteIds = sites.map((s) => s.id);
  const exists = await prisma.contact.findFirst({ where: { id: req.params.id, siteId: { in: siteIds } } });
  if (!exists) return res.status(404).json({ error: "Not found" });

  const { name, email, phone, country } = req.body;
  const updated = await prisma.contact.update({
    where: { id: req.params.id },
    data: { name, email, phone, country },
  });
  res.json(updated);
});

export default router;
