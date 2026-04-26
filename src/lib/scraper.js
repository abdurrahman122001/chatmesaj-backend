// Sadə URL scraper — fetch + HTML-dən mətn çıxarma
// Dependency-siz (heç bir kitabxana yoxdur)

const UA = "Mozilla/5.0 (compatible; ChatbotKnowledgeBot/1.0)";

function stripTags(html) {
  // script, style, nav, footer — mətn olmayan hissələri sil
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  // HTML etiketləri
  text = text.replace(/<[^>]+>/g, " ");
  // HTML entity-ləri
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-zA-Z]+;/g, " ");
  // Boşluqları normallaşdır
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (m) return m[1].trim();
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return og[1].trim();
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1) return h1[1].trim();
  return null;
}

export async function scrapeUrl(url) {
  if (!url?.trim()) throw new Error("URL tələb olunur");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) throw new Error("URL HTML deyil");

  const html = await res.text();
  const title = extractTitle(html) || url;
  const content = stripTags(html);
  if (content.length < 50) throw new Error("Səhifədə kifayət qədər mətn tapılmadı");

  // Çox böyükdürsə 30k simvola kəs
  const trimmed = content.length > 30000 ? content.slice(0, 30000) + "…" : content;
  return { title, content: trimmed };
}
