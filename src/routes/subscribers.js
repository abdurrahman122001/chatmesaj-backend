import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

async function userSiteIds(userId) {
  const sites = await prisma.site.findMany({ where: { ownerId: userId }, select: { id: true } });
  return sites.map((s) => s.id);
}

// Bütün abunəçiləri siyahıla
router.get("/", requireAuth, async (req, res) => {
  const siteIds = await userSiteIds(req.user.id);
  const subs = await prisma.subscriber.findMany({
    where: { siteId: { in: siteIds } },
    orderBy: { createdAt: "desc" },
    include: { site: { select: { id: true, name: true } } },
  });
  res.json(subs);
});

// Abunəçini sil
router.delete("/:id", requireAuth, async (req, res) => {
  const siteIds = await userSiteIds(req.user.id);
  const sub = await prisma.subscriber.findFirst({ where: { id: req.params.id, siteId: { in: siteIds } } });
  if (!sub) return res.status(404).json({ error: "Not found" });
  await prisma.subscriber.delete({ where: { id: sub.id } });
  res.json({ ok: true });
});

export default router;
