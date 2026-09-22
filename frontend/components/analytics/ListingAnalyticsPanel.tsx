"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError, AnalyticsRange, ListingAnalytics } from "@/lib/api";
import { formatMoney, formatShortDate } from "@/lib/format";
import { useAccountEvents } from "@/lib/useAccountEvents";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { BarList } from "@/components/charts/BarList";
import { dayRangeLabel, fullNumber } from "@/components/charts/chart-format";
import { MetricsBoard } from "./MetricsBoard";
import { Funnel } from "./Funnel";
import { HintTag } from "./InsightCards";
import { RANGE_OPTIONS } from "./metrics";

// One listing's analytics in a panel that slides over the page: its
// figures for a range, the change from the period before, the day-by-day
// chart, where its views came from and a suggestion when there is one.
// Opened from the Analytics tab and from each live listing on the Listings
// tab, so neither has to leave its page. "Open in Listings" takes the seller
// to the listing on Liston's Active tab (searched by its item number), where
// it can be edited or ended — the fix happens here, not on eBay.

export function ListingAnalyticsPanel({
  connectionId,
  itemId,
  initialRange = "30d",
  onClose,
  onOpenInListings,
}: {
  connectionId: string;
  itemId: string;
  initialRange?: AnalyticsRange;
  onClose: () => void;
  // Already on the Listings tab: show the listing there instead of navigating.
  onOpenInListings?: () => void;
}) {
  const [range, setRange] = useState<AnalyticsRange>(initialRange);
  const [byKey, setByKey] = useState<Record<string, ListingAnalytics | { error: string }>>({});
  const [reload, setReload] = useState(0);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const key = `${itemId}:${range}`;
  const loaded = byKey[key];
  const data = loaded && !("error" in loaded) ? loaded : null;
  const error = loaded && "error" in loaded ? loaded.error : null;
  // Keep the last figures on screen (dimmed) while another range loads.
  const [shown, setShown] = useState<ListingAnalytics | null>(null);
  const view = data || (shown?.listing.itemId === itemId ? shown : null);

  useAccountEvents(connectionId, (event) => {
    if (event.kind === "analytics" || event.kind === "orders") {
      setByKey({});
      setReload((n) => n + 1);
    }
  });

  useEffect(() => {
    let cancelled = false;
    api
      .getListingAnalytics(connectionId, itemId, range)
      .then((d) => {
        if (cancelled) return;
        setByKey((m) => ({ ...m, [key]: d }));
        setShown(d);
      })
      .catch((err) => !cancelled && setByKey((m) => ({ ...m, [key]: { error: err instanceof ApiError ? err.message : "Couldn't load this listing's figures." } })));
    return () => {
      cancelled = true;
    };
  }, [connectionId, itemId, range, key, reload]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  // "Read this listing": only on request, labelled with its cost.
  async function readListing() {
    setReading(true);
    setReadError(null);
    try {
      await api.readListingAnalytics(connectionId, itemId, range);
      setByKey((m) => {
        const next = { ...m };
        delete next[key];
        return next;
      });
      setReload((n) => n + 1);
    } catch (err) {
      setReadError(err instanceof ApiError ? err.message : "Couldn't read this listing from eBay.");
    } finally {
      setReading(false);
    }
  }

  const listing = view?.listing;
  const rangeLabel = view ? dayRangeLabel(view.range.from, view.range.to) : "";

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Listing analytics">
      <div className="absolute inset-0 bg-[var(--color-ink)]/30 backdrop-blur-[1px] animate-[fadeIn_150ms_ease-out]" onClick={onClose} aria-hidden />
      <div className="relative flex h-full w-full max-w-[760px] flex-col bg-[var(--color-paper)] shadow-2xl animate-[slideIn_200ms_ease-out]">
        <header className="border-b border-[var(--color-line)] bg-[var(--color-panel)] px-6 py-4">
          <div className="flex items-start gap-4">
            {listing?.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={listing.imageUrl} alt="" className="h-14 w-14 flex-shrink-0 rounded-xl border border-[var(--color-line)] bg-white object-contain" />
            ) : (
              <div className="h-14 w-14 flex-shrink-0 animate-pulse rounded-xl bg-[var(--color-line)]" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-primary)]">Listing analytics</p>
              {listing ? (
                <h2 className="mt-0.5 line-clamp-2 text-[15px] font-semibold leading-snug text-[var(--color-ink)]">{listing.title}</h2>
              ) : (
                <div className="mt-1.5 h-4 w-3/4 animate-pulse rounded bg-[var(--color-line)]" />
              )}
              {listing && (
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--color-muted)]">
                  <span className="font-medium text-[var(--color-ink)]">{formatMoney(listing.price)}</span>
                  {listing.quantityAvailable != null && <span>{listing.quantityAvailable} in stock</span>}
                  {listing.quantitySold != null && <span>{fullNumber(listing.quantitySold)} sold in total</span>}
                  {listing.watchers != null && <span>{fullNumber(listing.watchers)} watching</span>}
                  {listing.startTime && <span>Listed {formatShortDate(listing.startTime)}</span>}
                  <span className="font-mono text-[11px]">#{listing.itemId}</span>
                </p>
              )}
            </div>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              {onOpenInListings ? (
                <button type="button" onClick={onOpenInListings} className="btn btn-secondary btn-sm">
                  Open in Listings
                  <ArrowIcon />
                </button>
              ) : (
                <Link href={`/accounts/${connectionId}/listings?q=${encodeURIComponent(itemId)}`} className="btn btn-secondary btn-sm">
                  Open in Listings
                  <ArrowIcon />
                </Link>
              )}
              <button ref={closeRef} type="button" onClick={onClose} className="btn btn-ghost btn-icon" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl label="Date range" value={range} onChange={setRange} options={RANGE_OPTIONS.map((r) => ({ key: r.key, label: r.label }))} />
            {view && <span className="text-[12px] text-[var(--color-muted)]">{rangeLabel}</span>}
          </div>
        </header>

        <div className={`flex-1 space-y-4 overflow-y-auto px-6 py-5 transition-opacity ${view && !data ? "opacity-60" : ""}`}>
          {error && <div className="notice notice-danger">{error}</div>}
          {view?.status === "reconnect" && <div className="notice notice-warning">Reconnect this eBay account to see its traffic. Sales below are from your orders.</div>}
          {view && view.traffic !== "measured" && !view.range.partial && view.status === "ok" && (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-3 text-[12.5px] text-[var(--color-muted)]">
              <span className="min-w-0 flex-1">
                {view.traffic === "pending"
                  ? "This listing's traffic for this range appears once its days are stored. Sales and units are exact now."
                  : "Not among eBay's 200 busiest listings every day of this range, so its traffic isn't stored day by day."}
                {readError && <span className="mt-1 block text-[var(--color-danger)]">{readError}</span>}
              </span>
              {view.canRead && (
                <button type="button" onClick={readListing} disabled={reading} className="btn btn-secondary btn-sm" title="Reads this listing's figures from eBay now, using today's allowance">
                  {reading ? "Reading…" : "Read from eBay"}
                  <span className="text-[11px] font-medium text-[var(--color-muted)]">
                    {view.readCalls} {view.readCalls === 1 ? "call" : "calls"}
                  </span>
                </button>
              )}
            </div>
          )}

          {view?.hint && (
            <div className="flex items-start gap-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4">
              <HintTag hint={view.hint} />
              <p className="text-[13px] leading-relaxed text-[var(--color-ink)]">{view.hint.detail}</p>
            </div>
          )}

          <MetricsBoard
            compact
            totals={view?.totals ?? null}
            changes={view?.changes ?? null}
            series={view?.series ?? []}
            previousSeries={view?.previousSeries ?? null}
            leadInSeries={view?.leadInSeries ?? null}
            currency={view?.currency ?? null}
            range={range}
            rangeLabel={rangeLabel}
            previousRange={view?.previous ? view.range.previous : null}
            loading={!view && !error}
            trafficUnavailable={view ? view.traffic !== "measured" : false}
            emptyDailyMessage="Day-by-day traffic for this listing appears as its days are stored. Sales show every day."
          />

          {view && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <section className="card p-5">
                <h3 className="text-[13px] font-semibold text-[var(--color-ink)]">From shown to sold</h3>
                <div className="mt-3">
                  <Funnel impressions={view.totals.impressions} views={view.totals.views} sold={view.totals.sold} ctr={view.totals.ctr} />
                </div>
              </section>
              <section className="card p-5">
                <h3 className="text-[13px] font-semibold text-[var(--color-ink)]">Where views came from</h3>
                <div className="mt-3">
                  <BarList items={view.sources.map((s) => ({ key: s.key, label: s.label, value: s.views }))} format={fullNumber} empty="No views recorded in this range." />
                </div>
              </section>
            </div>
          )}

          {view && (
            <p className="text-[11.5px] leading-relaxed text-[var(--color-muted)]">
              {!view.comparable && "Listed after the previous period began, so there’s no comparison. "}
              {view.traffic === "measured"
                ? "Totals are eBay’s exact figures for this range. "
                : view.range.partial
                  ? "Today’s traffic for this listing arrives once eBay closes the day. "
                  : ""}
              {view.traffic === "measured" && view.dailyTrafficDays < view.series.filter((p) => !p.partial).length && (
                <>
                  The chart has day-by-day traffic for {view.dailyTrafficDays} of {view.series.filter((p) => !p.partial).length} days (the rest aren&apos;t stored yet); sales show
                  every day.{" "}
                </>
              )}
              Sales are from your orders. Days follow your eBay site&apos;s time zone.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
