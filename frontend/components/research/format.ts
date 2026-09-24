import { currencySymbol } from "@/lib/format";

export const count = (n: number) => n.toLocaleString("en-GB");

export function money(value: number | null | undefined, currency: string, digits = 2) {
  if (value === null || value === undefined) return "—";
  const symbol = currencySymbol(currency);
  const text = value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return symbol.length <= 2 && symbol !== currency ? `${symbol}${text}` : `${text} ${currency}`;
}

// Big sums without pennies: £12,480.
export const bigMoney = (value: number | null | undefined, currency: string) =>
  value === null || value === undefined ? "—" : money(value, currency, value >= 1000 ? 0 : 2);

export const flag = (country: string | null | undefined) =>
  country && /^[A-Z]{2}$/.test(country) ? String.fromCodePoint(...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "";

// "3 days", "5 wk", "7 mo", "2.1 yr" — how long a listing has been live.
export function age(days: number | null | undefined) {
  if (days === null || days === undefined) return "";
  if (days < 14) return `${days} day${days === 1 ? "" : "s"}`;
  if (days < 60) return `${Math.round(days / 7)} wk`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  return `${(days / 365).toFixed(1)} yr`;
}
