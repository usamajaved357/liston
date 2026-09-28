"use client";

import { DiscoverProduct, DiscoverWinnersFilters } from "@/lib/api";
import { ViewMenu } from "@/components/ViewMenu";

// The filters a hunter reaches for, as the app's menus (a small menu on a
// laptop, a sheet from the bottom on a phone; picking closes it), grouped
// so no menu is long: sort; price and brand; demand (sales a month,
// momentum, delivery it can match); sellers (the top seller's rating, the
// smallest seller selling it). The same bar on a subject's page (where
// `filterProducts` applies it to the products loaded) and in Winners
// (where the server applies it to the pool). A hunter starts with the
// filters a dropshipper wants — unbranded, a delivery the account can match,
// listed in the last three months, nothing they already have — and can
// clear them.

type Sort = NonNullable<DiscoverWinnersFilters["sort"]>;
type Brand = NonNullable<DiscoverWinnersFilters["brand"]>;
type Rating = NonNullable<DiscoverWinnersFilters["rating"]>;
type Size = NonNullable<DiscoverWinnersFilters["size"]>;

// Nothing set; and where a hunter starts: unbranded, a delivery the account can match, listed in the last three months, not already theirs.
export const EMPTY_FILTERS: DiscoverWinnersFilters = { sort: "score", brand: "any", rating: "any", size: "any", minSales: 0, listedWithin: null, fit: false, newOnly: false, mine: "show" };
export const DEFAULT_FILTERS: DiscoverWinnersFilters = { ...EMPTY_FILTERS, brand: "unbranded", fit: true, listedWithin: 90, mine: "hide" };
const LISTED: { key: string; label: string; short: string; days: number | null }[] = [
  { key: "0", label: "Any time", short: "Any time", days: null },
  { key: "30", label: "This month: a listing launched in the last 30 days", short: "Listed this month", days: 30 },
  { key: "90", label: "Last 3 months", short: "Listed in 3 months", days: 90 },
  { key: "180", label: "Last 6 months", short: "Listed in 6 months", days: 180 },
  { key: "365", label: "Last year", short: "Listed in a year", days: 365 },
];
const SIZES: Record<Exclude<Size, "any">, [number, number]> = { small: [0, 1000], medium: [1000, 10000], large: [10000, Infinity] };

// Price bands, as the menu offers them; the filter itself is a range.
const PRICE_BANDS: { key: string; label: string; short: string; min: number | null; max: number | null }[] = [
  { key: "any", label: "Any price", short: "Any price", min: null, max: null },
  { key: "u5", label: "Under 5", short: "Under 5", min: null, max: 5 },
  { key: "5-10", label: "5 to 10", short: "5–10", min: 5, max: 10 },
  { key: "10-25", label: "10 to 25", short: "10–25", min: 10, max: 25 },
  { key: "25-50", label: "25 to 50", short: "25–50", min: 25, max: 50 },
  { key: "50", label: "50 and over", short: "50+", min: 50, max: null },
];
const bandKey = (f: DiscoverWinnersFilters) => PRICE_BANDS.find((b) => (b.min ?? null) === (f.priceMin ?? null) && (b.max ?? null) === (f.priceMax ?? null))?.key || (f.priceMin || f.priceMax ? "custom" : "any");

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

export function countActive(f: DiscoverWinnersFilters): number {
  let n = 0;
  if (f.q) n += 1;
  if (f.fit) n += 1;
  if ((f.priceMin !== null && f.priceMin !== undefined) || (f.priceMax !== null && f.priceMax !== undefined)) n += 1;
  if (f.brand && f.brand !== "any") n += 1;
  if (f.rating && f.rating !== "any") n += 1;
  if (f.size && f.size !== "any") n += 1;
  if (f.listedWithin) n += 1;
  if (f.minSales) n += 1;
  if (f.newOnly) n += 1;
  if (f.mine === "hide") n += 1;
  return n;
}

export function DiscoverProductFilters({ filters, onChange, currency }: { filters: DiscoverWinnersFilters; onChange: (next: DiscoverWinnersFilters) => void; currency: string }) {
  const set = (patch: DiscoverWinnersFilters) => onChange({ ...filters, ...patch });
  const active = countActive(filters);
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";
  const priceKey = bandKey(filters);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative min-w-[170px] flex-1 sm:max-w-[240px]">
        <span className="sr-only">Words in the product</span>
        <svg viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted)]" aria-hidden>
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
          <path d="M16 16l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={filters.q || ""}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Words in the product"
          className="h-7 w-full rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] pl-8 pr-3 text-[12px] text-[var(--color-ink)] placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] focus:outline-none"
        />
      </label>

      <ViewMenu
        title="Sort"
        sections={[
          {
            label: "Sort by",
            value: filters.sort || "score",
            onChange: (sort) => set({ sort: sort as Sort }),
            options: [
              { key: "score", label: "Best to hunt" },
              { key: "sales", label: "Most sales a month" },
              { key: "rising", label: "Rising fastest" },
              { key: "new", label: "Newest listing" },
              { key: "price", label: "Priciest" },
            ],
          },
        ]}
      />

      <ViewMenu
        title="Price and brand"
        label="Price and brand"
        sections={[
          {
            label: `Price (${symbol}, with postage)`,
            value: priceKey,
            hideInSummary: priceKey === "any",
            onChange: (key) => {
              const band = PRICE_BANDS.find((b) => b.key === key);
              set({ priceMin: band?.min ?? null, priceMax: band?.max ?? null });
            },
            options: [...PRICE_BANDS.map((b) => ({ key: b.key, label: b.label, short: `${symbol}${b.short.replace("Any price", "").trim()}`.replace(/^£$|^€$|^\$$/, "Any price") })), ...(priceKey === "custom" ? [{ key: "custom", label: "Custom range", short: "Custom" }] : [])],
          },
          {
            label: "Brand",
            value: filters.brand || "any",
            hideInSummary: !filters.brand || filters.brand === "any",
            onChange: (brand) => set({ brand: brand as Brand }),
            options: [
              { key: "any", label: "Any brand" },
              { key: "unbranded", label: "Unbranded: what a supplier can provide", short: "Unbranded" },
              { key: "branded", label: "Branded" },
            ],
          },
        ]}
      />

      <ViewMenu
        title="Demand and delivery"
        label="Demand and delivery"
        sections={[
          {
            label: "Sales a month",
            value: String(filters.minSales || 0),
            hideInSummary: !filters.minSales,
            onChange: (v) => set({ minSales: Number(v) }),
            options: [
              { key: "0", label: "Any sales" },
              { key: "10", label: "10 or more a month", short: "10+/mo" },
              { key: "50", label: "50 or more a month", short: "50+/mo" },
              { key: "150", label: "150 or more a month", short: "150+/mo" },
            ],
          },
          {
            label: "Listed",
            value: String(filters.listedWithin || 0),
            hideInSummary: !filters.listedWithin,
            onChange: (key) => set({ listedWithin: LISTED.find((l) => l.key === key)?.days ?? null }),
            options: LISTED.map((l) => ({ key: l.key, label: l.label, short: l.short })),
          },
          {
            label: "Momentum",
            value: filters.newOnly ? "new" : "all",
            hideInSummary: !filters.newOnly,
            onChange: (v) => set({ newOnly: v === "new" }),
            options: [
              { key: "all", label: "All products" },
              { key: "new", label: "New or rising: launched lately and selling, or selling faster lately", short: "New or rising" },
            ],
          },
          {
            label: "Delivery",
            value: filters.fit ? "fit" : "any",
            hideInSummary: !filters.fit,
            onChange: (v) => set({ fit: v === "fit" }),
            options: [
              { key: "any", label: "Any delivery" },
              { key: "fit", label: "I can match: 40%+ of its sales from sellers delivering like me or slower", short: "I can match" },
            ],
          },
        ]}
      />

      <ViewMenu
        title="Sellers"
        label="Sellers"
        sections={[
          {
            label: "Top seller's feedback",
            value: filters.rating || "any",
            hideInSummary: !filters.rating || filters.rating === "any",
            onChange: (rating) => set({ rating: rating as Rating }),
            options: [
              { key: "any", label: "Any rating" },
              { key: "top", label: "99% or better", short: "Top seller 99%+" },
              { key: "good", label: "98% or better", short: "Top seller 98%+" },
              { key: "weak", label: "Under 98%: room to beat them on service", short: "Top seller under 98%" },
            ],
          },
          {
            label: "Smallest seller selling it monthly",
            value: filters.size || "any",
            hideInSummary: !filters.size || filters.size === "any",
            onChange: (size) => set({ size: size as Size }),
            options: [
              { key: "any", label: "Any size" },
              { key: "small", label: "Under 1,000 reviews: a newcomer can too", short: "A small seller sells it" },
              { key: "medium", label: "1,000 to 10,000 reviews", short: "A mid-size seller sells it" },
              { key: "large", label: "10,000 reviews or more", short: "Only big sellers sell it" },
            ],
          },
        ]}
      />

      <ViewMenu
        title="Yours"
        label="Yours"
        sections={[
          {
            label: "Products you already have",
            value: filters.mine || "show",
            hideInSummary: filters.mine !== "hide",
            onChange: (mine) => set({ mine: mine as "show" | "hide" }),
            options: [
              { key: "show", label: "Show them, marked Yours" },
              { key: "hide", label: "Hide ones you sell, listed, drafted or hunted", short: "Not yours yet" },
            ],
          },
        ]}
      />

      {active > 0 && (
        <button type="button" onClick={() => onChange({ ...EMPTY_FILTERS, sort: filters.sort })} className="text-[12px] font-medium text-[var(--color-primary)] hover:underline">
          Clear {active} filter{active === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
