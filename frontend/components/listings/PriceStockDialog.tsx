"use client";

import { useEffect, useMemo, useState } from "react";
import { api, ApiError, ListingStock, ListingStockRow } from "@/lib/api";
import { currencySymbol } from "@/lib/format";

// The Listings tab's "Price & stock": a live listing's price and the
// quantity left to buy, or each variation's, changed on eBay the way Seller
// Hub's own quick edit does it. Nothing else on the listing is sent (no
// title, photos, description or specifics), so eBay doesn't take it as a
// revision of the listing. Opens with what eBay has now; only what's
// changed goes; a change eBay refuses is said on its row and the rest stay.

type Values = Record<string, { price: string; quantity: string }>;

const PRICE_RE = /^\d+(\.\d{1,2})?$/;
const priceText = (row: ListingStockRow) => (row.price ? row.price.amount.toFixed(2) : "");
const valuesOf = (stock: ListingStock): Values => Object.fromEntries(stock.rows.map((r) => [r.key, { price: priceText(r), quantity: String(r.available) }]));

function rowState(row: ListingStockRow, value: { price: string; quantity: string } | undefined) {
  const price = (value?.price ?? "").trim();
  const quantity = (value?.quantity ?? "").trim();
  const priceOk = PRICE_RE.test(price) && Number(price) > 0;
  const quantityOk = /^\d+$/.test(quantity) && Number(quantity) <= 100000;
  const priceChanged = priceOk && (!row.price || Math.abs(Number(price) - row.price.amount) >= 0.005);
  const quantityChanged = quantityOk && Number(quantity) !== row.available;
  return { price, quantity, priceOk, quantityOk, priceChanged, quantityChanged, changed: priceChanged || quantityChanged };
}

export function PriceStockDialog({
  connectionId,
  itemId,
  title,
  imageUrl,
  onClose,
  onSaved,
}: {
  connectionId: string;
  itemId: string;
  title: string;
  imageUrl: string | null;
  onClose: () => void;
  // What eBay now has, after a change went (some or all of it).
  onSaved: (stock: ListingStock) => void;
}) {
  const [stock, setStock] = useState<ListingStock | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [bulk, setBulk] = useState({ price: "", quantity: "" });

  useEffect(() => {
    let live = true;
    api
      .getListingStock(connectionId, itemId)
      .then((s) => {
        if (!live) return;
        setStock(s);
        setValues(valuesOf(s));
      })
      .catch((err) => live && setLoadError(err instanceof ApiError ? err.message : "Couldn't read this listing's price and stock from eBay."));
    return () => {
      live = false;
    };
  }, [connectionId, itemId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const states = useMemo(() => new Map((stock?.rows || []).map((r) => [r.key, rowState(r, values[r.key])])), [stock, values]);
  const changedRows = (stock?.rows || []).filter((r) => states.get(r.key)?.changed);
  const invalid = (stock?.rows || []).some((r) => {
    const s = states.get(r.key)!;
    return !s.priceOk || !s.quantityOk;
  });
  const symbol = currencySymbol(stock?.currency);

  const set = (key: string, field: "price" | "quantity", value: string) => {
    setValues((v) => ({ ...v, [key]: { ...v[key], [field]: value } }));
    setRowErrors((errors) => {
      if (!(key in errors)) return errors;
      const rest = { ...errors };
      delete rest[key];
      return rest;
    });
    setNotice(null);
    setError(null);
  };
  const applyBulk = () => {
    if (!stock) return;
    setValues((v) => {
      const next = { ...v };
      for (const r of stock.rows) next[r.key] = { price: bulk.price.trim() || next[r.key].price, quantity: bulk.quantity.trim() || next[r.key].quantity };
      return next;
    });
    setBulk({ price: "", quantity: "" });
  };

  async function save() {
    if (!stock || !changedRows.length || invalid) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const changes = changedRows.map((r) => {
        const s = states.get(r.key)!;
        return { key: r.key, ...(s.priceChanged ? { price: s.price } : {}), ...(s.quantityChanged ? { quantity: Number(s.quantity) } : {}) };
      });
      const out = await api.updateListingStock(connectionId, itemId, changes);
      const failed = out.results.filter((r) => !r.ok);
      if (out.results.some((r) => r.ok)) onSaved(out.listing);
      if (!failed.length) {
        onClose();
        return;
      }
      // What went is now what eBay has; what didn't keeps what was typed, with eBay's reason.
      const typed = values;
      setStock(out.listing);
      const fresh = valuesOf(out.listing);
      for (const f of failed) if (typed[f.key]) fresh[f.key] = typed[f.key];
      setValues(fresh);
      setRowErrors(Object.fromEntries(failed.map((f) => [f.key, f.error || "eBay didn't take this change."])));
      const went = out.results.length - failed.length;
      setNotice(went ? `${went} of ${out.results.length} changes went to eBay. The rest are marked below.` : null);
      if (!went) setError(stock.variation ? "eBay didn't take these changes. The reasons are on each option." : failed[0]?.error || "eBay didn't take this change.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't reach eBay. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const field = "input !h-9 text-[13px] tabular-nums";
  const changedField = "!border-[var(--color-primary)] !bg-[var(--color-primary-soft)]/40";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:px-4" onClick={() => !saving && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Price and stock: ${title}`}
        className="flex max-h-[calc(100dvh-1rem)] w-full max-w-2xl flex-col rounded-t-2xl bg-[var(--color-panel)] shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-[var(--color-line)] px-5 py-4">
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt="" className="h-11 w-11 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-cover" />
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Price and stock</h2>
            <p className="truncate text-[12.5px] text-[var(--color-muted)]" title={title}>
              {title} · #{itemId}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)]">
            <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="flex items-start gap-2 rounded-lg bg-[var(--color-paper)] px-3 py-2 text-[12px] leading-relaxed text-[var(--color-muted)]">
            <svg viewBox="0 0 16 16" fill="none" className="mt-[2px] h-3.5 w-3.5 flex-shrink-0" aria-hidden>
              <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8 7.2v3.6M8 5.2v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>
              Only the price and stock change on eBay, the way Seller Hub&apos;s quick edit does it. The title, photos, description and specifics aren&apos;t sent, so the rest of the listing stays exactly as it is.
            </span>
          </p>

          {loadError ? (
            <p className="py-10 text-center text-[13px] text-[var(--color-danger)]">{loadError}</p>
          ) : !stock ? (
            <div className="mt-4 space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded-lg bg-[var(--color-paper)]" />
              ))}
            </div>
          ) : !stock.variation ? (
            (() => {
              const row = stock.rows[0];
              const s = states.get(row.key)!;
              return (
                <div className="mt-4">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-[12px] font-semibold text-[var(--color-ink)]">Price</span>
                      <span className="relative mt-1.5 block">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-[var(--color-muted)]">{symbol}</span>
                        <input inputMode="decimal" value={values[row.key]?.price ?? ""} onChange={(e) => set(row.key, "price", e.target.value)} className={`${field} w-full pl-7 ${s.priceChanged ? changedField : ""} ${!s.priceOk ? "!border-[var(--color-danger)]" : ""}`} aria-label="Price" />
                      </span>
                    </label>
                    <label className="block">
                      <span className="text-[12px] font-semibold text-[var(--color-ink)]">Available</span>
                      <input inputMode="numeric" value={values[row.key]?.quantity ?? ""} onChange={(e) => set(row.key, "quantity", e.target.value)} className={`${field} mt-1.5 w-full ${s.quantityChanged ? changedField : ""} ${!s.quantityOk ? "!border-[var(--color-danger)]" : ""}`} aria-label="Available quantity" />
                    </label>
                  </div>
                  <p className="mt-2 text-[12px] text-[var(--color-muted)]">
                    {`${row.sold} sold so far. `}Available is what&apos;s left to buy; eBay keeps counting what has sold on top.
                  </p>
                  {s.quantityChanged && Number(s.quantity) === 0 && (
                    <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">At 0 the listing is out of stock: with eBay&apos;s out-of-stock option on it stays listed, hidden from search; without it, eBay ends the listing.</p>
                  )}
                  {rowErrors[row.key] && <p className="mt-2 text-[12px] text-[var(--color-danger)]">{rowErrors[row.key]}</p>}
                </div>
              );
            })()
          ) : (
            <div className="mt-4">
              <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-[var(--color-line)] px-3 py-2.5">
                <span className="mr-1 self-center text-[12px] font-semibold text-[var(--color-ink)]">All options</span>
                <span className="relative w-28">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12.5px] text-[var(--color-muted)]">{symbol}</span>
                  <input inputMode="decimal" value={bulk.price} onChange={(e) => setBulk((b) => ({ ...b, price: e.target.value }))} placeholder="Price" className={`${field} w-full pl-6`} aria-label="Price for every option" />
                </span>
                <input inputMode="numeric" value={bulk.quantity} onChange={(e) => setBulk((b) => ({ ...b, quantity: e.target.value }))} placeholder="Stock" className={`${field} w-24`} aria-label="Stock for every option" />
                <button type="button" onClick={applyBulk} disabled={!bulk.price.trim() && !bulk.quantity.trim()} className="btn btn-secondary btn-sm">
                  Apply to all
                </button>
              </div>

              <div className="mt-3 overflow-hidden rounded-lg border border-[var(--color-line)]">
                <div className="grid grid-cols-[minmax(0,1fr)_96px_80px_44px] items-center gap-2 bg-[var(--color-paper)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)] sm:grid-cols-[minmax(0,1fr)_110px_90px_56px]">
                  <span>{stock.axes.join(" / ") || "Option"}</span>
                  <span>Price</span>
                  <span>Available</span>
                  <span className="text-right">Sold</span>
                </div>
                <ul className="divide-y divide-[var(--color-line)]">
                  {stock.rows.map((row) => {
                    const s = states.get(row.key)!;
                    const removes = s.quantityChanged && Number(s.quantity) === 0 && row.sold === 0;
                    return (
                      <li key={row.key} className="px-3 py-2">
                        <div className="grid grid-cols-[minmax(0,1fr)_96px_80px_44px] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_110px_90px_56px]">
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] font-medium text-[var(--color-ink)]" title={row.label || undefined}>
                              {row.label}
                            </span>
                            {row.sku && <span className="block truncate font-mono text-[10.5px] text-[var(--color-muted)]">{row.sku}</span>}
                          </span>
                          <span className="relative">
                            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12.5px] text-[var(--color-muted)]">{symbol}</span>
                            <input inputMode="decimal" value={values[row.key]?.price ?? ""} onChange={(e) => set(row.key, "price", e.target.value)} className={`${field} w-full pl-6 ${s.priceChanged ? changedField : ""} ${!s.priceOk ? "!border-[var(--color-danger)]" : ""}`} aria-label={`Price of ${row.label}`} />
                          </span>
                          <input inputMode="numeric" value={values[row.key]?.quantity ?? ""} onChange={(e) => set(row.key, "quantity", e.target.value)} className={`${field} w-full ${s.quantityChanged ? changedField : ""} ${!s.quantityOk ? "!border-[var(--color-danger)]" : ""}`} aria-label={`Available of ${row.label}`} />
                          <span className="text-right text-[12.5px] tabular-nums text-[var(--color-muted)]">{row.sold}</span>
                        </div>
                        {removes && <p className="mt-1 text-[11.5px] text-amber-700">Never sold: at 0, eBay takes this option off the listing.</p>}
                        {rowErrors[row.key] && <p className="mt-1 text-[11.5px] text-[var(--color-danger)]">{rowErrors[row.key]}</p>}
                      </li>
                    );
                  })}
                </ul>
              </div>
              <p className="mt-2 text-[11.5px] text-[var(--color-muted)]">Available is what&apos;s left to buy of each option; eBay keeps counting what has sold on top.</p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-line)] px-5 py-3">
          <span className={`mr-auto text-[12.5px] ${error ? "text-[var(--color-danger)]" : notice ? "text-amber-700" : "text-[var(--color-muted)]"}`}>
            {error || notice || (invalid ? "Prices above 0 with up to two decimals, stock in whole numbers." : changedRows.length ? `${changedRows.length} ${changedRows.length === 1 ? (stock?.variation ? "option" : "change") : "options"} to update` : stock ? "Change a price or a stock figure." : "")}
          </span>
          <button type="button" onClick={onClose} disabled={saving} className="btn btn-ghost btn-sm">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving || !changedRows.length || invalid} className="btn btn-primary btn-sm">
            {saving ? "Updating eBay…" : "Update on eBay"}
          </button>
        </div>
      </div>
    </div>
  );
}
