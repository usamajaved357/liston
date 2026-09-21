// Number and date formatting for charts and stat tiles. Shared by every
// chart in the app so the same figure reads the same everywhere.
import { currencySymbol } from "@/lib/format";

/** 256653 → "256.7k", 1234567 → "1.2M", 950 → "950". */
export function compactNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(n / 1000)}k`;
  return Math.round(n).toLocaleString("en-GB");
}

/** Full figure with thousands separators: 256,653. */
export function fullNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-GB");
}

function trim(n: number) {
  return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

/** 0.0123 → "1.2%"; tiny rates keep a second decimal so they don't read as 0. */
export function percent(fraction: number | null | undefined): string {
  if (fraction == null || Number.isNaN(fraction)) return "—";
  const p = fraction * 100;
  if (p !== 0 && Math.abs(p) < 1) return `${p.toFixed(2)}%`;
  return `${p.toFixed(1)}%`;
}

/** A money amount in the account's currency: £1,204.50, or £12.4k in compact form. */
export function moneyAmount(amount: number | null | undefined, currency: string | null, { compact = false } = {}): string {
  if (amount == null || Number.isNaN(amount)) return "—";
  const symbol = currencySymbol(currency);
  if (compact && Math.abs(amount) >= 10_000) return `${symbol}${compactNumber(amount)}`;
  return `${symbol}${amount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Days are "YYYY-MM-DD" calendar days (eBay's reporting day); read them at
// noon UTC so no viewer's time zone shifts them to the day before.
const at = (day: string) => new Date(`${day}T12:00:00Z`);

/** "20 Sep" */
export function dayLabel(day: string): string {
  return at(day).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** "Sat 20 Sep" */
export function dayLabelLong(day: string): string {
  return at(day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** "20 Sep – 19 Oct", or one day. */
export function dayRangeLabel(from: string, to: string): string {
  return from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`;
}

/** "5 min ago", "3 h ago", "yesterday". */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** Axis ticks: a "nice" maximum and evenly spaced steps from 0. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) || 10 * magnitude;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}
