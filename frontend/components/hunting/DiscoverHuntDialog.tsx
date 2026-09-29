"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, HuntFromListing } from "@/lib/api";
import { STAGE, Thumb, ago, announceHuntingChange } from "./HuntBits";

// Discover's Hunt: the eBay listing added to the hunting list on its own,
// read from eBay (its demand, price and risks), waiting for someone to add a
// supplier link on its page. A listing already on the list isn't added again:
// the dialog links to it.

export function DiscoverHuntDialog({
  connectionId,
  competitorUrl,
  onClose,
  onOpenHunt,
}: {
  connectionId: string;
  competitorUrl: string;
  onClose: () => void;
  onOpenHunt: (id: string) => void;
}) {
  const [state, setState] = useState<{ result?: HuntFromListing; error?: string } | null>(null);
  // One request per dialog, however often it renders.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api
      .huntFromListing(connectionId, competitorUrl)
      .then((result) => {
        setState({ result });
        if (result.added) announceHuntingChange();
      })
      .catch((err) => setState({ error: err instanceof ApiError ? err.message : "Couldn't add it just now. Try again." }));
  }, [connectionId, competitorUrl]);

  const working = !state;
  const result = state?.result;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={working ? undefined : onClose}>
      <div role="dialog" aria-modal="true" aria-label="Hunt this product" className="w-full max-w-md rounded-2xl bg-[var(--color-panel)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {working ? (
          <div className="py-6 text-center" aria-live="polite">
            <span className="mx-auto block h-7 w-7 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-hidden />
            <p className="mt-4 text-[14px] font-semibold text-[var(--color-ink)]">Adding it to your hunting list</p>
            <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-[var(--color-muted)]">Reading the listing on eBay: its sales, price and risks.</p>
          </div>
        ) : state?.error ? (
          <>
            <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Couldn&apos;t add it</h2>
            <p className="mt-2 text-[13px] text-[var(--color-muted)]">{state.error}</p>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
                Close
              </button>
            </div>
          </>
        ) : result && result.added ? (
          <>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-primary)]">Added to your hunting list</p>
            <h2 className="mt-0.5 text-[15px] font-semibold text-[var(--color-ink)]">Now add its supplier</h2>
            <div className="mt-3 flex items-center gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)]/60 p-3">
              <Thumb src={result.hunt.imageUrl} size={44} />
              <p className="line-clamp-2 min-w-0 flex-1 text-[12.5px] font-medium leading-snug text-[var(--color-ink)]">{result.hunt.title}</p>
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
              It waits under <b className="font-semibold text-[var(--color-ink)]">Needs a supplier</b>. Open it and paste the AliExpress product that supplies it (several if you like):
              Liston works out the profit on every option and it goes in for review.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
                Keep discovering
              </button>
              <button type="button" onClick={() => onOpenHunt(result.hunt.id)} className="btn btn-primary btn-sm">
                Open it and add a supplier
              </button>
            </div>
          </>
        ) : result && !result.added ? (
          <>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-primary)]">Already hunted</p>
            <h2 className="mt-0.5 text-[15px] font-semibold text-[var(--color-ink)]">This listing is already on your hunting list</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-muted)]">
              {result.alreadyHunted.title} was added {ago(result.alreadyHunted.createdAt)}
              {result.alreadyHunted.hunter ? ` by ${result.alreadyHunted.hunter.name}` : ""} and is {STAGE[result.alreadyHunted.stage].label.toLowerCase()}. Nothing was added again.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
                Keep discovering
              </button>
              <button type="button" onClick={() => onOpenHunt(result.alreadyHunted.id)} className="btn btn-primary btn-sm">
                Open it
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
