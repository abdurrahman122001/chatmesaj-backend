import geoip from "geoip-lite";
import { UAParser } from "ua-parser-js";

// ISO2 → tam ad (ən istifadə edilənlər; lazım olsa genişləndir)
const COUNTRY_NAMES = {
  AZ: "Azerbaijan", TR: "Turkey", RU: "Russia", US: "United States", GB: "United Kingdom",
  DE: "Germany", FR: "France", IT: "Italy", ES: "Spain", UA: "Ukraine", GE: "Georgia",
  IR: "Iran", KZ: "Kazakhstan", UZ: "Uzbekistan", NL: "Netherlands", PL: "Poland",
  SE: "Sweden", NO: "Norway", FI: "Finland", DK: "Denmark", CA: "Canada", AU: "Australia",
  JP: "Japan", CN: "China", IN: "India", BR: "Brazil", MX: "Mexico", AR: "Argentina",
  AE: "United Arab Emirates", SA: "Saudi Arabia", EG: "Egypt", IL: "Israel",
};

export function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.toString().split(",")[0].trim();
  const xri = req.headers["x-real-ip"];
  if (xri) return xri.toString();
  // Remove IPv6 prefix "::ffff:"
  const ip = (req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  return ip;
}

export function lookupIp(ip) {
  if (!ip) return null;
  // localhost / private — geoip-də olmur
  if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) {
    return { country: null, countryName: null, city: null, region: null, timezone: null, isLocal: true };
  }
  const geo = geoip.lookup(ip);
  if (!geo) return null;
  return {
    country: geo.country,
    countryName: COUNTRY_NAMES[geo.country] || geo.country,
    city: geo.city || null,
    region: geo.region || null,
    timezone: geo.timezone || null,
    ll: geo.ll,
    isLocal: false,
  };
}

export function parseUserAgent(ua) {
  if (!ua) return {};
  const p = new UAParser(ua).getResult();
  const browser = p.browser?.name ? `${p.browser.name} ${p.browser.version?.split(".")[0] || ""}`.trim() : null;
  const os = p.os?.name ? `${p.os.name} ${p.os.version || ""}`.trim() : null;
  const deviceType = p.device?.type; // mobile/tablet/...
  const device = deviceType ? deviceType.charAt(0).toUpperCase() + deviceType.slice(1) : "Desktop";
  return { browser, os, device };
}

export function collectVisitorInfo(req, extra = {}) {
  const ip = getClientIp(req);
  const ua = req.headers["user-agent"] || "";
  const geo = lookupIp(ip) || {};
  const parsed = parseUserAgent(ua);
  return {
    ip,
    userAgent: ua,
    country: geo.country || null,
    countryName: geo.countryName || null,
    city: geo.city || null,
    region: geo.region || null,
    timezone: geo.timezone || null,
    browser: parsed.browser || null,
    os: parsed.os || null,
    device: parsed.device || null,
    referrer: extra.referrer || req.headers.referer || null,
    currentUrl: extra.currentUrl || null,
    language: extra.language || req.headers["accept-language"]?.split(",")[0] || null,
  };
}
