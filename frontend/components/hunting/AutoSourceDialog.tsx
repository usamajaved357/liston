"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, HuntAutoSource, HuntDetail, HuntSourceTry } from "@/lib/api";
import { money } from "@/components/research/format";
import { Thumb, announceHuntingChange } from "./HuntBits";

// Discover's Hunt: Liston looks for the AliExpress supplier itself — the
// listing's photo and title searched, the best matches checked the way a
// hunter's check would, one rated 4.0+ with free postage at the account's target return added
// for review (never approved as added, the owner's included: a person opens it on the Hunting
// page and approves or rejects it) — and says what it found, or why none will do, with the way to
// add a supplier link by hand. One that matches and earns but under the target
// return is shown with its figures, to add with a click if it'll do.

// Green only for one that will do, amber for a match under the target return, rose for a loss; the
// rest (paid postage, missing variations) plain, whatever they'd earn.
const tone = (t: HuntSourceTry) =>
  t.profit === null ? "" : t.ok ? "text-emerald-700" : t.belowTarget ? "text-amber-700" : t.profit <= 0 ? "text-rose-600" : "text-[var(--color-muted)]";

/** One AliExpress product Liston looked at: its photo, how it was found, and what it made of it. */
export function SourceTryRow({ t, currency }: { t: HuntSourceTry; currency: string }) {
  return (
    <li className="flex items-center gap-2.5 py-2">
      <Thumb src={t.imageUrl} size={34} />
      <div className="min-w-0 flex-1">
        <a href={t.url} target="_blank" rel="noreferrer" className="block truncate text-[12px] font-medium text-[var(--color-ink)] hover:text-[var(--color-primary)] hover:underline">
          {t.title || "AliExpress product"}
        </a>
        <p className="truncate text-[11px] text-[var(--color-muted)]">
          {t.via === "image" ? "Photo match" : "Title match"}
          {t.rating ? ` · ${t.rating} stars` : ""}
          {t.roi !== null ? ` · ${t.roi}% return` : ""}
          {t.why ? (t.belowTarget ? " · Matches, " : " · ") : ""}
          {t.why ? <span className={t.belowTarget ? "text-amber-800" : undefined}>{t.belowTarget ? t.why.replace(/^\S+ return, /, "") : t.why}</span> : null}
        </p>
      </div>
      {t.profit !== null && <span className={`text-[12px] font-semibold tabular-nums ${tone(t)}`}>{money(t.profit, currency)}</span>}
    </li>
  );
}

export function AutoSourceDialog({
  connectionId,
  competitorUrl,
  currency,
  onClose,
  onOpenHunt,
  onManual,
}: {
  connectionId: string;
  competitorUrl: string;
  currency: string;
  onClose: () => void;
  onOpenHunt: (id: string) => void;
  onManual: (competitorUrl: string) => void;
}) {
  const [state, setState] = useState<{ result?: HuntAutoSource; error?: string } | null>(null);
  // A match under the target return, added by the seller's click: adding, added, or why it couldn't be.
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<HuntDetail | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api
      .huntAutoSource(connectionId, competitorUrl)
      .then((result) => {
        setState({ result });
        if (result.found && !result.belowTarget) announceHuntingChange();
      })
      .catch((err) => setState({ error: err instanceof ApiError ? err.message : "Couldn't look for a supplier just now. Try again." }));
  }, [connectionId, competitorUrl]);

  const working = !state;
  const result = state?.result;

  async function addAnyway() {
    if (!result?.found || !result.belowTarget) return;
    setAdding(true);
    setAddError(null);
    try {
      setAdded(await api.huntAdd(connectionId, { checkId: result.checkId, note: result.addNote }));
      announceHuntingChange();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Couldn't add it just now. Try again.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={working ? undefined : onClose}>
      <div role="dialog" aria-modal="true" aria-label="Finding a supplier" className="w-full max-w-lg rounded-2xl bg-[var(--color-panel)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {working ? (
          <div className="py-6 text-center" aria-live="polite">
            <span className="mx-auto block h-7 w-7 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-hidden />
            <p className="mt-4 text-[14px] font-semibold text-[var(--color-ink)]">Finding a supplier on AliExpress</p>
            <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-[var(--color-muted)]">
              Searching by the listing&apos;s photo and title, then checking the closest matches: rated 4.0 stars or more, free postage, selling what sells, at your target return. About ten seconds.
            </p>
          </div>
        ) : state?.error ? (
          <>
            <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Couldn&apos;t look for a supplier</h2>
            <p className="mt-2 text-[13px] text-[var(--color-muted)]">{state.error}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
                Close
              </button>
              <button type="button" onClick={() => onManual(competitorUrl)} className="btn btn-primary btn-sm">
                Add a supplier link myself
              </button>
            </div>
          </>
        ) : result?.found && result.belowTarget && !added ? (
          <>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Matching supplier, under your target</p>
            <h2 className="mt-0.5 text-[15px] font-semibold text-[var(--color-ink)]">
              {result.supplier.roi}% return against your {result.targetRoi}% target
            </h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
              It&apos;s the same product, rated 4.0 stars or more, with free postage, and sells what the listing sells. It earns{" "}
              {result.supplier.profit !== null ? <b className="font-semibold text-[var(--color-ink)]">{money(result.supplier.profit, currency)}</b> : "less"} a sale at the
              competitor&apos;s price, less than you aim for. Nothing is added unless you add it.
            </p>
            <div className="mt-3 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
              <Thumb src={result.supplier.imageUrl} size={48} />
              <div className="min-w-0 flex-1">
                <a href={result.supplier.url} target="_blank" rel="noreferrer" className="line-clamp-2 text-[12.5px] font-medium leading-snug text-[var(--color-ink)] hover:underline">
                  {result.supplier.title}
                </a>
                <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">
                  {result.supplier.rating} stars · {result.supplier.roi}% return · {result.supplier.via === "image" ? "found by its photo" : "found by its title"}
                </p>
              </div>
              {result.supplier.profit !== null && <span className="text-[14px] font-semibold tabular-nums text-amber-700">{money(result.supplier.profit, currency)}</span>}
            </div>
            {result.note && <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-900">{result.note}</p>}
            {result.tried.length > 1 && (
              <>
                <p className="mt-3 text-[11.5px] font-medium text-[var(--color-muted)]">All {result.tried.length} checked</p>
                <ul className="mt-1 max-h-[200px] divide-y divide-[var(--color-line)] overflow-y-auto rounded-xl border border-[var(--color-line)] px-3">
                  {result.tried.map((t) => (
                    <SourceTryRow key={t.url} t={t} currency={currency} />
                  ))}
                </ul>
              </>
            )}
            {addError && <p className="mt-2 text-[12px] text-rose-600">{addError}</p>}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={onClose} disabled={adding} className="btn btn-ghost btn-sm">
                Close
              </button>
              <button type="button" onClick={() => onManual(competitorUrl)} disabled={adding} className="btn btn-ghost btn-sm">
                Add a different supplier
              </button>
              <button type="button" onClick={addAnyway} disabled={adding} className="btn btn-primary btn-sm">
                {adding ? "Adding…" : "Add it for review"}
              </button>
            </div>
          </>
        ) : result?.found ? (
          <>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Supplier found</p>
            <h2 className="mt-0.5 text-[15px] font-semibold text-[var(--color-ink)]">Added to Waiting for review</h2>
            <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">It isn&apos;t approved until someone opens it on the Hunting page and approves it; it drafts itself then.</p>
            <div className={`mt-3 flex items-center gap-3 rounded-xl border p-3 ${result.belowTarget ? "border-amber-200 bg-amber-50/60" : "border-emerald-200 bg-emerald-50/60"}`}>
              <Thumb src={result.supplier.imageUrl} size={48} />
              <div className="min-w-0 flex-1">
                <a href={result.supplier.url} target="_blank" rel="noreferrer" className="line-clamp-2 text-[12.5px] font-medium leading-snug text-[var(--color-ink)] hover:underline">
                  {result.supplier.title}
                </a>
                <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">
                  {result.supplier.rating} stars · {result.supplier.roi}% return · {result.supplier.via === "image" ? "found by its photo" : "found by its title"}
                </p>
              </div>
              {result.supplier.profit !== null && <span className={`text-[14px] font-semibold tabular-nums ${result.belowTarget ? "text-amber-700" : "text-emerald-700"}`}>{money(result.supplier.profit, currency)}</span>}
            </div>
            {result.tried.length > 1 && <p className="mt-2 text-[11.5px] text-[var(--color-muted)]">The best of {result.tried.length} AliExpress products checked.</p>}
            {result.note && <p className="mt-1.5 text-[11.5px] text-amber-800">{result.note}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
                Keep discovering
              </button>
              <button type="button" onClick={() => onOpenHunt(added?.id ?? (result.belowTarget ? "" : result.hunt.id))} className="btn btn-primary btn-sm">
                Open it
              </button>
            </div>
          </>
        ) : result ? (
          <>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-rose-600">No supplier found</p>
            <h2 className="mt-0.5 text-[15px] font-semibold text-[var(--color-ink)]">Nothing added</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-muted)]">{result.reason}</p>
            {result.note && <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-900">{result.note}</p>}
            {result.tried.length > 0 && (
              <ul className="mt-3 max-h-[260px] divide-y divide-[var(--color-line)] overflow-y-auto rounded-xl border border-[var(--color-line)] px-3">
                {result.tried.map((t) => (
                  <SourceTryRow key={t.url} t={t} currency={currency} />
                ))}
              </ul>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
                Close
              </button>
              <button type="button" onClick={() => onManual(competitorUrl)} className="btn btn-primary btn-sm">
                Add a supplier link myself
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
