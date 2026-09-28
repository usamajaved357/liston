"use client";

import { FormEvent, RefObject, useEffect, useId, useRef, useState } from "react";
import { api, ApiError, HuntCheckResult, HuntDetail, HuntSourceTry } from "@/lib/api";
import { Alert } from "@/components/Alert";
import { HuntResult } from "./HuntResult";
import { HuntIcon, Thumb, VERDICT, announceHuntingChange, profitInk, roiText, signedMoney } from "./HuntBits";
import { SourceTryRow } from "./AutoSourceDialog";

// "Hunt a product": paste the AliExpress product (and, optionally, the
// competitor's eBay listing), or let Liston find the supplier for the
// competitor ("Find with Liston": by its photo and title, rated 4.0+, free
// postage, at the target return), see the profit on every option, then add it
// for review from the page's footer (the owner's own finds are approved as
// they're added). Nothing is saved until Add; a check is held half an hour.

const STEPS = ["Reading the competitor on eBay", "Reading the supplier on AliExpress", "Asking AliExpress for postage", "Working out the profit on every option"];
// "Find with Liston": the supplier searched for, then the closest matches checked.
const FIND_STEPS = ["Reading the competitor on eBay", "Searching AliExpress by its photo and title", "Checking the closest matches: rating, postage, profit", "Picking the best: 4.0+ stars, free postage, your target return"];

function Progress({ step, competitor, finding = false }: { step: number; competitor: boolean; finding?: boolean }) {
  // Without a competitor, eBay isn't read.
  const steps = finding ? FIND_STEPS : competitor ? STEPS : STEPS.slice(1);
  const at = Math.min(step, steps.length - 1);
  return (
    <div className="card mt-4 p-5">
      <ol className="space-y-3">
        {steps.map((label, i) => {
          const done = i < at;
          const now = i === at;
          return (
            <li key={label} className="flex items-center gap-3 text-[13px]">
              <span
                className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border transition-colors ${
                  done ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white" : now ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-[var(--color-line)] text-[var(--color-line-strong)]"
                }`}
              >
                {done ? (
                  <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                    <path d="M5 10.5l3.2 3.2L15 6.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : now ? (
                  <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                )}
              </span>
              <span className={done ? "text-[var(--color-muted)]" : now ? "font-medium text-[var(--color-ink)]" : "text-[var(--color-muted)]"}>{label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// A link field: a link mark on the left, and on the right Paste while it's
// empty and a clear button once it has a link.
function UrlField({
  label,
  dot,
  optional,
  value,
  onChange,
  placeholder,
  inputRef,
  disabled,
  required,
  onFilled,
}: {
  label: string;
  dot: string;
  optional?: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  disabled?: boolean;
  required?: boolean;
  onFilled?: () => void;
}) {
  const id = useId();
  const own = useRef<HTMLInputElement>(null);
  const ref = inputRef || own;
  async function paste() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) {
        onChange(text);
        onFilled?.();
        return;
      }
    } catch {}
    // No clipboard access: the field, ready for Cmd/Ctrl+V.
    ref.current?.focus();
  }
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="label flex items-center gap-1.5 !text-[10px]">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} aria-hidden />
        {label} {optional && <span className="font-normal normal-case text-[var(--color-muted)]">(optional)</span>}
      </label>
      <div className="relative mt-1">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[var(--color-muted)]">
          <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
            <path d="M8.5 11.5a3.5 3.5 0 005 0l2.5-2.5a3.5 3.5 0 00-5-5l-1 1M11.5 8.5a3.5 3.5 0 00-5 0L4 11a3.5 3.5 0 005 5l1-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <input
          id={id}
          ref={ref}
          className="input"
          style={{ height: 36, fontSize: 13, paddingLeft: 32, paddingRight: value ? 38 : 64 }}
          type="url"
          inputMode="url"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={() => setTimeout(() => onFilled?.(), 0)}
          disabled={disabled}
          required={required}
        />
        <span className="absolute inset-y-0 right-1 flex items-center">
          {value ? (
            <button
              type="button"
              onClick={() => {
                onChange("");
                ref.current?.focus();
              }}
              disabled={disabled}
              aria-label={`Clear the ${label} link`}
              title="Clear"
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] disabled:opacity-40"
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={paste}
              disabled={disabled}
              className="h-7 rounded-full px-2.5 text-[11.5px] font-semibold text-[var(--color-primary)] transition-colors hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
            >
              Paste
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

export type HuntCheck = { checkId: string; result: HuntCheckResult; autoApproves: boolean };

/**
 * The form and, once read, the product's profit check. The check itself is
 * the page's (`checked`), so the page can put the Add bar in its footer.
 */
export function HuntForm({ connectionId, marketName, initialCompetitor, checked, onChecked, onClose }: { connectionId: string; marketName: string; initialCompetitor?: string | null; checked: HuntCheck | null; onChecked: (check: HuntCheck | null) => void; onClose?: () => void }) {
  const [competitorUrl, setCompetitorUrl] = useState(initialCompetitor || "");
  const [sourceUrl, setSourceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // "Find with Liston": looking, what it found (the supplier, of how many), or why none would do.
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ supplier: HuntSourceTry; checked: number; note?: string | null; targetRoi?: number } | null>(null);
  const [notFound, setNotFound] = useState<{ reason: string; tried: HuntSourceTry[]; note?: string | null } | null>(null);
  const currency = checked?.result.currency || "GBP";
  const sourceRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), finding ? 2800 : 1500);
    return () => clearInterval(timer);
  }, [busy, finding]);

  // Liston finds the supplier for the competitor: the link filled in and the check shown, to add with a note.
  async function findSupplier() {
    setBusy(true);
    setFinding(true);
    setStep(0);
    setError(null);
    setFound(null);
    setNotFound(null);
    onChecked(null);
    try {
      const data = await api.huntFindSupplier(connectionId, competitorUrl.trim());
      if (data.found) {
        setSourceUrl(data.sourceUrl);
        // Under the target return: still the supplier that matches, shown with its figures to judge.
        setFound({ supplier: data.supplier, checked: data.tried.length, note: data.note, targetRoi: data.belowTarget ? data.targetRoi : undefined });
        onChecked({ checkId: data.checkId, result: data.result, autoApproves: data.autoApproves });
        requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      } else {
        setNotFound({ reason: data.reason, tried: data.tried, note: data.note });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't look for a supplier just now. Try again.");
    } finally {
      setBusy(false);
      setFinding(false);
    }
  }

  async function check(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStep(0);
    setError(null);
    setFound(null);
    setNotFound(null);
    onChecked(null);
    try {
      const data = await api.huntCheck(connectionId, { competitorUrl: competitorUrl.trim() || undefined, sourceUrl: sourceUrl.trim() });
      onChecked(data);
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check that product. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={check} className="card overflow-hidden">
        <div className="flex items-center gap-2.5 border-b border-[var(--color-line)] bg-gradient-to-r from-[var(--color-primary-soft)] to-transparent px-4 py-2.5">
          <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)] text-white">
            <HuntIcon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-semibold leading-tight text-[var(--color-ink)]">Hunt a product</h2>
            <p className="text-[11.5px] leading-snug text-[var(--color-muted)]">
              {`Paste the AliExpress product that supplies it, and a competitor selling it on ${marketName} if you have one. You'll see the profit on every option before adding it.`}
            </p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label="Close"
              title={checked ? "Close and discard this check" : "Close"}
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-white hover:text-[var(--color-ink)] disabled:opacity-50"
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
                <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2.5 px-4 pb-3 pt-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <UrlField
            label="Competitor on eBay"
            dot="#0064D2"
            optional
            placeholder="https://www.ebay.co.uk/itm/…"
            value={competitorUrl}
            onChange={setCompetitorUrl}
            onFilled={() => !sourceUrl && sourceRef.current?.focus()}
            disabled={busy}
          />
          <UrlField label="Supplier on AliExpress" dot="#E62E04" placeholder="https://www.aliexpress.com/item/…" value={sourceUrl} onChange={setSourceUrl} inputRef={sourceRef} disabled={busy} required />
          <button type="submit" disabled={busy || !sourceUrl.trim()} className="btn btn-primary px-4 text-[13px]" style={{ height: 36 }}>
            {busy ? "Checking…" : checked ? "Check again" : "Check profit"}
          </button>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between lg:col-span-3 lg:-mt-0.5">
            <p className="text-[11px] text-[var(--color-muted)]">
              The competitor sets the market price, the best seller and how many sell. Without one, each option is priced at your target return, as a draft would be.
            </p>
            {/* No supplier yet: Liston finds one for the competitor (rated 4.0+, free postage, at the target return). */}
            <button
              type="button"
              onClick={findSupplier}
              disabled={busy || !competitorUrl.trim()}
              title={competitorUrl.trim() ? "Search AliExpress for this listing by its photo and title" : "Paste the competitor's eBay listing first"}
              className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-primary)]/30 bg-[var(--color-primary-soft)] px-3 text-[12px] font-semibold text-[var(--color-primary)] transition-colors hover:border-[var(--color-primary)]/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.7" />
                <path d="M13.2 13.2L17 17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              {finding ? "Finding a supplier…" : "No supplier? Find one with Liston"}
            </button>
          </div>
        </div>
      </form>

      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {busy && <Progress step={step} competitor={Boolean(competitorUrl.trim())} finding={finding} />}

      {notFound && (
        <div className="card mt-4 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-rose-600">No supplier found</p>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-ink)]">{notFound.reason}</p>
          {notFound.note && <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-900">{notFound.note}</p>}
          {notFound.tried.length > 0 && (
            <ul className="mt-3 max-h-[260px] divide-y divide-[var(--color-line)] overflow-y-auto rounded-xl border border-[var(--color-line)] px-3">
              {notFound.tried.map((t) => (
                <SourceTryRow key={t.url} t={t} currency={currency} />
              ))}
            </ul>
          )}
          <p className="mt-2 text-[12px] text-[var(--color-muted)]">Paste a supplier link yourself to check it.</p>
        </div>
      )}

      {checked && (
        <div ref={resultRef} className="mt-4 scroll-mt-4 animate-[fadeIn_200ms_ease-out]">
          {found && (
            <div className={`mb-3 flex items-center gap-3 rounded-[var(--radius-card)] border px-4 py-3 ${found.targetRoi !== undefined ? "border-amber-200 bg-amber-50/70" : "border-emerald-200 bg-emerald-50/70"}`}>
              <Thumb src={found.supplier.imageUrl} size={40} />
              <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-[var(--color-ink)]">
                {found.targetRoi !== undefined ? (
                  <>
                    <b className="font-semibold">Liston found a matching supplier, under your target</b>: rated {found.supplier.rating} stars, free postage, {found.supplier.roi}% return against your {found.targetRoi}% target
                  </>
                ) : (
                  <>
                    <b className="font-semibold">Liston found this supplier</b>: rated {found.supplier.rating} stars, free postage, {found.supplier.roi}% return
                  </>
                )}
                {found.checked > 1 ? `, the best of ${found.checked} checked` : ""}. Its link is filled in; add it below with your note{found.targetRoi !== undefined ? " if the lower return will do" : ""}.
                {found.note && <span className="mt-0.5 block text-[11.5px] text-amber-800">{found.note}</span>}
              </p>
            </div>
          )}
          <HuntResult result={checked.result} />
        </div>
      )}
    </div>
  );
}

/**
 * The page's footer while a checked product waits to be added: what it is,
 * a note for the reviewer, Discard and Add.
 */
export function HuntAddBar({ connectionId, checked, onDiscard, onAdded }: { connectionId: string; checked: HuntCheck; onDiscard: () => void; onAdded: (hunt: HuntDetail) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { result } = checked;
  const head = result.summary.headline;
  const unpriced = result.summary.verdict === "unpriced";
  const title = result.competitor?.title || result.source.title;

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const hunt = await api.huntAdd(connectionId, { checkId: checked.checkId, note: note.trim() || undefined });
      announceHuntingChange();
      onAdded(hunt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add it. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      {error && <p className="mb-2 text-[12.5px] font-medium text-[var(--color-danger)]">{error}</p>}
      <div className="flex flex-col gap-2.5 md:flex-row md:items-center md:gap-4">
        <div className="flex min-w-0 items-center gap-3 md:w-[300px] md:flex-shrink-0">
          <Thumb src={result.source.imageUrl} size={40} className="rounded-lg" />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-[var(--color-ink)]">{title}</p>
            <p className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
              <b className={`font-semibold tabular-nums ${profitInk(head.profit, head.roi, result.targetRoiPercent, unpriced)}`}>{signedMoney(head.profit, result.currency)}</b>
              <span>
                · {roiText(head.roi)} {unpriced ? "at your price" : "return"}
              </span>
              <span className="truncate">· {VERDICT[result.summary.verdict].label}</span>
            </p>
          </div>
        </div>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Note for the reviewer</span>
          <input
            className="input"
            placeholder={checked.autoApproves ? "Note (optional)" : "Why this product? The reviewer sees this (optional)"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
            disabled={busy}
          />
        </label>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onDiscard} disabled={busy} className="btn btn-ghost max-md:flex-1">
            Discard
          </button>
          <button type="button" onClick={add} disabled={busy} className="btn btn-primary max-md:flex-1">
            {busy ? "Adding…" : checked.autoApproves ? "Add as approved" : "Add for review"}
          </button>
        </div>
      </div>
    </div>
  );
}
