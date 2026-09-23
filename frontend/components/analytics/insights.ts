// What to do next, from each listing's health (backend listing-health.js,
// worked out from figures Liston already has): groups of listings with one
// clear action each, shared by the "Growth opportunities" card and the
// Listings table's filter, so a group clicked in the card is exactly what
// the table then shows.
import type { HealthStage, ListingAnalyticsRow } from "@/lib/api";

export type ActionKey = "restock" | "watchers" | "not_shown" | "not_clicked" | "not_bought" | "declining";
export type ListingFilter = "all" | "attention" | "converting" | ActionKey;
export type Tone = "brand" | "good" | "warn" | "bad" | "neutral";

export interface ActionDef {
  key: ActionKey;
  label: string;
  action: string; // what to do, one line
  tone: Tone;
  icon: string; // an SVG path on a 16×16 grid
  test: (row: ListingAnalyticsRow) => boolean;
}

// In the order they cost money: not seen at all, seen but passed over,
// visited but not bought, then what's falling; stock and watchers first
// because they're the quickest wins.
export const ACTIONS: ActionDef[] = [
  {
    key: "restock",
    label: "Selling out soon",
    action: "Restock before your best sellers run out",
    tone: "brand",
    icon: "M3 6.5L8 3l5 3.5v6L8 16l-5-3.5z M8 9.5V16 M3 6.5l5 3 5-3",
    test: (r) => Boolean(r.health?.flags.includes("restock")),
  },
  {
    key: "watchers",
    label: "Watched, not bought",
    action: "Send the watchers an offer",
    tone: "brand",
    icon: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z M8 10a2 2 0 100-4 2 2 0 000 4z",
    test: (r) => Boolean(r.health?.flags.includes("watchers")),
  },
  {
    key: "not_shown",
    label: "Rarely shown in search",
    action: "Fill item specifics and use more of the title",
    tone: "bad",
    icon: "M7 12.5a5.5 5.5 0 100-11 5.5 5.5 0 000 11z M11 11l3.5 3.5 M5 5l4 4 M9 5L5 9",
    test: (r) => r.health?.stage === "not_shown" && r.health.problem,
  },
  {
    key: "not_clicked",
    label: "Seen, rarely clicked",
    action: "A stronger main photo and a sharper title",
    tone: "warn",
    icon: "M8 2.5l1.6 3.4 3.7.4-2.8 2.5.8 3.7L8 10.6l-3.3 1.9.8-3.7-2.8-2.5 3.7-.4z",
    test: (r) => r.health?.stage === "not_clicked" && r.health.problem,
  },
  {
    key: "not_bought",
    label: "Clicked, not bought",
    action: "Check price, postage and photos against similar listings",
    tone: "warn",
    icon: "M2 3h1.8l1.6 7.2h7.1L14 5H5 M6.5 13.5h.01 M11.5 13.5h.01",
    test: (r) => r.health?.stage === "not_bought" && r.health.problem,
  },
  {
    key: "declining",
    label: "Sales falling",
    action: "Check what changed: price, stock or a competitor",
    tone: "warn",
    icon: "M2 4l4.5 4.5 3-3L14 10 M10 10h4V6",
    test: (r) => r.health?.stage === "declining" && r.health.problem,
  },
];

export const actionDef = (key: ActionKey) => ACTIONS.find((a) => a.key === key);

export function matchesFilter(row: ListingAnalyticsRow, filter: ListingFilter): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return Boolean(row.health?.problem);
  if (filter === "converting") return row.health?.stage === "converting";
  // An unknown group (a filter saved before the groups changed) shows everything.
  return actionDef(filter)?.test(row) ?? true;
}

/** The money a group of listings could make at the account's typical rates. */
export const atStake = (rows: ListingAnalyticsRow[]) => rows.reduce((sum, r) => sum + (r.health?.problem ? (r.health.opportunity?.amount ?? 0) : 0), 0);

export const TONE: Record<Tone, { dot: string; soft: string; text: string }> = {
  brand: { dot: "bg-[var(--color-primary)]", soft: "bg-[var(--color-primary-soft)]", text: "text-[var(--color-primary)]" },
  good: { dot: "bg-emerald-500", soft: "bg-emerald-50", text: "text-emerald-700" },
  warn: { dot: "bg-amber-500", soft: "bg-[var(--color-warning-soft)]", text: "text-[#92400e]" },
  bad: { dot: "bg-[var(--color-danger)]", soft: "bg-[var(--color-danger-soft)]", text: "text-[var(--color-danger)]" },
  neutral: { dot: "bg-slate-400", soft: "bg-[var(--color-paper)]", text: "text-[var(--color-muted)]" },
};

// The table's tag for a listing's health, short enough to sit beside the
// price: problems and strong sellers only (a healthy listing needs no tag).
export const STAGE_TAG: Partial<Record<HealthStage, { label: string; tone: Tone }>> = {
  not_shown: { label: "Rarely shown", tone: "bad" },
  not_clicked: { label: "Few clicks", tone: "warn" },
  not_bought: { label: "Not buying", tone: "warn" },
  declining: { label: "Sales falling", tone: "warn" },
  converting: { label: "Selling well", tone: "good" },
  new: { label: "Settling in", tone: "neutral" },
};
