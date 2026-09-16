"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { EditorHeader, Stepper } from "@/components/EditorHeader";
import { Alert } from "@/components/Alert";
import { api, ApiError, DraftPreview } from "@/lib/api";

// Drafting in two steps. Step one reads both listings and costs nothing;
// step two generates the listing for ONLY the variations the seller ticked.
// Nobody lists all 162 combinations of a phone case.

const inputClass = "input";
const labelClass = "label";

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70 animate-bounce [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70 animate-bounce [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70 animate-bounce [animation-delay:300ms]" />
    </span>
  );
}

const READ_MESSAGES = ["Reading the competitor listing…", "Reading the source product…", "Almost there…"];
const DRAFT_MESSAGES = ["Writing your listing…", "Preparing images…", "Uploading images to eBay…", "Almost done…"];

export default function DraftListingPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const [competitorUrl, setCompetitorUrl] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  // { axisName: Set of ticked values }
  const [selection, setSelection] = useState<Record<string, Set<string>>>({});
  const [busy, setBusy] = useState<"read" | "draft" | null>(null);
  const [statusIndex, setStatusIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function startStatus(messages: string[], everyMs: number) {
    setStatusIndex(0);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setStatusIndex((i) => Math.min(i + 1, messages.length - 1));
    }, everyMs);
  }
  function stopStatus() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
  }

  async function handleRead(e: React.FormEvent) {
    e.preventDefault();
    setBusy("read");
    setError(null);
    setPreview(null);
    startStatus(READ_MESSAGES, 4000);
    try {
      const data = await api.previewDraftListing(params.id, { competitorUrl, sourceUrl });
      setPreview(data);
      // Everything ticked to start with — the seller unticks what they
      // don't want, which is the faster direction for most products.
      const all: Record<string, Set<string>> = {};
      for (const axis of data.source.axes) all[axis.name] = new Set(axis.values.map((v) => v.value));
      setSelection(all);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't read those listings. Try again.");
    } finally {
      setBusy(null);
      stopStatus();
    }
  }

  // Combinations that survive the current ticks — what step two builds.
  const selectedCount = useMemo(() => {
    if (!preview) return 0;
    if (!preview.source.axes.length) return 1;
    return preview.source.axes.reduce((total, axis) => total * (selection[axis.name]?.size ?? 0), 1);
  }, [preview, selection]);

  function toggle(axis: string, value: string) {
    setSelection((current) => {
      const next = new Set(current[axis] || []);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...current, [axis]: next };
    });
  }
  function setAll(axis: string, values: string[], on: boolean) {
    setSelection((current) => ({ ...current, [axis]: new Set(on ? values : []) }));
  }

  async function handleDraft() {
    if (!preview) return;
    setBusy("draft");
    setError(null);
    startStatus(DRAFT_MESSAGES, 12000);
    try {
      const variantSelection: Record<string, string[]> = {};
      for (const axis of preview.source.axes) variantSelection[axis.name] = [...(selection[axis.name] || [])];
      const { listing } = await api.generateDraftListing(params.id, { previewId: preview.previewId, variantSelection });
      router.push(`/accounts/${params.id}/listings/draft/${listing.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't draft this listing. Try again.");
      setBusy(null);
      stopStatus();
    }
  }

  const messages = busy === "read" ? READ_MESSAGES : DRAFT_MESSAGES;
  const step = preview ? 2 : 1;

  return (
    <main className="flex h-screen flex-col bg-[var(--color-paper)]">
      <EditorHeader
        backHref={`/accounts/${params.id}/listings?filter=draft`}
        backLabel="Drafts"
        title="Draft a listing"
        actions={
          preview ? (
            <button
              type="button"
              onClick={handleDraft}
              disabled={busy !== null || (preview.source.axes.length > 0 && selectedCount === 0)}
              className="btn btn-primary btn-sm"
            >
              {busy === "draft" ? (
                <span className="inline-flex items-center gap-2">
                  {messages[statusIndex]} <ThinkingDots />
                </span>
              ) : (
                `Draft ${preview.source.axes.length ? `${selectedCount} variation${selectedCount === 1 ? "" : "s"}` : "listing"}`
              )}
            </button>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-8">
          {error && (
            <div className="mb-6">
              <Alert>{error}</Alert>
            </div>
          )}

          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <Stepper steps={["Read the listings", "Choose what to list"]} current={step} />
            <p className="text-xs text-[var(--color-muted)]">
              Prices come from the supplier cost and your target return in{" "}
              <Link href={`/accounts/${params.id}/settings`} className="text-[var(--color-accent)] hover:underline">
                Settings
              </Link>
              .
            </p>
          </div>

          {/* ---- Step 1 ------------------------------------------------ */}
          <form
            onSubmit={handleRead}
            className="card p-6"
          >
            <h2 className="text-base font-bold text-[var(--color-ink)]">Read the listings</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Paste the competitor&apos;s eBay listing and your AliExpress source product. Both are read first, so you choose
              exactly what to list before anything is generated.
            </p>

            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <div>
                <label className={labelClass}>Competitor · eBay listing</label>
                <input
                  className={`${inputClass} mt-1.5`}
                  type="url"
                  placeholder="https://www.ebay.co.uk/itm/…"
                  value={competitorUrl}
                  onChange={(e) => setCompetitorUrl(e.target.value)}
                  disabled={busy !== null}
                  required
                />
                <p className="mt-1.5 text-xs text-[var(--color-muted)]">Sets the category, item specifics and the price to beat.</p>
              </div>
              <div>
                <label className={labelClass}>Source · AliExpress product</label>
                <input
                  className={`${inputClass} mt-1.5`}
                  type="url"
                  placeholder="https://www.aliexpress.com/item/…"
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  disabled={busy !== null}
                  required
                />
                <p className="mt-1.5 text-xs text-[var(--color-muted)]">Supplies the photos, variations and cost price.</p>
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="submit"
                disabled={busy !== null}
                className={`btn ${preview ? "btn-secondary" : "btn-primary"}`}
              >
                {busy === "read" ? (
                  <span className="inline-flex items-center gap-2">
                    {messages[statusIndex]} <ThinkingDots />
                  </span>
                ) : preview ? (
                  "Read again"
                ) : (
                  "Read listings"
                )}
              </button>
            </div>
          </form>

          {/* ---- Step 2 ------------------------------------------------ */}
          {preview && (
            <section className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
              {/* Left: what was read */}
              <div className="space-y-4">
                <div className="card p-5">
                  <p className={labelClass}>Competitor on eBay</p>
                  <p className="mt-1.5 text-sm font-semibold leading-snug text-[var(--color-ink)]">{preview.competitor.title}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="chip chip-primary">
                      {preview.competitor.priceText || "price not read"}
                    </span>
                    {preview.competitor.categoryPath.length > 0 && (
                      <span className="chip">
                        {preview.competitor.categoryPath.slice(-2).join(" › ")}
                      </span>
                    )}
                  </div>
                </div>

                <div className="card p-5">
                  <p className={labelClass}>Source on AliExpress</p>
                  <p className="mt-1.5 text-sm font-semibold leading-snug text-[var(--color-ink)]">{preview.source.title}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="chip chip-primary">
                      {preview.source.priceText || "price not read"}
                    </span>
                    <span className="chip">
                      {preview.source.totalCombinations || 1} option{preview.source.totalCombinations === 1 ? "" : "s"}
                    </span>
                    <span className="chip">
                      {preview.source.imageUrls.length} photo{preview.source.imageUrls.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {preview.source.imageUrls.length > 0 && (
                    <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-5">
                      {preview.source.imageUrls.map((url, i) => (
                        <div key={url} className="relative aspect-square overflow-hidden rounded-xl border border-[var(--color-line)] bg-white">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt="" className="h-full w-full object-contain" />
                          {i === 0 && (
                            <span className="absolute left-1.5 top-1.5 rounded-md bg-[var(--color-primary)] px-1.5 py-0.5 text-[10px] font-bold text-white">
                              MAIN
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="mt-3 text-xs text-[var(--color-muted)]">
                    All supplier photos go into the draft as they are. Remove, reorder or replace them in the editor.
                  </p>
                </div>
              </div>

              {/* Right: choose variations */}
              <div className="card p-6">
                <h2 className="text-base font-bold text-[var(--color-ink)]">Choose what to list</h2>
                <p className="mt-1 text-sm text-[var(--color-muted)]">Untick anything you don&apos;t want to sell. Everything ticked is drafted.</p>

                {preview.source.axes.length === 0 ? (
                  <p className="mt-4 text-sm text-[var(--color-muted)]">
                    This product has no variations — it will be drafted as a single listing.
                  </p>
                ) : (
                  <div className="mt-5 space-y-6">
                    {preview.source.axes.map((axis) => {
                      const chosen = selection[axis.name] || new Set<string>();
                      const allValues = axis.values.map((v) => v.value);
                      return (
                        <div key={axis.name}>
                          <div className="flex items-baseline justify-between">
                            <p className="text-sm font-bold text-[var(--color-ink)]">
                              {axis.name}{" "}
                              <span className="font-normal text-[var(--color-muted)]">
                                · {chosen.size} of {axis.values.length}
                              </span>
                            </p>
                            <div className="flex gap-1">
                              <button type="button" onClick={() => setAll(axis.name, allValues, true)} className="btn btn-ghost btn-sm text-[var(--color-accent)]">
                                Select all
                              </button>
                              <button type="button" onClick={() => setAll(axis.name, allValues, false)} className="btn btn-ghost btn-sm">
                                Clear
                              </button>
                            </div>
                          </div>
                          <div
                            className="mt-3 grid gap-2.5"
                            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${axis.hasImages ? 200 : 150}px, 1fr))` }}
                          >
                            {axis.values.map((option) => {
                              const on = chosen.has(option.value);
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  onClick={() => toggle(axis.name, option.value)}
                                  disabled={busy !== null}
                                  aria-pressed={on}
                                  className={`flex items-center gap-3 rounded-xl border p-2.5 text-left transition-all ${
                                    on
                                      ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] shadow-sm"
                                      : "border-[var(--color-line)] bg-[var(--color-panel)] hover:border-[var(--color-line-strong)]"
                                  }`}
                                >
                                  {axis.hasImages &&
                                    (option.imageUrl ? (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img
                                        src={option.imageUrl}
                                        alt=""
                                        className={`h-14 w-14 flex-shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-contain ${on ? "" : "opacity-60"}`}
                                      />
                                    ) : (
                                      <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-[var(--color-paper)]" />
                                    ))}
                                  <span className={`min-w-0 flex-1 text-sm font-medium leading-snug ${on ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>
                                    {option.value}
                                  </span>
                                  <span
                                    className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${
                                      on ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white" : "border-[var(--color-line-strong)]"
                                    }`}
                                  >
                                    {on ? "✓" : ""}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-line)] pt-5">
                  <p className="text-sm text-[var(--color-muted)]">
                    {preview.source.axes.length ? (
                      <>
                        <span className="font-bold text-[var(--color-ink)]">{selectedCount}</span> variation
                        {selectedCount === 1 ? "" : "s"} will be drafted
                        {selectedCount < preview.source.totalCombinations && ` of ${preview.source.totalCombinations} offered`}
                      </>
                    ) : (
                      "Single listing"
                    )}
                  </p>
                  <button
                    type="button"
                    onClick={handleDraft}
                    disabled={busy !== null || (preview.source.axes.length > 0 && selectedCount === 0)}
                    className="btn btn-primary"
                  >
                    {busy === "draft" ? (
                      <span className="inline-flex items-center gap-2">
                        {messages[statusIndex]} <ThinkingDots />
                      </span>
                    ) : (
                      "Draft with AI"
                    )}
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
