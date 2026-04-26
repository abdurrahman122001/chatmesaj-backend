import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const DEFAULT_SETTINGS = {
  botActive: true,
  adminPanelLanguage: "AZ",
  agentName: "Lyro",
  companyDescription: "",
  defaultLanguage: "English",
  supportedLanguages: ["English"],
  supportedMode: "specific", // "all" | "specific"
  channels: { liveChat: true, messenger: false, instagram: false, whatsapp: false, email: false },
  autoSuggestions: true,
  handoff: {
    onlineAction: "transfer", // transfer | message
    offlineAction: "message",
    offlineMessage: "Operatorlarımız offlayndır. Mesajınızı buraxın, tezliklə qayıdacağıq.",
  },
  audiences: [],
};

function mergeSettings(stored) {
  const s = stored && typeof stored === "object" ? stored : {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    channels: { ...DEFAULT_SETTINGS.channels, ...(s.channels || {}) },
    handoff: { ...DEFAULT_SETTINGS.handoff, ...(s.handoff || {}) },
    supportedLanguages: Array.isArray(s.supportedLanguages) ? s.supportedLanguages : DEFAULT_SETTINGS.supportedLanguages,
    audiences: Array.isArray(s.audiences) ? s.audiences : [],
  };
}

async function resolveOwnedSite(req) {
  if (req.query.siteId) {
    return prisma.site.findFirst({ where: { id: req.query.siteId, ownerId: req.user.id } });
  }
  return prisma.site.findFirst({ where: { ownerId: req.user.id }, orderBy: { createdAt: "asc" } });
}

// GET /api/sites/me/settings — birinci sahib olunmuş site üçün
router.get("/me/settings", requireAuth, async (req, res) => {
  const site = await resolveOwnedSite(req);
  if (!site) return res.status(404).json({ error: "Site tapılmadı" });
  res.json({ siteId: site.id, settings: mergeSettings(site.settings) });
});

// PATCH /api/sites/me/settings — partial update
router.patch("/me/settings", requireAuth, async (req, res) => {
  const site = await resolveOwnedSite(req);
  if (!site) return res.status(404).json({ error: "Site tapılmadı" });
  const current = mergeSettings(site.settings);
  const incoming = req.body && typeof req.body === "object" ? req.body : {};
  const next = {
    ...current,
    ...incoming,
    channels: { ...current.channels, ...(incoming.channels || {}) },
    handoff: { ...current.handoff, ...(incoming.handoff || {}) },
    supportedLanguages: Array.isArray(incoming.supportedLanguages) ? incoming.supportedLanguages : current.supportedLanguages,
    audiences: Array.isArray(incoming.audiences) ? incoming.audiences : current.audiences,
  };
  await prisma.site.update({ where: { id: site.id }, data: { settings: next } });
  res.json({ siteId: site.id, settings: next });
});

// Istifadəçinin sahib olduğu site-ları yenilə (quick actions, appearance, settings)
router.patch("/:id", requireAuth, async (req, res) => {
  const site = await prisma.site.findFirst({
    where: { id: req.params.id, ownerId: req.user.id },
  });
  if (!site) return res.status(404).json({ error: "Not found" });

  const { quickActions, appearance, name, settings } = req.body;
  const currentAppearance = site.appearance && typeof site.appearance === "object" ? site.appearance : {};
  const mergedAppearance = appearance !== undefined
    ? { ...currentAppearance, ...(appearance && typeof appearance === "object" ? appearance : {}) }
    : undefined;
  const updated = await prisma.site.update({
    where: { id: site.id },
    data: {
      ...(quickActions !== undefined ? { quickActions } : {}),
      ...(mergedAppearance !== undefined ? { appearance: mergedAppearance } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(settings !== undefined ? { settings } : {}),
    },
  });
  res.json(updated);
});

export default router;
