"use client";

import { DiscoverProduct, DiscoverWinnersFilters } from "@/lib/api";
import { SegmentedControl } from "@/components/charts/SegmentedControl";

// The filters a hunter reaches for, in one bar: words, sort, a price
// range, branded or not, delivery it can match, sales a month, momentum,
// the top seller's rating and the smallest seller selling it. The same bar
// on a subject's page (where `filterProducts` applies it to the products
// loaded) and in Winners (where the server applies it to the pool).

type Sort = NonNullable<DiscoverWinnersFilters["sort"]>;
type Brand = NonNullable<DiscoverWinnersFilters["brand"]>;
type Rating = NonNullable<DiscoverWinnersFilters["rating"]>;
type Size = NonNullable<DiscoverWinnersFilters["size"]>;
type Sales = "0" | "10" | "50" | "150";

export const DEFAULT_FILTERS: DiscoverWinnersFilters = { sort: "score", brand: "any", rating: "any", size: "any", minSales: 0 };
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
    if (f.brand === "unbranded" && p.branded !== false) return false;
    if (f.brand === "branded" && p.branded !== true) return false;
    if (f.rating === "top" && !(p.seller.percentage !== null && p.seller.percentage >= 99)) return false;
    if (f.rating === "good" && !(p.seller.percentage !== null && p.seller.percentage >= 98)) return false;
    if (f.rating === "weak" && !(p.seller.percentage !== null && p.seller.percentage < 98)) return false;
    if (size && !(p.smallestSellerScore !== null && p.smallestSellerScore >= size[0] && p.smallestSellerScore < size[1])) return false;
    if (f.minSales && p.perMonth < f.minSales) return false;
    if (f.newOnly && p.momentum !== "new" && p.momentum !== "rising") return false;
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
  if (f.priceMin !== null && f.priceMin !== undefined) n += 1;
  if (f.priceMax !== null && f.priceMax !== undefined) n += 1;
  if (f.brand && f.brand !== "any") n += 1;
  if (f.rating && f.rating !== "any") n += 1;
  if (f.size && f.size !== "any") n += 1;
  if (f.minSales) n += 1;
  if (f.newOnly) n += 1;
  return n;
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{label}</span>
      {children}
    </div>
  );
}

function Amount({ value, onChange, placeholder, label }: { value: number | null | undefined; onChange: (v: number | null) => void; placeholder: string; label: string }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      step="0.5"
      aria-label={label}
      value={value === null || value === undefined ? "" : value}
      onChange={(e) => onChange(e.target.value === "" ? null : Math.max(0, Number(e.target.value)))}
      placeholder={placeholder}
      className="h-7 w-[72px] rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-2.5 text-[12px] tabular-nums text-[var(--color-ink)] placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] focus:outline-none"
    />
  );
}

export function DiscoverProductFilters({ filters, onChange, currency, compact = false }: { filters: DiscoverWinnersFilters; onChange: (next: DiscoverWinnersFilters) => void; currency: string; compact?: boolean }) {
  const set = (patch: DiscoverWinnersFilters) => onChange({ ...filters, ...patch });
  const active = countActive(filters);
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="relative min-w-[180px] flex-1 sm:max-w-[260px]">
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
        <Group label="Sort">
          <SegmentedControl<Sort>
            label="Sort"
            size="sm"
            value={filters.sort || "score"}
            onChange={(sort) => set({ sort })}
            options={[
              { key: "score", label: "Best to hunt" },
              { key: "sales", label: "Most sales" },
              { key: "rising", label: "Rising" },
              { key: "new", label: "Newest" },
              { key: "price", label: "Priciest" },
            ]}
          />
        </Group>
        {active > 0 && (
          <button type="button" onClick={() => onChange({ ...DEFAULT_FILTERS, sort: filters.sort })} className="text-[12px] font-medium text-[var(--color-primary)] hover:underline">
            Clear {active} filter{active === 1 ? "" : "s"}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Group label="Price">
          <Amount value={filters.priceMin} onChange={(priceMin) => set({ priceMin })} placeholder={`${symbol} min`} label="Lowest price" />
          <span className="text-[11px] text-[var(--color-muted)]">to</span>
          <Amount value={filters.priceMax} onChange={(priceMax) => set({ priceMax })} placeholder={`${symbol} max`} label="Highest price" />
        </Group>
        <Group label="Brand">
          <SegmentedControl<Brand>
            label="Brand"
            size="sm"
            value={filters.brand || "any"}
            onChange={(brand) => set({ brand })}
            options={[
              { key: "any", label: "Any" },
              { key: "unbranded", label: "Unbranded", title: "No brand on its listing: what a supplier can provide" },
              { key: "branded", label: "Branded" },
            ]}
          />
        </Group>
        <Group label="Delivery">
          <SegmentedControl<"any" | "fit">
            label="Delivery"
            size="sm"
            value={filters.fit ? "fit" : "any"}
            onChange={(v) => set({ fit: v === "fit" })}
            options={[
              { key: "any", label: "Any" },
              { key: "fit", label: "I can match", title: "At least 40% of its sales come from sellers delivering like you or slower" },
            ]}
          />
        </Group>
        <Group label="Sales">
          <SegmentedControl<Sales>
            label="Sales a month"
            size="sm"
            value={String(filters.minSales || 0) as Sales}
            onChange={(v) => set({ minSales: Number(v) })}
            options={[
              { key: "0", label: "Any" },
              { key: "10", label: "10+" },
              { key: "50", label: "50+" },
              { key: "150", label: "150+" },
            ]}
          />
        </Group>
        {!compact && (
          <Group label="Momentum">
            <SegmentedControl<"all" | "new">
              label="Momentum"
              size="sm"
              value={filters.newOnly ? "new" : "all"}
              onChange={(v) => set({ newOnly: v === "new" })}
              options={[
                { key: "all", label: "All" },
                { key: "new", label: "New or rising", title: "A listing launched in the last 90 days already selling, or selling faster lately than over its life" },
              ]}
            />
          </Group>
        )}
        <Group label="Top seller's rating">
          <SegmentedControl<Rating>
            label="Seller rating"
            size="sm"
            value={filters.rating || "any"}
            onChange={(rating) => set({ rating })}
            options={[
              { key: "any", label: "Any" },
              { key: "top", label: "99%+" },
              { key: "good", label: "98%+" },
              { key: "weak", label: "Under 98%", title: "The top seller's feedback is weak: room to beat them on service" },
            ]}
          />
        </Group>
        <Group label="Smallest seller selling it">
          <SegmentedControl<Size>
            label="Seller size"
            size="sm"
            value={filters.size || "any"}
            onChange={(size) => set({ size })}
            options={[
              { key: "any", label: "Any" },
              { key: "small", label: "Under 1k reviews", title: "A small seller sells it every month: a newcomer can too" },
              { key: "medium", label: "1k–10k" },
              { key: "large", label: "10k+" },
            ]}
          />
        </Group>
      </div>
    </div>
  );
}
