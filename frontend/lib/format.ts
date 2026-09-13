import { Money } from "@/lib/api";

const CURRENCY_SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };

export function formatMoney(money: Money | null | undefined): string {
  if (!money) return "—";
  const symbol = money.currency ? CURRENCY_SYMBOLS[money.currency] : undefined;
  return symbol ? `${symbol}${money.amount.toFixed(2)}` : `${money.amount.toFixed(2)} ${money.currency ?? ""}`.trim();
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
