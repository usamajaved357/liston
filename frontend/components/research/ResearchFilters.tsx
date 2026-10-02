"use client";

import { ResearchBrandFilter, ResearchItem, ResearchMarks } from "@/lib/api";
import { ViewMenu } from "@/components/ViewMenu";
import { landed } from "./format";

// Research's filters, the way Discover's bar works (each a small menu, a
// sheet from the bottom on a phone). Price and Brand are asked of eBay, so
// the search runs again (a price range at eBay; Unbranded is eBay's own Brand
// filter in the search's main category, then any title naming a brand left
// out); the rest filter the listings already read: what a buyer pays with
// postage, sales a month (listings whose sold count is read), the seller's
// feedback and size, how new, where it's posted from, and VeRO and violations
// (hidden, or shown marked). Delivery is the row above, which the figures follow.

export interface ResearchFilterState {
  priceMin: number | null;
  priceMax: number | null;
  brand: ResearchBrandFilter;
  minSales: number;
  rating: "any" | "top" | "good";
  size: "any" | "small" | "medium" | "large";
  listedWithin: number | null;
  location: "any" | "home";
  safety: "all" | "safe";
}

export const RESEARCH_FILTERS: ResearchFilterState = {
  priceMin: null,
  priceMax: null,
  brand: "any",
  minSales: 0,
  rating: "any",
  size: "any",
  listedWithin: null,
  location: "any",
  safety: "all",
};

const MINS = [null, 5, 10, 20, 30, 50];
const MAXES = [null, 10, 20, 30, 50, 100];
const SALES: { min: number; label: string; short: string }[] = [
  { min: 0, label: "Any sales", short: "Any sales" },
  { min: 1, label: "1+ sold a month", short: "1+ a month" },
  { min: 5, label: "5+ sold a month", short: "5+ a month" },
  { min: 10, label: "10+ sold a month", short: "10+ a month" },
  { min: 30, label: "1+ sold a day (30+ a month)", short: "1+ a day" },
];
const LISTED: { key: string; label: string; days: number | null }[] = [
  { key: "0", label: "Any time", days: null },
  { key: "30", label: "In the last 30 days", days: 30 },
  { key: "90", label: "In the last 3 months", days: 90 },
  { key: "365", label: "In the last year", days: 365 },
];
const SIZES: Record<Exclude<ResearchFilterState["size"], "any">, [number, number]> = { small: [0, 1000], medium: [1000, 10000], large: [10000, Infinity] };

/** A listing that would break eBay's rules, or is like one eBay refused or removed: what "VeRO safe" hides. */
export const atRisk = (m: ResearchMarks | null) => Boolean(m && (m.violation || m.removedLike || m.risk?.level === "bad"));

/** The filters that don't need eBay, on the listings already read. */
export function filterResearch(items: ResearchItem[], f: ResearchFilterState, country: string | null): ResearchItem[] {
  return items.filter((item) => {
    const price = item.price ? landed(item) : null;
    if (f.priceMin !== null && !(price !== null && price >= f.priceMin)) return false;
    if (f.priceMax !== null && !(price !== null && price <= f.priceMax)) return false;
    // A listing whose sold count isn't read yet is kept: nothing says it doesn't sell.
    if (f.minSales && item.soldPerMonth !== null && item.soldPerMonth < f.minSales) return false;
    const pct = item.seller?.feedbackPercentage;
    if (f.rating === "top" && !(pct !== null && pct !== undefined && pct >= 99)) return false;
    if (f.rating === "good" && !(pct !== null && pct !== undefined && pct >= 98)) return false;
    if (f.size !== "any") {
      const score = item.seller?.feedbackScore;
      const [lo, hi] = SIZES[f.size];
      if (!(score !== null && score !== undefined && score >= lo && score < hi)) return false;
    }
    if (f.listedWithin && !(item.daysLive !== null && item.daysLive <= f.listedWithin)) return false;
    if (f.location === "home" && country && item.location?.country && item.location.country !== country) return false;
    if (f.safety === "safe" && atRisk(item.marks)) return false;
    return true;
  });
}

/** Whether any filter has moved from where research starts. */
export const filtersChanged = (f: ResearchFilterState) => (Object.keys(RESEARCH_FILTERS) as (keyof ResearchFilterState)[]).some((k) => f[k] !== RESEARCH_FILTERS[k]);

export function ResearchFilters({
  filters,
  onChange,
  currency,
  countryName,
  disabled = false,
}: {
  filters: ResearchFilterState;
  onChange: (next: ResearchFilterState) => void;
  currency: string;
  countryName: string | null;
  disabled?: boolean;
}) {
  const set = (patch: Partial<ResearchFilterState>) => onChange({ ...filters, ...patch });
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "JPY" ? "¥" : "$";
  const more = [
    filters.rating !== "any" ? "Top sellers" : null,
    filters.size !== "any" ? "Seller size" : null,
    filters.listedWithin ? "Listed lately" : null,
    filters.location === "home" ? `${countryName || "Home"} sellers` : null,
  ].filter(Boolean);
  return (
    <div className={`flex flex-wrap items-center gap-2 ${disabled ? "pointer-events-none opacity-60" : ""}`}>
      <ViewMenu
        title="Price"
        sections={[
          {
            label: "From (with postage)",
            value: String(filters.priceMin ?? "any"),
            onChange: (k) => set({ priceMin: k === "any" ? null : Number(k) }),
            options: MINS.map((min) => (min === null ? { key: "any", label: "No minimum", short: "Any price" } : { key: String(min), label: `${symbol}${min} and over`, short: `${symbol}${min}+` })),
          },
          {
            label: "Up to",
            value: String(filters.priceMax ?? "any"),
            onChange: (k) => set({ priceMax: k === "any" ? null : Number(k) }),
            options: MAXES.map((max) => (max === null ? { key: "any", label: "No maximum", short: "" } : { key: String(max), label: `Up to ${symbol}${max}`, short: `to ${symbol}${max}` })),
          },
        ]}
      />
      <ViewMenu
        title="Brand"
        sections={[
          {
            label: "Brand",
            value: filters.brand,
            onChange: (k) => set({ brand: k as ResearchBrandFilter }),
            options: [
              { key: "any", label: "Any brand" },
              { key: "unbranded", label: "Unbranded only" },
            ],
          },
        ]}
      />
      <ViewMenu
        title="Sales"
        sections={[
          {
            label: "Sold a month (listings with a sold count)",
            value: String(filters.minSales),
            onChange: (v) => set({ minSales: Number(v) }),
            options: SALES.map((d) => ({ key: String(d.min), label: d.label, short: d.short })),
          },
        ]}
      />
      <ViewMenu
        title="VeRO and violations"
        sections={[
          {
            label: "A VeRO brand or restricted item, or like one eBay refused or removed",
            value: filters.safety,
            onChange: (v) => set({ safety: v as ResearchFilterState["safety"] }),
            options: [
              { key: "all", label: "Show them, marked", short: "VeRO shown" },
              { key: "safe", label: "Hide them", short: "VeRO safe" },
            ],
          },
        ]}
      />
      <ViewMenu
        title="More"
        label={more.length ? `More · ${more.length}` : "More"}
        sections={[
          {
            label: "Seller's feedback",
            value: filters.rating,
            onChange: (v) => set({ rating: v as ResearchFilterState["rating"] }),
            options: [
              { key: "any", label: "Any feedback" },
              { key: "top", label: "99% and over" },
              { key: "good", label: "98% and over" },
            ],
            hideInSummary: true,
          },
          {
            label: "Seller's size",
            value: filters.size,
            onChange: (v) => set({ size: v as ResearchFilterState["size"] }),
            options: [
              { key: "any", label: "Any size" },
              { key: "small", label: "Small (under 1,000 feedback)" },
              { key: "medium", label: "Medium (1,000–10,000)" },
              { key: "large", label: "Large (10,000+)" },
            ],
            hideInSummary: true,
          },
          {
            label: "Listed",
            value: String(filters.listedWithin ?? 0),
            onChange: (v) => set({ listedWithin: LISTED.find((l) => l.key === v)?.days ?? null }),
            options: LISTED.map((l) => ({ key: l.key, label: l.label })),
            hideInSummary: true,
          },
          {
            label: "Posted from",
            value: filters.location,
            onChange: (v) => set({ location: v as ResearchFilterState["location"] }),
            options: [
              { key: "any", label: "Anywhere" },
              { key: "home", label: countryName ? `${countryName} only` : "The site's country only" },
            ],
            hideInSummary: true,
          },
        ]}
      />
      {filtersChanged(filters) && (
        <button type="button" onClick={() => onChange(RESEARCH_FILTERS)} className="h-8 rounded-full px-2.5 text-[12px] font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]">
          Reset
        </button>
      )}
    </div>
  );
}

// ---- the marks on a listing -------------------------------------------------------------

const cap = (text: string) => text.replace(/\b\w/g, (c) => c.toUpperCase());
const BADGE = "inline-flex h-[18px] items-center rounded px-1.5 text-[10.5px] font-semibold ring-1 ring-inset";

/** A listing's marks as small badges: violations and eBay's removals in red, the rest quieter. */
export function MarkBadges({ marks }: { marks: ResearchMarks | null }) {
  if (!marks) return null;
  const out: { key: string; text: string; tone: string; title: string }[] = [];
  // A brand mark is Liston's warning about listing a product like it, not eBay's word on this listing (it's live).
  if (marks.violation?.kind === "brand" && marks.violation.source === "ai")
    out.push({
      key: "vero",
      text: `Possible VeRO · ${cap(marks.violation.label)}`,
      tone: "bg-amber-50 text-amber-800 ring-amber-200",
      title: `Liston's AI reading thinks ${cap(marks.violation.label)} may be a protected brand. It isn't on Liston's VeRO list and eBay hasn't taken this listing down: check the brand before selling it.`,
    });
  else if (marks.violation?.kind === "brand")
    out.push({
      key: "vero",
      text: `VeRO brand · ${cap(marks.violation.label)}`,
      tone: "bg-rose-50 text-rose-700 ring-rose-200",
      title: `${cap(marks.violation.label)} is on Liston's list of brands whose owners report listings to eBay (VeRO). This listing is still live, but a listing like it can be taken down.`,
    });
  else if (marks.violation?.kind === "restricted")
    out.push({
      key: "restricted",
      text: marks.violation.prohibited ? "Not allowed" : "Restricted",
      tone: marks.violation.prohibited ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-amber-50 text-amber-800 ring-amber-200",
      title: `${marks.violation.label}: ${marks.violation.prohibited ? "eBay doesn't allow it" : "eBay restricts it"}`,
    });
  if (marks.removedLike) out.push({ key: "removed", text: "eBay removed one like it", tone: "bg-rose-50 text-rose-700 ring-rose-200", title: `eBay removed a listing like this in the last 90 days: ${marks.removedLike.title}` });
  if (marks.risk)
    out.push({
      key: "risk",
      text: marks.risk.kind === "rejected" ? "Your workspace rejected one like it" : "eBay refused yours like it",
      tone: marks.risk.level === "bad" ? "bg-rose-50 text-rose-700 ring-rose-200" : "bg-amber-50 text-amber-800 ring-amber-200",
      title: marks.risk.text,
    });
  if (marks.brand && marks.violation?.kind !== "brand") out.push({ key: "brand", text: `Brand · ${cap(marks.brand)}`, tone: "bg-violet-50 text-violet-700 ring-violet-200", title: "Its title names a brand: check it isn't protected before listing a product like it" });
  if (marks.hazmat) out.push({ key: "words", text: "Filtered word", tone: "bg-amber-50 text-amber-800 ring-amber-200", title: `"${marks.hazmat}" is blocked by eBay's hazardous-materials filter` });
  return (
    <>
      {out.map((b) => (
        <span key={b.key} className={`${BADGE} ${b.tone}`} title={b.title}>
          {b.text}
        </span>
      ))}
    </>
  );
}
