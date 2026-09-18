// Suggests description-template colour pairs (accent + header) from a store
// logo. The logo is shrunk to a handful of pixels, similar colours are
// bucketed, and the most-used saturated ones become accents, each paired
// with a dark that either comes from the logo itself or is a neutral that
// keeps the accent readable.
const sharp = require('sharp');

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 6 * 1024 * 1024;

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

function toHex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

async function fetchImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Liston/1.0' } });
    if (!res.ok) throw new Error(`Logo request returned ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('Logo is too large to read');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

// Returns the logo's colours, most prominent first, as { hex, share, h, s, l }.
async function extractColors(buffer) {
  const { data, info } = await sharp(buffer).resize(48, 48, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const buckets = new Map();
  let counted = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 128) continue;
    counted += 1;
    // 32-step buckets keep near-identical shades together.
    const key = `${r >> 5},${g >> 5},${b >> 5}`;
    const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.n += 1;
    buckets.set(key, bucket);
  }
  if (!counted) return [];
  return [...buckets.values()]
    .map((bk) => {
      const r = bk.r / bk.n;
      const g = bk.g / bk.n;
      const b = bk.b / bk.n;
      const [h, s, l] = rgbToHsl(r, g, b);
      return { hex: toHex(r, g, b), share: bk.n / counted, h, s, l };
    })
    .sort((a, b) => b.share - a.share);
}

function suggestPalettes(colors) {
  // Anything with some colour in it, ranked by how saturated it is with a
  // nudge for how much of the logo it covers; whites, greys and near-blacks
  // never become an accent.
  const candidates = colors
    .filter((c) => c.s >= 0.15 && c.l >= 0.12 && c.l <= 0.85 && c.share >= 0.003)
    .map((c) => ({ ...c, score: c.s * (0.5 + c.share) }))
    .sort((a, b) => b.score - a.score);
  const darks = colors.filter((c) => c.l <= 0.3 && c.share >= 0.003);
  const palettes = [];
  const seen = new Set();
  const push = (name, accent, dark) => {
    const key = `${accent}|${dark}`;
    if (seen.has(key) || accent.toLowerCase() === dark.toLowerCase()) return;
    seen.add(key);
    palettes.push({ name, accentColor: accent, darkColor: dark });
  };
  // An accent has to read against white and against the header; a very
  // dark or very pale logo colour is brought to a usable lightness on the
  // same hue.
  const usableAccent = (c) => (c.l < 0.32 || c.l > 0.72 || c.s < 0.4 ? hslToHex(c.h, Math.max(c.s, 0.6), 0.5) : c.hex);
  const deepOf = (c) => hslToHex(c.h, Math.min(0.55, Math.max(c.s, 0.3)), 0.16);

  const primary = candidates[0];
  const secondary = candidates.find((c) => primary && Math.abs(c.h - primary.h) > 0.08 && Math.abs(c.h - primary.h) < 0.92);
  const logoDark = darks[0];
  // A charcoal tinted with the logo's own hue, never the same grey for
  // every store.
  const tintedCharcoal = (c) => hslToHex(c.h, 0.3, 0.13);
  const complement = (c) => hslToHex((c.h + 0.5) % 1, Math.max(c.s, 0.55), 0.48);

  if (primary) {
    push('From your logo', usableAccent(primary), primary.l < 0.32 ? primary.hex : logoDark ? logoDark.hex : deepOf(primary));
    if (secondary) push('Second logo colour', usableAccent(secondary), logoDark ? logoDark.hex : deepOf(secondary));
    push('Deep tone', usableAccent(primary), deepOf(primary));
    push('Tinted charcoal', usableAccent(primary), tintedCharcoal(primary));
    push('Contrast', complement(primary), primary.l < 0.32 ? primary.hex : deepOf(primary));
  }
  return palettes.slice(0, 4);
}

async function palettesFromLogo(url) {
  const buffer = await fetchImage(url);
  const colors = await extractColors(buffer);
  return { colors: colors.slice(0, 6).map((c) => c.hex), palettes: suggestPalettes(colors) };
}

module.exports = { palettesFromLogo, suggestPalettes, extractColors, rgbToHsl, hslToHex };
