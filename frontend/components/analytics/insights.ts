// What to do next, from the figures already on the page (no eBay calls):
// groups of listings with one clear action each, shared by the "Growth
// opportunities" card and the Listings table's filter, so a group clicked
// in the card is exactly what the table then shows.
import type { AnalyticsHint, ListingAnalyticsRow } from "@/lib/api";

export type ActionKey = "restock" | "watchers" | "no_sales" | "low_ctr" | "no_impressions";
export type ListingFilter = "all" | "attention" | "converting" | ActionKey;
export type Tone = "brand" | "good" | "warn" | "bad";

export interface ActionDef {
  key: ActionKey;
  label: string;
  action: string; // what to do, one line
  tone: Tone;
  icon: string; // an SVG path on a 16×16 grid
  test: (row: ListingAnalyticsRow, days: number) => boolean;
}

/** Days of stock left at this range's pace, or null when it isn't selling. */
export function daysOfStock(row: ListingAnalyticsRow, days: number): number | null {
  if (row.quantityAvailable == null || !row.sold || days <= 0) return null;
  return row.quantityAvailable / (row.sold / days);
}

// In order of what's worth money soonest.
export const ACTIONS: ActionDef[] = [
  {
    key: "restock",
    label: "Selling out soon",
    action: "Restock before your best sellers run out",
    tone: "brand",
    icon: "M3 6.5L8 3l5 3.5v6L8 16l-5-3.5z M8 9.5V16 M3 6.5l5 3 5-3",
    test: (r, days) => (r.sold ?? 0) >= 2 && r.quantityAvailable != null && (r.quantityAvailable <= 2 || (daysOfStock(r, days) ?? Infinity) < 10),
  },
  {
    key: "watchers",
    label: "Watched, not bought",
    action: "Send watchers an offer from Seller Hub",
    tone: "brand",
    icon: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z M8 10a2 2 0 100-4 2 2 0 000 4z",
    test: (r) => (r.watchers ?? 0) >= 3 && (r.sold ?? 0) === 0,
  },
  {
    key: "no_sales",
    label: "Viewed, not selling",
    action: "Compare price and postage with similar listings",
    tone: "warn",
    icon: "M2 3h1.8l1.6 7.2h7.1L14 5H5 M6.5 13.5h.01 M11.5 13.5h.01",
    test: (r) => r.hint?.kind === "no_sales",
  },
  {
    key: "low_ctr",
    label: "Seen, rarely clicked",
    action: "Try a stronger main photo or a sharper title",
    tone: "warn",
    icon: "M8 2.5l1.6 3.4 3.7.4-2.8 2.5.8 3.7L8 10.6l-3.3 1.9.8-3.7-2.8-2.5 3.7-.4z",
    test: (r) => r.hint?.kind === "low_ctr",
  },
  {
    key: "no_impressions",
    label: "Not showing in search",
    action: "Fix title, category and item specifics",
    tone: "bad",
    icon: "M7 12.5a5.5 5.5 0 100-11 5.5 5.5 0 000 11z M11 11l3.5 3.5 M5 5l4 4 M9 5L5 9",
    test: (r) => r.hint?.kind === "no_impressions",
  },
];

export const actionDef = (key: ActionKey) => ACTIONS.find((a) => a.key === key)!;

export function matchesFilter(row: ListingAnalyticsRow, filter: ListingFilter, days: number): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return row.hint != null && row.hint.kind !== "converting";
  if (filter === "converting") return row.hint?.kind === "converting";
  return actionDef(filter).test(row, days);
}

export const TONE: Record<Tone, { dot: string; soft: string; text: string }> = {
  brand: { dot: "bg-[var(--color-primary)]", soft: "bg-[var(--color-primary-soft)]", text: "text-[var(--color-primary)]" },
  good: { dot: "bg-emerald-500", soft: "bg-emerald-50", text: "text-emerald-700" },
  warn: { dot: "bg-amber-500", soft: "bg-[var(--color-warning-soft)]", text: "text-[#92400e]" },
  bad: { dot: "bg-[var(--color-danger)]", soft: "bg-[var(--color-danger-soft)]", text: "text-[var(--color-danger)]" },
};

// The table's insight, short enough to sit beside the price.
export const HINT_SHORT: Record<AnalyticsHint["kind"], { label: string; tone: Tone }> = {
  converting: { label: "Converting well", tone: "good" },
  no_sales: { label: "Not selling", tone: "warn" },
  low_ctr: { label: "Few clicks", tone: "warn" },
  no_impressions: { label: "No impressions", tone: "bad" },
};
