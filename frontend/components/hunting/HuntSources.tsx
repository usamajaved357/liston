"use client";

import { FormEvent, useState } from "react";
import { api, ApiError, HuntDetail, HuntSource } from "@/lib/api";
import { money } from "@/components/research/format";
import { RatingPill, Thumb, profitInk, roiText, signedMoney } from "./HuntBits";

// A product's supplier links, on its page: the main one (its figures are the
// product's, and its draft's) and any others kept beside it with their own
// figures against the same eBay listing, to compare and to switch to. Whoever
// may change the product adds links, makes another the main one, or takes one
// off; each change checks it against the listing and the page's figures follow.

function postageText(s: HuntSource, currency: string): string {
  const p = s.postage;
  if (!p || p.basis !== "aliexpress") return "Postage not quoted";
  if (!p.cost) return "Free postage";
  return p.freeOver ? `Free over ${money(p.freeOver, currency)}` : `${money(p.cost, currency)} postage`;
}

function SourceRow({
  source,
  currency,
  target,
  canEdit,
  busy,
  onMain,
  onRemove,
}: {
  source: HuntSource;
  currency: string;
  target: number | null;
  canEdit: boolean;
  busy: string | null;
  onMain: () => void;
  onRemove: () => void;
}) {
  const working = busy === source.id;
  return (
    <li className={`flex flex-wrap items-center gap-3 px-4 py-3 ${source.main ? "bg-[var(--color-primary-soft)]/40" : ""}`}>
      <Thumb src={source.imageUrl} size={44} />
      <div className="min-w-0 flex-1 basis-[220px]">
        <div className="flex items-center gap-2">
          {source.main && (
            <span className="inline-flex h-5 flex-shrink-0 items-center rounded-full bg-[var(--color-primary)] px-2 text-[10.5px] font-semibold text-white">Main supplier</span>
          )}
          <a href={source.url} target="_blank" rel="noreferrer" className="truncate text-[12.5px] font-medium text-[var(--color-ink)] hover:text-[var(--color-primary)] hover:underline" title={source.title || source.url}>
            {source.title || source.url}
          </a>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-[var(--color-muted)]">
          <RatingPill rating={source.rating} small />
          {source.orders && <span>{source.orders} orders</span>}
          <span>{postageText(source, currency)}</span>
          {source.inStock !== null && source.options !== null && (
            <span>
              {source.inStock} of {source.options} option{source.options === 1 ? "" : "s"} in stock
            </span>
          )}
          {!source.onSale && <span className="font-medium text-rose-600">No longer on sale</span>}
          {source.addedBy && !source.main && <span>added by {source.addedBy.name}</span>}
        </p>
        {source.mismatch && <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1 text-[11.5px] text-amber-900">{source.mismatch}</p>}
      </div>
      <div className="w-[92px] flex-shrink-0 text-right">
        <p className={`text-[14px] font-semibold leading-none tabular-nums ${profitInk(source.profit, source.roi, target)}`}>{signedMoney(source.profit, currency)}</p>
        <p className="mt-1 text-[11px] tabular-nums text-[var(--color-muted)]">{roiText(source.roi)} return</p>
      </div>
      {canEdit && !source.main && source.id && (
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <button type="button" onClick={onMain} disabled={busy !== null} className="btn btn-secondary btn-sm !h-8 !text-[12px]" title="Its figures become the product's, and the draft uses it">
            {working ? "Checking…" : "Make main"}
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={busy !== null}
            aria-label="Take this supplier link off"
            title="Take this supplier link off"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
          >
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
              <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </li>
  );
}

export function HuntSources({ hunt, onChanged }: { hunt: HuntDetail; onChanged: (next: HuntDetail) => void }) {
  const canEdit = hunt.permissions.canEdit;
  const [link, setLink] = useState("");
  // What's working: "add", or a source's id (making it main, or taking it off).
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const none = hunt.sources.length === 0;

  async function run(key: string, call: () => Promise<HuntDetail>) {
    setBusy(key);
    setError(null);
    try {
      onChanged(await call());
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change it just now. Try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (await run("add", () => api.huntAddSource(hunt.id, link.trim()))) setLink("");
  }

  if (none && !canEdit) return null;
  return (
    <section className={`card overflow-hidden ${none ? "border-[var(--color-primary)]/40 ring-4 ring-[var(--color-primary-soft)]" : ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pb-2 pt-3.5">
        <h3 className="text-[14px] font-semibold text-[var(--color-ink)]">Suppliers</h3>
        <span className="text-[11.5px] text-[var(--color-muted)]">
          {none ? "None yet" : hunt.sources.length === 1 ? "The profit above is this supplier's" : "Profit on the best seller at the competitor's price, each"}
        </span>
      </div>
      {!none && (
        <ul className="divide-y divide-[var(--color-line)] border-t border-[var(--color-line)]">
          {hunt.sources.map((source) => (
            <SourceRow
              key={source.id ?? "main"}
              source={source}
              currency={hunt.currency}
              target={hunt.targetRoiPercent}
              canEdit={canEdit}
              busy={busy}
              onMain={() => source.id && run(source.id, () => api.huntMakeMainSource(hunt.id, source.id!))}
              onRemove={() => source.id && run(source.id, () => api.huntRemoveSource(hunt.id, source.id!))}
            />
          ))}
        </ul>
      )}
      {canEdit && (
        <form onSubmit={add} className="border-t border-[var(--color-line)] bg-[var(--color-paper)]/40 px-4 py-3">
          <label className="block">
            <span className="text-[12px] font-medium text-[var(--color-ink)]">{none ? "Add the AliExpress product that supplies it" : "Add another supplier link"}</span>
            <span className="mt-0.5 block text-[11.5px] text-[var(--color-muted)]">
              {none
                ? "Liston works out the profit on every option against this eBay listing, and it goes in for review."
                : "Checked against the same eBay listing and kept beside the main one, to compare. Make it main to use it."}
            </span>
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              className="input min-w-0 flex-1"
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://www.aliexpress.com/item/…"
              disabled={busy !== null}
              aria-label="AliExpress product link"
              required
            />
            <button type="submit" disabled={busy !== null || !link.trim()} className="btn btn-primary btn-sm !h-9 flex-shrink-0">
              {busy === "add" ? "Checking…" : none ? "Check and add" : "Add supplier"}
            </button>
          </div>
        </form>
      )}
      {error && <div className="notice notice-danger mx-4 mb-3 mt-1">{error}</div>}
    </section>
  );
}
