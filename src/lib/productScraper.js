// URL-dən məhsul məlumatını çıxarmağa çalışır.
// OpenGraph + schema.org/Product JSON-LD + meta etiketlərdən istifadə edir.

const UA = "Mozilla/5.0 (compatible; ChatbotProductBot/1.0)";

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-zA-Z]+;/g, " ");
}

function metaContent(html, property) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']`,
    "i"
  );
  const m = html.match(re);
  if (m) return decodeEntities(m[1].trim());
  // tərsi istiqamət (content əvvəl, property sonra)
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`,
    "i"
  );
  const m2 = html.match(re2);
  return m2 ? decodeEntities(m2[1].trim()) : null;
}

function extractJsonLdProducts(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const json = JSON.parse(m[1].trim());
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        if (!item) continue;
        if (item["@type"] === "Product" || (Array.isArray(item["@type"]) && item["@type"].includes("Product"))) {
          out.push(item);
        }
        // @graph nested
        if (Array.isArray(item["@graph"])) {
          for (const g of item["@graph"]) {
            if (g && (g["@type"] === "Product" || (Array.isArray(g["@type"]) && g["@type"].includes("Product")))) {
              out.push(g);
            }
          }
        }
      }
    } catch {
      // ignore invalid JSON
    }
  }
  return out;
}

function extractTitle(html) {
  const og = metaContent(html, "og:title");
  if (og) return og;
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (t) return decodeEntities(t[1].trim());
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1) return decodeEntities(h1[1].trim());
  return null;
}

function extractPrice(html) {
  // Ümumi meta
  const p = metaContent(html, "product:price:amount") || metaContent(html, "og:price:amount");
  if (p) {
    const n = parseFloat(p.replace(/[^\d.,]/g, "").replace(",", "."));
    if (!isNaN(n)) return n;
  }
  return null;
}

function extractCurrency(html) {
  return (
    metaContent(html, "product:price:currency") ||
    metaContent(html, "og:price:currency") ||
    null
  );
}

export async function scrapeProductUrl(url) {
  if (!url?.trim()) throw new Error("URL tələb olunur");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const html = await res.text();

  const products = extractJsonLdProducts(html);
  if (products.length > 0) {
    const p = products[0];
    const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
    const priceStr = offer?.price || offer?.lowPrice || p.price;
    const price = priceStr ? parseFloat(String(priceStr).replace(/[^\d.,]/g, "").replace(",", ".")) : null;
    const image = Array.isArray(p.image) ? p.image[0] : p.image;
    return {
      name: p.name || extractTitle(html) || url,
      description: (p.description || metaContent(html, "og:description") || "").toString().slice(0, 4000),
      price: isNaN(price) ? null : price,
      currency: offer?.priceCurrency || p.priceCurrency || extractCurrency(html) || null,
      imageUrl: image?.url || image || metaContent(html, "og:image") || null,
      sku: p.sku || null,
      url,
    };
  }

  // Fallback: OG-meta
  const name = extractTitle(html) || url;
  const description = metaContent(html, "og:description") || metaContent(html, "description") || "";
  const imageUrl = metaContent(html, "og:image") || null;
  const price = extractPrice(html);
  const currency = extractCurrency(html);

  return {
    name,
    description: description.slice(0, 4000),
    price,
    currency,
    imageUrl,
    sku: null,
    url,
  };
}
