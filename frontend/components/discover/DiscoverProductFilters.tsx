"use client";

import { DiscoverProduct, DiscoverWinnersFilters } from "@/lib/api";
import { ViewMenu } from "@/components/ViewMenu";

// A hunter's filters, each its own small menu with plain names (a sheet
// from the bottom on a phone): Price, Demand, Delivery, Brand, and More for
// the rest. They start at what a dropshipper wants, not as filters to
// apply: priced £10 and over, 10+ sold a month, delivery that matches the
// account's postage policy, unbranded, nothing they already have. Reset
// puts them back. The same bar on a subject's page (where `filterProducts`
// applies it to the products loaded) and in Winners (where the server
// applies it to the pool). The words to look for are the search beside the
// page's tabs (discover-ui SearchBox), not part of this bar.

type Sort = NonNullable<DiscoverWinnersFilters["sort"]>;
type Brand = NonNullable<DiscoverWinnersFilters["brand"]>;
type Size = NonNullable<DiscoverWinnersFilters["size"]>;

export const DEFAULT_FILTERS: DiscoverWinnersFilters = {
  sort: "score",
  priceMin: 10,
  priceMax: null,
  minSales: 10,
  fit: true,
  brand: "unbranded",
  listedWithin: null,
  newOnly: false,
  mine: "hide",
  rating: "any",
  size: "any",
};
const PRICES = [null, 10, 20, 30, 50, 100];
// Sold a month, and the same as sold a day where it reads better.
const DEMAND: { min: number; label: string; short: string }[] = [
  { min: 0, label: "Any demand", short: "Any demand" },
  { min: 10, label: "10+ sold a month", short: "10+ sold a month" },
  { min: 30, label: "1+ sold a day (30+ a month)", short: "1+ sold a day" },
  { min: 60, label: "2+ sold a day (60+ a month)", short: "2+ sold a day" },
  { min: 150, label: "5+ sold a day (150+ a month)", short: "5+ sold a day" },
  { min: 300, label: "10+ sold a day (300+ a month)", short: "10+ sold a day" },
];
const LISTED: { key: string; label: string; days: number | null }[] = [
  { key: "0", label: "Any time", days: null },
  { key: "30", label: "In the last 30 days", days: 30 },
  { key: "90", label: "In the last 3 months", days: 90 },
  { key: "365", label: "In the last year", days: 365 },
];
const SIZES: Record<Exclude<Size, "any">, [number, number]> = { small: [0, 1000], medium: [1000, 10000], large: [10000, Infinity] };

/** The same rules the server applies in Winners, for products already on the page. */
export function filterProducts(products: DiscoverProduct[], f: DiscoverWinnersFilters): DiscoverProduct[] {
  const words = (f.q || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const size = f.size && f.size !== "any" ? SIZES[f.size] : null;
  const list = products.filter((p) => {
    if (words.length && !words.every((w) => p.name.toLowerCase().includes(w))) return false;
    if (f.fit && p.delivery.known && (p.delivery.share ?? 0) < 40) return false;
    if (f.priceMin !== null && f.priceMin !== undefined && (!p.price || p.price.median < f.priceMin)) return false;
    if (f.priceMax !== null && f.priceMax !== undefined && (!p.price || p.price.median > f.priceMax)) return false;
    // Unbranded: no named brand on its listings (a brand not read yet counts as none; VeRO brands are hidden before this).
    if (f.brand === "unbranded" && p.branded === true) return false;
    if (f.brand === "branded" && p.branded !== true) return false;
    if (f.listedWithin && !(p.newestDays !== null && p.newestDays <= f.listedWithin)) return false;
    if (f.rating === "top" && !(p.seller.percentage !== null && p.seller.percentage >= 99)) return false;
    if (f.rating === "good" && !(p.seller.percentage !== null && p.seller.percentage >= 98)) return false;
    if (f.rating === "weak" && !(p.seller.percentage !== null && p.seller.percentage < 98)) return false;
    if (size && !(p.smallestSellerScore !== null && p.smallestSellerScore >= size[0] && p.smallestSellerScore < size[1])) return false;
    if (f.minSales && p.perMonth < f.minSales) return false;
    if (f.newOnly && p.momentum !== "new" && p.momentum !== "rising") return false;
    // Already theirs (a similar title is only marked: it may be another product).
    if (f.mine === "hide" && p.mine && p.mine.kind !== "similar") return false;
    return true;
  });
  const by: Record<Sort, (a: DiscoverProduct, b: DiscoverProduct) => number> = {
    score: (a, b) => b.score - a.score || b.perMonth - a.perMonth,
    sales: (a, b) => b.perMonth - a.perMonth,
    rising: (a, b) => (b.lift ?? 0) - (a.lift ?? 0) || b.perMonth - a.perMonth,
    new: (a, b) => (a.newestDays ?? 1e9) - (b.newestDays ?? 1e9) || b.perMonth - a.perMonth,
    price: (a, b) => (b.price?.median ?? 0) - (a.price?.median ?? 0),
  };
  return [...list].sort(by[f.sort || "score"]);
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
/** Whether any filter has moved off where a hunter starts (the words typed don't count). */
export function changedFromDefault(f: DiscoverWinnersFilters): boolean {
  const d = DEFAULT_FILTERS;
  return (
    !same(f.priceMin, d.priceMin) ||
    !same(f.priceMax, d.priceMax) ||
    !same(f.minSales || 0, d.minSales) ||
    Boolean(f.fit) !== Boolean(d.fit) ||
    (f.brand || "any") !== d.brand ||
    !same(f.listedWithin || null, d.listedWithin) ||
    Boolean(f.newOnly) !== Boolean(d.newOnly) ||
    (f.mine || "show") !== d.mine ||
    (f.rating || "any") !== "any" ||
    (f.size || "any") !== "any"
  );
}

export function DiscoverProductFilters({
  filters,
  onChange,
  currency,
  delivery = null,
}: {
  filters: DiscoverWinnersFilters;
  onChange: (next: DiscoverWinnersFilters) => void;
  currency: string;
  // The account's delivery from its postage policy (days), when known.
  delivery?: { min: number; max: number } | null;
}) {
  const set = (patch: DiscoverWinnersFilters) => onChange({ ...filters, ...patch });
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "JPY" ? "¥" : "$";
  const days = delivery ? (delivery.min && delivery.min !== delivery.max ? `${delivery.min}–${delivery.max} days` : `${delivery.max} days`) : null;
  const priceKey = filters.priceMax ? "custom" : String(filters.priceMin ?? "any");
  const demand = DEMAND.find((d) => d.min === (filters.minSales || 0));
  const more = [filters.listedWithin ? "Listed lately" : null, filters.newOnly ? "New or rising" : null, filters.mine !== "hide" ? "Showing yours" : null].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ViewMenu
        title="Sort"
        sections={[
          {
            label: "Sort by",
            value: filters.sort || "score",
            onChange: (sort) => set({ sort: sort as Sort }),
            options: [
              { key: "score", label: "Best to hunt" },
              { key: "sales", label: "Most sold" },
              { key: "rising", label: "Rising fastest" },
              { key: "new", label: "Newest" },
              { key: "price", label: "Highest price" },
            ],
          },
        ]}
      />

      <ViewMenu
        title="Price"
        sections={[
          {
            label: "Price, with postage",
            value: priceKey,
            onChange: (key) => set({ priceMin: key === "any" ? null : Number(key), priceMax: null }),
            options: [
              ...PRICES.map((min) => (min === null ? { key: "any", label: "Any price" } : { key: String(min), label: `${symbol}${min} and over`, short: `${symbol}${min}+` })),
              ...(priceKey === "custom" ? [{ key: "custom", label: "Custom range", short: "Custom price" }] : []),
            ],
          },
        ]}
      />

      <ViewMenu
        title="Demand"
        sections={[
          {
            label: "How many sell",
            value: String(demand?.min ?? filters.minSales ?? 0),
            onChange: (v) => set({ minSales: Number(v) }),
            options: DEMAND.map((d) => ({ key: String(d.min), label: d.label, short: d.short })),
          },
        ]}
      />

      <ViewMenu
        title="Delivery"
        sections={[
          {
            label: days ? `Your delivery: ${days}` : "Delivery",
            value: filters.fit ? "fit" : "any",
            onChange: (v) => set({ fit: v === "fit" }),
            options: [
              { key: "fit", label: days ? `Matches mine (${days})` : "Matches mine", short: days ? `Delivery ${days}` : "Delivery like mine" },
              { key: "any", label: "Any delivery" },
            ],
          },
        ]}
      />

      <ViewMenu
        title="Brand"
        sections={[
          {
            label: "Brand",
            value: filters.brand || "any",
            onChange: (brand) => set({ brand: brand as Brand }),
            options: [
              { key: "unbranded", label: "Unbranded" },
              { key: "branded", label: "Branded" },
              { key: "any", label: "All", short: "Branded and unbranded" },
            ],
          },
        ]}
      />

      <ViewMenu
        title="More"
        label={more.length ? `More: ${more.join(", ")}` : "More"}
        sections={[
          {
            label: "Listed",
            value: String(filters.listedWithin || 0),
            hideInSummary: true,
            onChange: (key) => set({ listedWithin: LISTED.find((l) => l.key === key)?.days ?? null }),
            options: LISTED.map((l) => ({ key: l.key, label: l.label })),
          },
          {
            label: "Trend",
            value: filters.newOnly ? "new" : "all",
            hideInSummary: true,
            onChange: (v) => set({ newOnly: v === "new" }),
            options: [
              { key: "all", label: "Any" },
              { key: "new", label: "New or rising only" },
            ],
          },
          {
            label: "Products you already have",
            value: filters.mine || "show",
            hideInSummary: true,
            onChange: (mine) => set({ mine: mine as "show" | "hide" }),
            options: [
              { key: "hide", label: "Hide them" },
              { key: "show", label: "Show them, marked Yours" },
            ],
          },
        ]}
      />

      {changedFromDefault(filters) && (
        <button type="button" onClick={() => onChange({ ...DEFAULT_FILTERS, q: filters.q, sort: filters.sort })} className="text-[12px] font-medium text-[var(--color-primary)] hover:underline">
          Reset
        </button>
      )}
    </div>
  );
}
