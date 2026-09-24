// A listing's health for a range, from figures Liston already has (no eBay
// calls): where buyers drop off on the way from search to sale, why that
// is likely, and roughly what it costs.
//
// Every listing walks the same path — shown in search (impressions) →
// clicked (click-through) → bought (conversion) — and each step is judged
// against THIS account's normal rate (the median of its listings with
// enough data), not a fixed number: 1% click-through is poor for a store
// that usually gets 3% and fine for one that gets 0.8%. The first weak step
// is the problem. A listing is only judged once it has had a fair chance:
// live for 7 days and seen/visited enough for a rate to mean something.
//
// Money at stake is what the listing would sell at the account's normal
// rate for its weak step, over the same days — a rough, honest ranking of
// where fixing pays most, not a forecast.

const MIN_AGE_DAYS = 7;
const MIN_IMPRESSIONS = 300; // for a click-through verdict
const MIN_VIEWS = 30; // for a conversion verdict
const MIN_BENCHMARK_LISTINGS = 5;
const WEAK = 0.6; // below 60% of the account's normal rate is weak
const NOT_SHOWN = 0.35; // below 35% of the normal daily impressions is "rarely shown"
const STRONG = 1.5; // 150% of the normal conversion is "selling well"
const DECLINE = 0.6; // selling ≤60% of the previous period's units
// A weak step is only worth the seller's attention when fixing it would
// sell at least half a unit more over the range; below that it is noted on
// the listing ("minor") but kept out of "Needs attention".
const MIN_STAKE_UNITS = 0.5;
// Used only when an account has too few listings with enough data for its
// own normal: typical eBay rates, deliberately modest.
const FALLBACK = { impressionsPerDay: 50, ctr: 0.015, conversion: 0.02 };

const STAGES = {
  new: { label: 'Settling in', tone: 'neutral', problem: false },
  unmeasured: { label: 'Traffic not stored yet', tone: 'neutral', problem: false },
  low_data: { label: 'Not enough data yet', tone: 'neutral', problem: false },
  not_shown: { label: 'Rarely shown in search', tone: 'bad', problem: true },
  not_clicked: { label: 'Seen, rarely clicked', tone: 'warn', problem: true },
  not_bought: { label: 'Clicked, not bought', tone: 'warn', problem: true },
  declining: { label: 'Sales falling', tone: 'warn', problem: true },
  converting: { label: 'Selling well', tone: 'good', problem: false },
  healthy: { label: 'Healthy', tone: 'good', problem: false },
};

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The account's normal rates from its listings with enough data. Each
 * entry: { impressions, views, sold, ctr, conversion, liveDays, measured }.
 */
function benchmarks(listings) {
  const seasoned = listings.filter((l) => l.measured && l.liveDays >= MIN_AGE_DAYS);
  const pick = (rows, value, fallback) => (rows.length >= MIN_BENCHMARK_LISTINGS ? median(rows.map(value)) : null) ?? fallback;
  return {
    impressionsPerDay: pick(seasoned, (l) => l.impressions / l.liveDays, FALLBACK.impressionsPerDay),
    ctr: pick(seasoned.filter((l) => l.impressions >= MIN_IMPRESSIONS && l.ctr != null), (l) => l.ctr, FALLBACK.ctr),
    conversion: pick(seasoned.filter((l) => l.views >= MIN_VIEWS), (l) => l.sold / l.views, FALLBACK.conversion),
    listings: seasoned.length,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const pct = (n) => `${round1(n * 100)}%`;

/**
 * Reasons that fit the weak step, from what's known about the listing:
 * `quality` (title length, photos, item specifics, postage…) comes from
 * Liston's own draft or a saved deeper check; `peers` is the median price
 * of the account's other listings in the same category, when known.
 */
function reasonsFor(stage, { m, bench, quality, stock, watchers, price, peerPrice, previous }) {
  const out = [];
  const add = (key, status, text, fix) => out.push({ key, status, text, ...(fix ? { fix } : {}) });
  const q = quality || {};

  if (stock === 0) add('stock', 'fail', 'Out of stock: eBay hides it from search until it has stock again.', 'restock');

  if (stage === 'not_shown' || stage === 'not_clicked') {
    if (q.titleLength != null) {
      if (q.titleLength < 60) add('title', 'fail', `The title uses ${q.titleLength} of 80 characters: more of the words buyers search for would help it show and get clicked.`, 'title');
      else add('title', 'pass', `The title uses ${q.titleLength} of 80 characters.`);
    }
  }
  if (stage === 'not_shown') {
    if (q.specificsMissing != null) {
      if (q.specificsMissing.length) {
        const names = q.specificsMissing.slice(0, 4).join(', ');
        add('specifics', 'fail', `${q.specificsMissing.length} item specific${q.specificsMissing.length === 1 ? '' : 's'} eBay recommends ${q.specificsMissing.length === 1 ? 'is' : 'are'} empty (${names}${q.specificsMissing.length > 4 ? '…' : ''}): eBay's search filters use them.`, 'specifics');
      } else add('specifics', 'pass', 'Every item specific eBay recommends is filled.');
    } else if (q.specificsCount != null) {
      if (q.specificsCount < 8) add('specifics', 'warn', `Only ${q.specificsCount} item specifics filled: eBay's search filters use them, so more usually means seen more.`, 'specifics');
      else add('specifics', 'pass', `${q.specificsCount} item specifics filled.`);
    }
    if (peerPrice && price && price > peerPrice * 1.25) add('price', 'warn', `Priced ${Math.round((price / peerPrice - 1) * 100)}% above your other listings in this category: eBay's Best Match ranks on price too.`, 'price');
  }
  if (stage === 'not_clicked') {
    add('photo', 'warn', `Clicked by ${pct(m.ctr ?? 0)} of the buyers who see it, against ${pct(bench.ctr)} across your listings: the main photo and the start of the title decide the click.`, 'photo');
    if (q.shippingCost != null) {
      if (q.shippingCost > 0) add('postage', 'warn', `Postage costs buyers ${q.currency ? `${q.currency} ` : ''}${q.shippingCost.toFixed(2)}: free postage shows in search and wins clicks.`, 'price');
      else add('postage', 'pass', 'Free postage.');
    }
  }
  if (stage === 'not_bought') {
    add('conversion', 'warn', `${m.views} views, ${m.sold} sold: ${pct(m.sold / m.views)} of visits buy, against ${pct(bench.conversion)} across your listings.`);
    if (peerPrice && price && price > peerPrice * 1.15) add('price', 'fail', `Priced ${Math.round((price / peerPrice - 1) * 100)}% above your other listings in this category.`, 'price');
    if (q.competitor && q.competitor.cheapest != null && price) {
      const gap = price + (q.shippingCost || 0) - q.competitor.cheapest;
      if (gap > 0.5) add('competitor', 'fail', `Similar listings sell from ${q.currency ? `${q.currency} ` : ''}${q.competitor.cheapest.toFixed(2)} delivered, ${gap.toFixed(2)} less than yours.`, 'price');
      else add('competitor', 'pass', 'Your delivered price is in line with similar listings.');
    }
    if (q.photos != null) {
      if (q.photos < 6) add('photos', 'warn', `Only ${q.photos} photo${q.photos === 1 ? '' : 's'}: buyers who can't see the details don't buy (eBay allows 24).`, 'photos');
      else add('photos', 'pass', `${q.photos} photos.`);
    }
    if (q.descriptionLength != null && q.descriptionLength < 400) add('description', 'warn', 'A short description: size, material, what\'s in the box and compatibility answer the questions that stop a sale.', 'description');
    if (q.shippingCost != null && q.shippingCost > 0) add('postage', 'warn', `Buyers pay ${q.shippingCost.toFixed(2)} postage on top.`, 'price');
    if (q.dispatchDays != null && q.dispatchDays > 3) add('dispatch', 'warn', `Dispatched within ${q.dispatchDays} days: buyers prefer a quicker delivery date.`);
    if (q.returnsAccepted === false) add('returns', 'warn', 'No returns: many buyers skip listings without them.');
  }
  if (stage === 'declining' && previous) {
    add('decline', 'warn', `${m.sold} sold, against ${previous.sold} in the period before: check whether the price, stock or a competitor changed.`, 'price');
  }
  if ((watchers || 0) >= 3 && !m.sold) add('watchers', 'info', `${watchers} buyers watching and none bought: an offer to them often closes the sale.`, 'offer');
  return out;
}

/**
 * The health of one listing over a range. `m` holds the range's figures
 * (impressions, views, ctr, sold, sales, conversion), `measured` whether
 * its traffic is known, `liveDays` how many of the range's days it was
 * live, `ageDays` how long ago it was listed.
 */
function diagnose({ m, measured, liveDays, ageDays, bench, previous, quality, stock, watchers, price, peerPrice, daysOfStock }) {
  const base = (stage, extra = {}) => ({ stage, label: STAGES[stage].label, tone: STAGES[stage].tone, problem: STAGES[stage].problem, ...extra });
  const flags = [];
  if (daysOfStock != null && daysOfStock < 10 && (m.sold || 0) >= 2) flags.push('restock');
  if ((watchers || 0) >= 3 && !m.sold) flags.push('watchers');

  if (ageDays != null && ageDays < MIN_AGE_DAYS) return base('new', { flags, detail: `Listed ${ageDays} day${ageDays === 1 ? '' : 's'} ago: judged once it has had a week.` });
  if (!measured) return base('unmeasured', { flags, detail: 'Its traffic for these days isn\'t stored yet, so only its sales are known.' });

  const days = Math.max(1, liveDays);
  const impressionsPerDay = m.impressions / days;
  const ctr = m.ctr;
  const conversion = m.views > 0 ? m.sold / m.views : null;
  const rates = { impressionsPerDay: round1(impressionsPerDay), ctr, conversion };
  const normal = { impressionsPerDay: round1(bench.impressionsPerDay), ctr: bench.ctr, conversion: bench.conversion };
  const unitPrice = price || (m.sold ? m.sales / m.sold : 0);
  const ctrUse = m.impressions >= MIN_IMPRESSIONS && ctr != null ? ctr : bench.ctr;
  const convUse = m.views >= MIN_VIEWS && conversion != null ? conversion : bench.conversion;
  const context = { m, bench, quality, stock, watchers, price, peerPrice, previous };
  const at = (units) => {
    const u = Math.max(0, units);
    return { units: round1(u), amount: round2(u * unitPrice) };
  };
  const verdict = (stage, units, detail) => {
    const opportunity = at(units);
    const minor = opportunity.units < MIN_STAKE_UNITS;
    return base(stage, { problem: !minor, minor, flags, rates, normal, detail, opportunity, reasons: reasonsFor(stage, context) });
  };

  if (stock === 0 || m.impressions === 0 || impressionsPerDay < bench.impressionsPerDay * NOT_SHOWN) {
    const extra = (bench.impressionsPerDay * days - m.impressions) * ctrUse * convUse;
    return verdict('not_shown', extra, `${Math.round(impressionsPerDay)} impressions a day, against ${Math.round(bench.impressionsPerDay)} for your typical listing.`);
  }
  if (m.impressions >= MIN_IMPRESSIONS && ctr != null && ctr < bench.ctr * WEAK) {
    const extra = m.impressions * (bench.ctr - ctr) * convUse;
    return verdict('not_clicked', extra, `${pct(ctr)} of the buyers who see it click, against ${pct(bench.ctr)} for your typical listing.`);
  }
  if (m.views >= MIN_VIEWS && conversion != null && conversion < bench.conversion * WEAK) {
    const extra = m.views * (bench.conversion - conversion);
    return verdict('not_bought', extra, `${pct(conversion)} of visits buy, against ${pct(bench.conversion)} for your typical listing.`);
  }
  if (previous && previous.sold >= 3 && previous.days) {
    const expected = (previous.sold / previous.days) * days;
    if (m.sold <= expected * DECLINE) {
      return verdict('declining', expected - m.sold, `${m.sold} sold, against about ${Math.round(expected)} at last period's pace.`);
    }
  }
  if ((m.sold || 0) >= 3 && conversion != null && conversion >= bench.conversion * STRONG) {
    return base('converting', { flags, rates, normal, detail: `${pct(conversion)} of visits buy, against ${pct(bench.conversion)} for your typical listing.`, reasons: [] });
  }
  if (m.impressions < MIN_IMPRESSIONS && m.views < MIN_VIEWS) {
    return base('low_data', { flags, rates, normal, detail: `${m.impressions} impressions and ${m.views} views: too few to judge yet.` });
  }
  return base('healthy', { flags, rates, normal, detail: 'Seen, clicked and bought at about your normal rates.', reasons: [] });
}

// ---- what's known about a listing's quality -----------------------------------

const textLength = (text) => String(text || '').replace(/<[^>]+>/g, ' ').replace(/[*_#>\-]/g, ' ').replace(/\s+/g, ' ').trim().length;
const filledSpecifics = (aspects) => Object.values(aspects || {}).filter((v) => (Array.isArray(v) ? v.some((x) => String(x).trim()) : String(v || '').trim())).length;

/** From Liston's own draft of a listing it published (no eBay call). */
function qualityFromDraft(draft) {
  if (!draft) return null;
  const variation = Array.isArray(draft.variants) && draft.variants.length > 0;
  return {
    source: 'draft',
    titleLength: String((variation ? draft.commonTitle : draft.title) || '').length,
    photos: Array.isArray(draft.imageUrls) ? draft.imageUrls.length : null,
    specificsCount: filledSpecifics(variation ? draft.variesBy?.aspects : draft.aspects),
    descriptionLength: textLength(variation ? draft.commonDescription : draft.description),
    categoryId: draft.categoryId ? String(draft.categoryId) : null,
  };
}

/**
 * From a deeper check: the live listing as eBay has it, the item specifics
 * its category requires or recommends, and (optionally) similar listings'
 * prices.
 */
function qualityFromItem(item, schema, competitor) {
  const filled = new Set(Object.entries(item.specifics || {}).filter(([, v]) => (v || []).some((x) => String(x).trim())).map(([k]) => k.toLowerCase()));
  for (const name of Object.keys(item.variationSpecificsSet || {})) filled.add(name.toLowerCase());
  const wanted = (schema || []).filter((a) => a.required || a.recommended);
  return {
    source: 'check',
    titleLength: String(item.title || '').length,
    photos: (item.imageUrls || []).length,
    specificsCount: filled.size,
    specificsMissing: schema ? wanted.filter((a) => !filled.has(a.name.toLowerCase())).map((a) => a.name) : null,
    specificsRecommended: schema ? wanted.length : null,
    descriptionLength: textLength(item.description),
    categoryId: item.categoryId || null,
    shippingCost: item.shipping?.cost ?? null,
    dispatchDays: item.shipping?.dispatchDays ?? null,
    returnsAccepted: item.returnsAccepted ?? null,
    currency: item.currency || null,
    competitor: competitor || null,
  };
}

/**
 * A deeper check brought up to date with an edit published from Liston,
 * without reading eBay again: the title, photos, description and item
 * specifics are now what the edit sent (so a specific it filled is no
 * longer "empty"). Postage, returns and similar listings' prices stay as
 * checked, since a live edit doesn't change them.
 */
function qualityAfterEdit(quality, draft) {
  if (!quality || !draft) return quality;
  const variation = Array.isArray(draft.variants) && draft.variants.length > 0;
  const aspects = (variation ? draft.variesBy?.aspects : draft.aspects) || {};
  const filled = new Set(
    Object.entries(aspects)
      .filter(([, v]) => (Array.isArray(v) ? v.some((x) => String(x).trim()) : String(v || '').trim()))
      .map(([k]) => k.toLowerCase())
  );
  if (variation) for (const s of draft.variesBy?.specifications || []) if (s?.name) filled.add(String(s.name).toLowerCase());
  const now = qualityFromDraft(draft);
  return {
    ...quality,
    titleLength: now.titleLength,
    photos: now.photos ?? quality.photos,
    specificsCount: filled.size,
    specificsMissing: Array.isArray(quality.specificsMissing) ? quality.specificsMissing.filter((name) => !filled.has(String(name).toLowerCase())) : quality.specificsMissing,
    descriptionLength: now.descriptionLength,
    editedAt: new Date().toISOString(),
  };
}

module.exports = { qualityFromDraft, qualityFromItem, qualityAfterEdit, MIN_STAKE_UNITS, STAGES, MIN_AGE_DAYS, MIN_IMPRESSIONS, MIN_VIEWS, FALLBACK, median, benchmarks, diagnose, reasonsFor };
