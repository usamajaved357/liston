// A competitor listing's dated sales, from eBay's purchase history page
// (/bin/purchaseHistory?item=…), which a team member opens in their own
// browser and pastes into Liston. Liston never loads eBay pages itself: the
// page is the only place eBay shows when each sale happened (its dated
// sales API, Marketplace Insights, isn't granted to this app), and reading
// it from Liston's servers would break eBay's rules for its developer
// account. Pure: pasted text in, sales and the figures from them out.

const days = require('../analytics/analytics-days');

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// The zones eBay's pages print, as hours from UTC.
const ZONES = { GMT: 0, UTC: 0, BST: 1, IST: 1, WET: 0, WEST: 1, CET: 1, CEST: 2, MEZ: 1, MESZ: 2, EET: 2, EEST: 3, PST: -8, PDT: -7, MST: -7, MDT: -6, CST: -6, CDT: -5, EST: -5, EDT: -4, AEST: 10, AEDT: 11, ACST: 9.5, ACDT: 10.5, AWST: 8 };

// "25 Sep 2026 at 3:01:06pm BST" (UK, IE, AU), "Sep 25, 2026 at 3:01:06pm PDT"
// (US), and the older "25-Sep-26 15:01:06 BST".
const DATE_PATTERNS = [
  { re: /(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)\s*([A-Z]{2,5})?/gi, order: 'dmy' },
  { re: /([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)\s*([A-Z]{2,5})?/gi, order: 'mdy' },
  { re: /(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([A-Z]{2,5})?/g, order: 'dmy24' },
];

function toDate(m, order) {
  let day;
  let mon;
  let year;
  let hour;
  let minute;
  let second;
  let ampm = null;
  let zone;
  if (order === 'mdy') [, mon, day, year, hour, minute, second, ampm, zone] = m;
  else if (order === 'dmy') [, day, mon, year, hour, minute, second, ampm, zone] = m;
  else [, day, mon, year, hour, minute, second, zone] = m;
  const month = MONTHS[String(mon).slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  let y = Number(year);
  if (y < 100) y += 2000;
  let h = Number(hour);
  if (ampm) {
    const pm = /^p/i.test(ampm);
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  const offset = zone && ZONES[zone.toUpperCase()] !== undefined ? ZONES[zone.toUpperCase()] : 0;
  const ms = Date.UTC(y, month, Number(day), h, Number(minute), Number(second || 0)) - offset * 3600000;
  return Number.isFinite(ms) ? new Date(ms) : null;
}

const CURRENCY = [
  [/US\s?\$/i, 'USD'],
  [/AU\s?\$/i, 'AUD'],
  [/C\s?\$/i, 'CAD'],
  [/£/, 'GBP'],
  [/€/, 'EUR'],
  [/\$/, 'USD'],
];
const PRICE = /(US\s?\$|AU\s?\$|C\s?\$|£|€|\$)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+(?:\.\d{2}))|(\d+(?:[.,]\d{2}))\s?(€|EUR)/;
const MASK = /^\S\*{2,}\S$/;

// "color: Pink" -> "Color: Pink"; "Colour: Brown, Size: M" kept as pairs.
function variationOf(cells) {
  const pairs = [];
  for (const cell of cells) {
    for (const part of cell.split(/,\s*(?=[^,:]+:)/)) {
      const m = /^\s*([^:]{1,40}):\s*(.+?)\s*$/.exec(part);
      if (m && !PRICE.test(part)) pairs.push(`${m[1].trim().replace(/^./, (c) => c.toUpperCase())}: ${m[2].trim()}`);
    }
  }
  return pairs.join(', ');
}

/**
 * The sales in pasted purchase-history text: [{ soldAt, variation, price,
 * currency, quantity }], newest first, each sale once. Anything around the
 * table (the page's header, item details, footer) is ignored.
 */
function parse(text) {
  const clean = String(text || '').replace(/\r/g, '').replace(/ /g, ' ');
  const found = [];
  for (const { re, order } of DATE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean))) found.push({ index: m.index, end: m.index + m[0].length, date: toDate(m, order) });
  }
  found.sort((a, b) => a.index - b.index);
  const rows = [];
  const seen = new Set();
  let prevEnd = 0;
  for (const hit of found) {
    if (hit.index < prevEnd) continue; // one date read by two patterns
    const before = clean.slice(prevEnd, hit.index);
    prevEnd = hit.end;
    if (!hit.date) continue;
    // The row's cells: back from the date to the buyer's masked id (b***e),
    // on one tab-separated line or one cell a line, depending on the browser.
    const lines = before.split('\n').map((l) => l.trim()).filter(Boolean);
    const cells = [];
    for (let i = lines.length - 1; i >= 0 && cells.length < 8; i -= 1) {
      const parts = lines[i].split('\t').map((p) => p.trim()).filter(Boolean);
      cells.unshift(...parts);
      if (parts.some((p) => MASK.test(p))) break;
    }
    const maskAt = cells.findIndex((c) => MASK.test(c));
    const row = maskAt >= 0 ? cells.slice(maskAt + 1) : cells.slice(-4);
    const priceCell = [...row].reverse().find((c) => PRICE.test(c));
    if (!priceCell) continue;
    const pm = PRICE.exec(priceCell);
    // "£1,234.56" (symbol first, comma thousands) or "12,99 €" (comma decimals).
    const price = pm[2] ? Number(pm[2].replace(/,/g, '')) : Number(pm[3].replace(',', '.'));
    const symbol = pm[1] || pm[4] || '';
    const currency = (CURRENCY.find(([re]) => re.test(symbol)) || [null, null])[1];
    const after = row.slice(row.indexOf(priceCell) + 1);
    const qtyCell = after.find((c) => /^\d{1,4}$/.test(c));
    const quantity = qtyCell ? Number(qtyCell) : 1;
    const variation = variationOf(row.slice(0, row.indexOf(priceCell)));
    const key = `${hit.date.toISOString()}|${variation}|${quantity}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ soldAt: hit.date.toISOString(), variation, price: Number.isFinite(price) ? price : null, currency, quantity });
  }
  return rows.sort((a, b) => new Date(b.soldAt) - new Date(a.soldAt));
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const WINDOWS = [
  ['day', 1],
  ['d3', 3],
  ['d7', 7],
  ['d15', 15],
  ['d30', 30],
  ['d90', 90],
];

/**
 * The figures from the sales: units and orders in the last day, 3, 7, 15, 30
 * and 90 days; days since the last sale; a day, a week and a month at the
 * recent pace; the price (average, median, range, how much it moves); each
 * variation's sales; units a day for the last 30 days (in `timeZone`); and
 * the trend (the last 15 days against the 15 before). Null without sales.
 */
function insights(rows, { now = Date.now(), timeZone = 'Europe/London' } = {}) {
  const sales = (rows || []).filter((r) => r.soldAt).sort((a, b) => new Date(b.soldAt) - new Date(a.soldAt));
  if (!sales.length) return null;
  const age = (r) => (now - new Date(r.soldAt).getTime()) / DAY_MS;
  const windows = Object.fromEntries(
    WINDOWS.map(([key, n]) => {
      const inside = sales.filter((r) => age(r) <= n);
      return [key, { units: inside.reduce((s, r) => s + r.quantity, 0), orders: inside.length }];
    })
  );
  const oldest = sales[sales.length - 1];
  // The pace over the last 30 days, or since the first sale shown if that's sooner.
  const covered = Math.max(1, Math.min(30, age(oldest)));
  const perDay = round2(windows.d30.units / covered);
  const prices = sales.map((r) => r.price).filter((p) => p !== null && p !== undefined);
  const mean = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  const sd = prices.length > 1 ? Math.sqrt(prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length) : 0;

  const byVariation = new Map();
  for (const r of sales) {
    const key = r.variation || '';
    const v = byVariation.get(key) || { variation: key, units: 0, orders: 0, d7: 0, d30: 0, lastSoldAt: null };
    v.units += r.quantity;
    v.orders += 1;
    if (age(r) <= 7) v.d7 += r.quantity;
    if (age(r) <= 30) v.d30 += r.quantity;
    if (!v.lastSoldAt || new Date(r.soldAt) > new Date(v.lastSoldAt)) v.lastSoldAt = r.soldAt;
    byVariation.set(key, v);
  }
  const totalUnits = sales.reduce((s, r) => s + r.quantity, 0);

  const today = days.today(timeZone, new Date(now));
  const series = days.daysBetween(days.addDays(today, -29), today).map((day) => ({ day, units: 0, price: null, prices: [] }));
  const byDay = new Map(series.map((d) => [d.day, d]));
  for (const r of sales) {
    const d = byDay.get(days.dayOf(r.soldAt, timeZone));
    if (!d) continue;
    d.units += r.quantity;
    if (r.price !== null) d.prices.push(r.price);
  }
  const recent = windows.d15.units;
  const before = sales.filter((r) => age(r) > 15 && age(r) <= 30).reduce((s, r) => s + r.quantity, 0);
  const trend = age(oldest) < 20 ? null : before === 0 ? (recent > 0 ? 'up' : 'flat') : recent / before >= 1.25 ? 'up' : recent / before <= 0.75 ? 'down' : 'flat';

  return {
    sales: sales.length,
    units: totalUnits,
    windows,
    lastSoldAt: sales[0].soldAt,
    daysSinceLast: Math.floor(age(sales[0])),
    firstShownAt: oldest.soldAt,
    perDay,
    perWeek: round1(perDay * 7),
    perMonth: round1(perDay * 30),
    currency: sales.find((r) => r.currency)?.currency || null,
    price: prices.length
      ? { average: round2(mean), median: round2(median(prices)), low: Math.min(...prices), high: Math.max(...prices), volatility: mean ? round1((sd / mean) * 100) : 0 }
      : null,
    byVariation: [...byVariation.values()].map((v) => ({ ...v, share: totalUnits ? round1((v.units / totalUnits) * 100) : null })).sort((a, b) => b.units - a.units),
    daily: series.map(({ day, units, prices: p }) => ({ day, units, price: p.length ? round2(p.reduce((a, b) => a + b, 0) / p.length) : null })),
    trend,
    recent: sales.slice(0, 50).map((r) => ({ soldAt: r.soldAt, variation: r.variation, price: r.price, quantity: r.quantity })),
  };
}

/** The page a team member opens to copy the sales from. */
function purchaseHistoryUrl(competitorUrl, itemId) {
  let origin = 'https://www.ebay.co.uk';
  try {
    origin = new URL(competitorUrl).origin;
  } catch {
    /* the UK site */
  }
  return `${origin}/bin/purchaseHistory?item=${encodeURIComponent(itemId)}`;
}

module.exports = { parse, insights, purchaseHistoryUrl, ZONES };
