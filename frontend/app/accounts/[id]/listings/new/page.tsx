"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { EditorHeader, Stepper } from "@/components/EditorHeader";
import { Alert } from "@/components/Alert";
import { api, ApiError, DraftPreview } from "@/lib/api";
import { prettyPriceText } from "@/lib/format";

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

// The supplier's photos, large enough to judge, before anything is drafted.
function PhotoCarousel({ images }: { images: string[] }) {
  const [index, setIndex] = useState(0);
  const count = images.length;
  const go = (delta: number) => setIndex((i) => (i + delta + count) % count);
  const arrow =
    "absolute top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--color-line)] bg-white/95 text-[var(--color-ink)] shadow-sm transition-colors hover:border-[var(--color-line-strong)]";

  return (
    <div>
      <div className="relative aspect-square overflow-hidden rounded-xl border border-[var(--color-line)] bg-white">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={images[index]} alt="" className="h-full w-full object-contain" />
        {index === 0 && <span className="chip chip-primary absolute left-3 top-3 h-7">Main photo</span>}
        <span className="absolute right-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-white">
          {index + 1} / {count}
        </span>
        {count > 1 && (
          <>
            <button type="button" onClick={() => go(-1)} aria-label="Previous photo" className={`${arrow} left-3`}>
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button type="button" onClick={() => go(1)} aria-label="Next photo" className={`${arrow} right-3`}>
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </>
        )}
      </div>
      <div className="mt-2.5 grid grid-cols-6 gap-2 sm:grid-cols-8">
        {images.map((url, i) => (
          <button
            key={`${url}-${i}`}
            type="button"
            onClick={() => setIndex(i)}
            aria-label={`Photo ${i + 1}`}
            className={`aspect-square overflow-hidden rounded-lg border-2 bg-white transition-colors ${
              i === index ? "border-[var(--color-primary)]" : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]"
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="h-full w-full object-contain" />
          </button>
        ))}
      </div>
    </div>
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
      const data = await api.previewDraftListing(params.id, { competitorUrl: competitorUrl.trim() || undefined, sourceUrl });
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
        backLabel="Back to drafts"
        title="Draft a listing"
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
              Paste your AliExpress source product, and a competitor&apos;s eBay listing if you have one. Both are read first, so you
              choose exactly what to list before anything is generated.
            </p>

            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <div>
                <label className={labelClass}>
                  Competitor · eBay listing <span className="font-normal normal-case text-[var(--color-muted)]">(optional)</span>
                </label>
                <input
                  className={`${inputClass} mt-1.5`}
                  type="url"
                  placeholder="https://www.ebay.co.uk/itm/…"
                  value={competitorUrl}
                  onChange={(e) => setCompetitorUrl(e.target.value)}
                  disabled={busy !== null}
                />
                <p className="mt-1.5 text-xs text-[var(--color-muted)]">
                  Sets the category, item specifics and the price to beat. Leave it empty and eBay suggests the category from the source.
                </p>
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
                  {preview.competitor ? (
                    <>
                      <p className={labelClass}>Competitor on eBay</p>
                      <p className="mt-1.5 text-sm font-semibold leading-snug text-[var(--color-ink)]">{preview.competitor.title}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span className="chip chip-primary">{prettyPriceText(preview.competitor.priceText) || "price not read"}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className={labelClass}>No competitor</p>
                      <p className="mt-1.5 text-sm text-[var(--color-muted)]">
                        The category below is eBay&apos;s suggestion for this product. You can change it in the editor.
                      </p>
                    </>
                  )}
                  {preview.category.path.length > 0 && (
                    <div className="mt-3">
                      <p className={labelClass}>eBay category</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                        {preview.category.path.map((segment, i) => (
                          <span key={`${segment}-${i}`} className="flex items-center gap-1.5">
                            {i > 0 && <span className="text-[var(--color-line-strong)]">›</span>}
                            <span className={`chip ${i === preview.category.path.length - 1 ? "chip-primary" : ""}`}>{segment}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="card p-5">
                  <p className={labelClass}>Source on AliExpress</p>
                  <p className="mt-1.5 text-sm font-semibold leading-snug text-[var(--color-ink)]">{preview.source.title}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="chip chip-primary">
                      {prettyPriceText(preview.source.priceText) || "price not read"}
                    </span>
                    <span className="chip">
                      {preview.source.totalCombinations || 1} option{preview.source.totalCombinations === 1 ? "" : "s"}
                    </span>
                    <span className="chip">
                      {preview.source.imageUrls.length} photo{preview.source.imageUrls.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {preview.source.imageUrls.length > 0 && (
                    <div className="mt-4">
                      <PhotoCarousel images={preview.source.imageUrls} />
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

                {preview.competitor?.axes?.length ? (
                  <p className="mt-2 text-xs text-[var(--color-muted)]">
                    The competitor varies by {preview.competitor.axes.map((a) => `${a.name} (${a.values.slice(0, 6).join(", ")}${a.values.length > 6 ? "…" : ""})`).join(" and ")};
                    the draft follows that shape where eBay allows it in this category.
                  </p>
                ) : null}
                {preview.source.axes.some((a) => a.via === "unresolved") && (
                  <div className="notice notice-warning mt-3">
                    <span className="flex-1">
                      eBay doesn&apos;t allow {preview.source.axes.filter((a) => a.via === "unresolved").map((a) => `"${a.name}"`).join(", ")} as a variation in this category
                      {preview.source.allowedAxes.length ? ` (it accepts ${preview.source.allowedAxes.slice(0, 5).join(", ")})` : ""}. The draft will still be created; rename the attribute, change the category or list the options separately in the editor.
                    </span>
                  </div>
                )}

                {preview.source.axes.length === 0 ? (
                  <p className="mt-4 text-sm text-[var(--color-muted)]">
                    {preview.source.fixed.length
                      ? "The supplier's options have one choice each, so this will be drafted as a single listing with them as item specifics."
                      : "This product has no variations, so it will be drafted as a single listing."}
                  </p>
                ) : (
                  <div className="mt-5 space-y-6">
                    {preview.source.axes.map((axis) => {
                      const chosen = selection[axis.name] || new Set<string>();
                      const allValues = axis.values.map((v) => v.value);
                      const renamed = axis.ebayName.toLowerCase() !== axis.name.toLowerCase();
                      return (
                        <div key={axis.name}>
                          <div className="flex items-baseline justify-between">
                            <p className="text-sm font-bold text-[var(--color-ink)]">
                              {axis.ebayName}{" "}
                              <span className="font-normal text-[var(--color-muted)]">
                                · {chosen.size} of {axis.values.length}
                                {renamed && <span className="ml-1.5 text-xs">(supplier calls it &ldquo;{axis.name}&rdquo;{axis.via === "competitor" ? "; named as the competitor does" : ""})</span>}
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

                {preview.source.fixed.length > 0 && (
                  <div className="mt-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)]/60 px-4 py-3">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-muted)]">Same on every variation</p>
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">One option only, so not something a buyer chooses — it goes into the item specifics instead.</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {preview.source.fixed.map((f) => (
                        <span key={f.name} className="chip">
                          <span className="text-[var(--color-muted)]">{f.name}:</span>&nbsp;{f.value}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </div>

      {preview && (
        <footer className="z-40 flex-shrink-0 border-t border-[var(--color-line)] bg-[var(--color-panel)]">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
            <Link href={`/accounts/${params.id}/listings?filter=draft`} className="btn btn-danger-ghost">
              Cancel
            </Link>
            <div className="flex items-center gap-4">
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
        </footer>
      )}
    </main>
  );
}
