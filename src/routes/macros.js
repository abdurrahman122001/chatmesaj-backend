import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

async function resolveSiteId(userId) {
  const site = await prisma.site.findFirst({ where: { ownerId: userId } });
  return site?.id;
}

router.get("/", requireAuth, async (req, res) => {
  const siteId = await resolveSiteId(req.user.id);
  if (!siteId) return res.json([]);
  const list = await prisma.macro.findMany({ where: { siteId }, orderBy: { createdAt: "desc" } });
  res.json(list);
});

router.post("/", requireAuth, async (req, res) => {
  const siteId = await resolveSiteId(req.user.id);
  if (!siteId) return res.status(400).json({ error: "No site" });
  const { name, text, tag } = req.body;
  if (!name?.trim() || !text?.trim()) return res.status(400).json({ error: "name və text tələb olunur" });
  const m = await prisma.macro.create({ data: { siteId, name: name.trim(), text: text.trim(), tag: tag?.trim() || null } });
  res.json(m);
});

router.patch("/:id", requireAuth, async (req, res) => {
  const siteId = await resolveSiteId(req.user.id);
  const existing = await prisma.macro.findFirst({ where: { id: req.params.id, siteId } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  const { name, text, tag } = req.body;
  const m = await prisma.macro.update({
    where: { id: existing.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(tag !== undefined ? { tag } : {}),
    },
  });
  res.json(m);
});

router.delete("/:id", requireAuth, async (req, res) => {
  const siteId = await resolveSiteId(req.user.id);
  const existing = await prisma.macro.findFirst({ where: { id: req.params.id, siteId } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  await prisma.macro.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});

export default router;
