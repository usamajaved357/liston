"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { api, ApiError, HuntCheckResult, HuntDetail } from "@/lib/api";
import { Alert } from "@/components/Alert";
import { HuntResult } from "./HuntResult";
import { HuntIcon, announceHuntingChange } from "./HuntBits";

// "Hunt a product": paste the competitor's eBay listing and the AliExpress
// product, see the profit on every option, then add it for review (the
// owner's own finds are approved as they're added). Nothing is saved until
// Add; a check is held for half an hour.

const STEPS = ["Reading the competitor on eBay", "Reading the supplier on AliExpress", "Asking AliExpress for postage", "Working out the profit on every option"];

function Progress({ step }: { step: number }) {
  return (
    <div className="card mt-4 p-5">
      <ol className="space-y-3">
        {STEPS.map((label, i) => {
          const done = i < step;
          const now = i === step;
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

export function HuntForm({ connectionId, marketName, initialCompetitor, onAdded }: { connectionId: string; marketName: string; initialCompetitor?: string | null; onAdded: (hunt: HuntDetail) => void }) {
  const [competitorUrl, setCompetitorUrl] = useState(initialCompetitor || "");
  const [sourceUrl, setSourceUrl] = useState("");
  const [busy, setBusy] = useState<"check" | "add" | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ checkId: string; result: HuntCheckResult; autoApproves: boolean } | null>(null);
  const [note, setNote] = useState("");
  const [added, setAdded] = useState<string | null>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (busy !== "check") return;
    const timer = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 1500);
    return () => clearInterval(timer);
  }, [busy]);

  async function check(e: FormEvent) {
    e.preventDefault();
    setBusy("check");
    setStep(0);
    setError(null);
    setChecked(null);
    setAdded(null);
    try {
      const data = await api.huntCheck(connectionId, { competitorUrl: competitorUrl.trim(), sourceUrl: sourceUrl.trim() });
      setChecked(data);
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check that product. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    if (!checked) return;
    setBusy("add");
    setError(null);
    try {
      const hunt = await api.huntAdd(connectionId, { checkId: checked.checkId, note: note.trim() || undefined });
      setAdded(hunt.stage === "approved" ? "Added and approved. It's ready to draft." : "Added. It's waiting for a reviewer.");
      setChecked(null);
      setCompetitorUrl("");
      setSourceUrl("");
      setNote("");
      announceHuntingChange();
      onAdded(hunt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add it. Try again.");
    } finally {
      setBusy(null);
    }
  }

  function discard() {
    setChecked(null);
    setNote("");
    setError(null);
  }

  return (
    <div>
      <form onSubmit={check} className="card overflow-hidden">
        <div className="flex items-start gap-3 border-b border-[var(--color-line)] bg-gradient-to-r from-[var(--color-primary-soft)] to-transparent px-4 py-3.5 sm:px-5">
          <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary)] text-white">
            <HuntIcon />
          </span>
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Hunt a product</h2>
            <p className="text-[12.5px] text-[var(--color-muted)]">Paste a competitor selling it on {marketName} and the AliExpress product that supplies it. You&apos;ll see the profit on every option before adding it.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <label className="block min-w-0">
            <span className="label flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#0064D2]" aria-hidden />
              Competitor on eBay
            </span>
            <input
              className="input mt-1.5"
              type="url"
              inputMode="url"
              placeholder="https://www.ebay.co.uk/itm/…"
              value={competitorUrl}
              onChange={(e) => setCompetitorUrl(e.target.value)}
              onPaste={() => setTimeout(() => !sourceUrl && sourceRef.current?.focus(), 0)}
              disabled={busy !== null}
              required
            />
          </label>
          <label className="block min-w-0">
            <span className="label flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[#E62E04]" aria-hidden />
              Supplier on AliExpress
            </span>
            <input
              ref={sourceRef}
              className="input mt-1.5"
              type="url"
              inputMode="url"
              placeholder="https://www.aliexpress.com/item/…"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              disabled={busy !== null}
              required
            />
          </label>
          <button type="submit" disabled={busy !== null || !competitorUrl.trim() || !sourceUrl.trim()} className="btn btn-primary h-10 px-5">
            {busy === "check" ? "Checking…" : checked ? "Check again" : "Check profit"}
          </button>
        </div>
      </form>

      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {added && !checked && (
        <div className="notice notice-success mt-4">
          <span className="flex-1">{added}</span>
        </div>
      )}
      {busy === "check" && <Progress step={step} />}

      {checked && (
        <div ref={resultRef} className="mt-4 scroll-mt-4 space-y-4 animate-[fadeIn_200ms_ease-out]">
          <HuntResult result={checked.result} />
          <div className="card sticky bottom-3 z-10 flex flex-col gap-3 p-3 shadow-[0_12px_32px_-12px_rgba(15,23,42,0.35)] sm:flex-row sm:items-center sm:p-4">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Note for the reviewer</span>
              <input
                className="input"
                placeholder={checked.autoApproves ? "Note (optional)" : "Why this product? The reviewer sees this (optional)"}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={1000}
                disabled={busy !== null}
              />
            </label>
            <div className="flex items-center gap-2">
              <button type="button" onClick={discard} disabled={busy !== null} className="btn btn-ghost max-sm:flex-1">
                Discard
              </button>
              <button type="button" onClick={add} disabled={busy !== null} className="btn btn-primary max-sm:flex-1">
                {busy === "add" ? "Adding…" : checked.autoApproves ? "Add as approved" : "Add for review"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
