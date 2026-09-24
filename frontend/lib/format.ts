import { Money } from "@/lib/api";

const CURRENCY_SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };

export function formatMoney(money: Money | null | undefined): string {
  if (!money) return "—";
  const symbol = money.currency ? CURRENCY_SYMBOLS[money.currency] : undefined;
  return symbol ? `${symbol}${money.amount.toFixed(2)}` : `${money.amount.toFixed(2)} ${money.currency ?? ""}`.trim();
}

export function currencySymbol(code: string | null | undefined): string {
  return (code && CURRENCY_SYMBOLS[code]) || code || "";
}

// "£6.99" from a numeric string/number and a code.
export function formatPrice(value: string | number, currency: string): string {
  const n = typeof value === "number" ? value : parseFloat(value);
  if (Number.isNaN(n)) return `${currencySymbol(currency)}${value}`;
  const symbol = CURRENCY_SYMBOLS[currency];
  return symbol ? `${symbol}${n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`;
}

// Turns a raw scraped/API price string ("GBP 1.42", "GBP 1.42 - 5.99") into
// symbol form ("£1.42", "£1.42 – 5.99"); anything unrecognised is returned as-is.
export function prettyPriceText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\b(GBP|USD|EUR)\s*/g, (_, code) => CURRENCY_SYMBOLS[code] || `${code} `)
    .replace(/\s*-\s*/g, " – ");
}

// Every formatter takes an optional IANA time zone: an account's pages pass
// the account's (useAccountTimeZone), so dates read as eBay shows them; left
// out, the viewer's own.
export function formatDate(iso: string | null, timeZone?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone });
}

export function formatShortDate(iso: string | null, timeZone?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone });
}

export function formatTime(iso: string | null, timeZone?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone });
}

/** A calendar day ("2026-09-23") plus some days, as "27 Sept", whatever the viewer's time zone. */
export function formatDay(day: string, plus = 0): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + plus)).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatDateTime(iso: string | null, timeZone?: string): string {
  if (!iso) return "—";
  return `${formatShortDate(iso, timeZone)}, ${formatTime(iso, timeZone)}`;
}

const DIAL_CODES: Record<string, string> = { GB: "+44", UK: "+44", US: "+1", CA: "+1", AU: "+61", DE: "+49", FR: "+33", IT: "+39", ES: "+34", IE: "+353", NL: "+31", BE: "+32", AT: "+43", CH: "+41", PL: "+48" };
const COUNTRY_NAMES: Record<string, string> = { "united kingdom": "GB", "great britain": "GB", "united states": "US", canada: "CA", australia: "AU", germany: "DE", france: "FR", italy: "IT", spain: "ES", ireland: "IE", netherlands: "NL", belgium: "BE", austria: "AT", switzerland: "CH", poland: "PL" };

// A phone number the way Seller Hub prints it: with the country code, and
// the national part split in two ("+44 17683 62328"). "07417 352555" on a UK
// address → "+44 7417 352555"; a number that already carries a code is
// kept. `country` may be an ISO code or a country name.
export function internationalPhone(raw: string, country: string | undefined | null): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return raw;
  let code = "";
  let national = digits;
  if (digits.startsWith("+")) {
    const known = Object.values(DIAL_CODES).sort((a, b) => b.length - a.length).find((c) => digits.startsWith(c));
    if (!known) return digits;
    code = known;
    national = digits.slice(known.length);
  } else if (digits.startsWith("00")) {
    return internationalPhone(`+${digits.slice(2)}`, country);
  } else {
    const iso = country ? DIAL_CODES[country.toUpperCase()] ? country.toUpperCase() : COUNTRY_NAMES[country.toLowerCase()] : undefined;
    code = iso ? DIAL_CODES[iso] : "";
    if (!code) return raw;
    national = digits.replace(/^0/, "");
  }
  const split = national.length >= 9 ? Math.min(5, national.length - 5) : Math.floor(national.length / 2);
  return `${code} ${national.slice(0, split)} ${national.slice(split)}`.trim();
}
