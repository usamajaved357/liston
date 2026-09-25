// How fast a listing delivers, next to how fast the account does. A seller
// whose postage policy delivers in 5–7 working days competes with other
// 5–7 day listings, not with next-day ones: research compares like with
// like. Pure: dates and policies in, working-day windows and a verdict out.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Working days (Mon–Fri) from `from` until `to`, at least 0. */
function workingDaysBetween(from, to) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 0;
  let days = 0;
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (day.getTime() < last) {
    day.setTime(day.getTime() + DAY_MS);
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
}

/** A listing's delivery window in working days from now, or null. */
function listingWindow(item, now = Date.now()) {
  const dates = item.deliveryDates;
  if (!dates?.min && !dates?.max) return null;
  const min = workingDaysBetween(now, dates.min || dates.max);
  const max = workingDaysBetween(now, dates.max || dates.min);
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

// A postage service's working days from its code when eBay's list doesn't
// have it: "UK_OtherCourier5To7Days" → 5–7, "UK_Parcelforce48" → 2.
function transitFromCode(code) {
  const text = String(code || '');
  const range = /(\d+)\s*To\s*(\d+)\s*(Day|WorkingDay|BusinessDay)/i.exec(text);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const hours = /(24|48|72)(?!\d)/.exec(text);
  if (hours) return { min: Number(hours[1]) / 24, max: Number(hours[1]) / 24 };
  return null;
}

/**
 * The account's delivery window in working days: its postage policy's
 * handling time plus the first domestic service's transit (eBay's list,
 * else read from the service code). Null when the policy says nothing
 * usable. { min, max, handling, service, transit }
 */
function accountWindow(policy, services = []) {
  if (!policy) return null;
  const handling = policy.handlingTime?.value !== undefined ? Number(policy.handlingTime.value) : null;
  const domestic = (policy.shippingOptions || []).find((o) => o.optionType === 'DOMESTIC') || (policy.shippingOptions || [])[0];
  const service = [...(domestic?.shippingServices || [])].sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99))[0];
  const code = service?.shippingServiceCode || null;
  const listed = services.find((s) => s.service === code);
  const transit = listed && listed.max !== null ? { min: listed.min ?? listed.max, max: listed.max } : transitFromCode(code);
  if (handling === null && !transit) return null;
  const h = handling ?? 0;
  return {
    min: h + (transit?.min ?? 0),
    max: h + (transit?.max ?? transit?.min ?? 0),
    handling: handling,
    service: code,
    serviceName: listed?.description || null,
    transit,
    policyName: policy.name || null,
  };
}

/**
 * Where a listing's delivery sits next to the account's: 'similar' (the
 * windows overlap), 'faster', 'slower', or 'unknown' (no dates from eBay).
 */
function compare(window, account) {
  if (!window || !account) return 'unknown';
  if (window.max < account.min) return 'faster';
  if (window.min > account.max) return 'slower';
  return 'similar';
}

module.exports = { workingDaysBetween, listingWindow, transitFromCode, accountWindow, compare };
