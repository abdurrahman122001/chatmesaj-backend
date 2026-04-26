import { prisma } from "../db.js";

const MIN_SCORE = 0.05;
const TOP_N = 3;

// Stop-words (həm az, həm ümumi söz) — axtarışa salmırıq.
const STOP = new Set([
  "və", "ve", "ilə", "ile", "üçün", "ucun", "a", "an", "the", "is", "are", "was",
  "of", "in", "on", "at", "to", "for", "by", "with", "from",
  "nə", "ne", "necə", "nece", "niyə", "niye", "kim", "hansı", "hansi",
  "bu", "o", "var", "yox", "olar", "mən", "men", "siz", "sen", "mənim", "menim",
]);

// Bir token-in başqa token-in prefiksi (≥3 simvol) olub-olmamasını yoxlayır.
// Məsələn "saatları" və "saatlar" uyğunlaşsın, amma "iş" və "ödəniş" uyğunlaşmasın.
function anyTokenStartsWith(tokenSet, needle) {
  if (!needle || needle.length < 3) return false;
  for (const t of tokenSet) {
    if (t.length >= 3 && (t.startsWith(needle) || needle.startsWith(t))) return true;
  }
  return false;
}

function tokenize(q) {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/**
 * Knowledge base-də axtarış. Əvvəl Postgres FTS (varsa),
 * əks halda ILIKE-əsaslı sadə scoring ilə işləyir.
 */
export async function searchKnowledge(siteId, question) {
  if (!question || !question.trim()) return { matches: [], bestScore: 0 };

  // 1) FTS cəhd et (search_vector sütunu varsa)
  try {
    const results = await prisma.$queryRawUnsafe(
      `
      SELECT id, title, content, url, tags,
             ts_rank_cd(search_vector, websearch_to_tsquery('simple', $2)) AS score
      FROM "KnowledgeEntry"
      WHERE "siteId" = $1
        AND status = 'ACTIVE'
        AND search_vector @@ websearch_to_tsquery('simple', $2)
      ORDER BY score DESC
      LIMIT ${TOP_N}
      `,
      siteId,
      question
    );
    const matches = results.filter((r) => Number(r.score) >= MIN_SCORE);
    if (matches.length) {
      return { matches, bestScore: Number(matches[0].score) };
    }
  } catch {
    // search_vector yoxdursa ILIKE fallback-a düş
  }

  // 2) Fallback: ILIKE token scoring
  const tokens = tokenize(question);
  if (!tokens.length) return { matches: [], bestScore: 0 };

  // Bütün ACTIVE entry-ləri çək (real-world-də minlərlə olmaz; lazım olsa index/FTS tətbiq edilər)
  const entries = await prisma.knowledgeEntry.findMany({
    where: { siteId, status: "ACTIVE" },
    select: { id: true, title: true, content: true, url: true, tags: true },
  });

  const scored = entries.map((e) => {
    const titleTokens = new Set(tokenize(e.title || ""));
    const contentTokens = new Set(tokenize(e.content || ""));
    const tagTokens = new Set(tokenize((e.tags || []).join(" ")));
    let score = 0;
    for (const t of tokens) {
      // Dəqiq söz match-i
      if (titleTokens.has(t)) score += 3;
      else if (anyTokenStartsWith(titleTokens, t)) score += 2; // "saatları" ilə "saatlar" uyğunlaşması
      if (tagTokens.has(t)) score += 2;
      else if (anyTokenStartsWith(tagTokens, t)) score += 1;
      if (contentTokens.has(t)) score += 1;
      else if (anyTokenStartsWith(contentTokens, t)) score += 0.5;
    }
    return { ...e, score };
  });

  const matches = scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  return { matches, bestScore: matches[0]?.score || 0 };
}

/**
 * Məhsul axtarışı — ad, təsvir və tag-lər üzrə token-əsaslı scoring.
 */
export async function searchProducts(siteId, question) {
  if (!question || !question.trim()) return { matches: [], bestScore: 0 };
  const tokens = tokenize(question);
  if (!tokens.length) return { matches: [], bestScore: 0 };

  const entries = await prisma.product.findMany({
    where: { siteId, status: "ACTIVE" },
    select: { id: true, name: true, description: true, price: true, currency: true, url: true, imageUrl: true, sku: true, tags: true },
  });

  const scored = entries.map((e) => {
    const nameTokens = new Set(tokenize(e.name || ""));
    const descTokens = new Set(tokenize(e.description || ""));
    const tagTokens = new Set(tokenize((e.tags || []).join(" ")));
    let score = 0;
    for (const t of tokens) {
      if (nameTokens.has(t)) score += 3;
      else if (anyTokenStartsWith(nameTokens, t)) score += 2;
      if (tagTokens.has(t)) score += 2;
      else if (anyTokenStartsWith(tagTokens, t)) score += 1;
      if (descTokens.has(t)) score += 1;
      else if (anyTokenStartsWith(descTokens, t)) score += 0.5;
    }
    return { ...e, score };
  });

  const matches = scored.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, TOP_N);
  return { matches, bestScore: matches[0]?.score || 0 };
}

/**
 * Məhsul cavabı formatla — qiymət və link ilə.
 */
export function formatProductAnswer(matches) {
  if (!matches.length) return null;
  const lines = matches.map((p) => {
    const price = p.price != null ? ` — ${Number(p.price).toLocaleString("az")} ${p.currency || "AZN"}` : "";
    const link = p.url ? `\n   🔗 ${p.url}` : "";
    const desc = p.description ? `\n   ${p.description.slice(0, 160)}${p.description.length > 160 ? "…" : ""}` : "";
    return `🛍 ${p.name}${price}${desc}${link}`;
  });
  return `Sizin üçün tapdım:\n\n${lines.join("\n\n")}`;
}

/**
 * Bot cavabı formatlayır (knowledge match-lərdən)
 */
export function formatBotAnswer(matches) {
  if (!matches.length) return null;
  const top = matches[0];
  let text = top.content.trim();
  // İlk 600 simvol kəs
  if (text.length > 600) text = text.slice(0, 600) + "…";

  let reply = `📚 ${top.title}\n\n${text}`;
  if (top.url) reply += `\n\n🔗 Ətraflı: ${top.url}`;

  if (matches.length > 1) {
    reply += `\n\n---\nƏlaqəli mövzular:\n`;
    reply += matches.slice(1).map((m) => `• ${m.title}`).join("\n");
  }
  return reply;
}
