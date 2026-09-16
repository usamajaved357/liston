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

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}
