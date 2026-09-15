"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { BackHeader } from "@/components/BackHeader";
import { Alert } from "@/components/Alert";
import { api, ApiError, DraftPreview } from "@/lib/api";

// Drafting in two steps. Step one reads both listings and costs nothing;
// step two generates text and photography for ONLY the variations the
// seller ticked. Nobody lists all 162 combinations of a phone case, and
// generating photography for variations that get deleted afterwards is
// money and minutes thrown away.

const inputClass =
  "w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-ink)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">{label}</label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

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
const DRAFT_MESSAGES = [
  "Drafting your listing with AI…",
  "Photographing your product…",
  "Generating variation photos…",
  "Uploading images to eBay…",
  "Almost done…",
];

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
    startStatus(READ_MESSAGES, 6000);
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

  // Combinations that survive the current ticks — what step two will
  // actually build, and therefore what it will cost.
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
    startStatus(DRAFT_MESSAGES, 25000);
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

  return (
    <main className="min-h-screen">
      <BackHeader backHref={`/accounts/${params.id}/listings?filter=draft`} backLabel="Back to drafts" />

      <div className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-extrabold text-[var(--color-ink)]">Draft a listing</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)] leading-relaxed">
          Paste a competitor&apos;s eBay listing and your AliExpress source product. Liston reads both first, so you
          can choose exactly which variations to list before anything is generated. Prices come from the supplier&apos;s
          cost and your target return in{" "}
          <Link href={`/accounts/${params.id}/settings`} className="text-[var(--color-accent)] hover:underline">
            Settings
          </Link>
          .
        </p>

        {error && (
          <div className="mt-5">
            <Alert>{error}</Alert>
          </div>
        )}

        {/* Step 1 — URLs */}
        <form
          onSubmit={handleRead}
          className="mt-6 flex flex-col gap-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6"
        >
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-primary)] text-xs font-bold text-white">
              1
            </span>
            <span className="text-sm font-bold text-[var(--color-ink)]">Read the listings</span>
          </div>
          <Field label="Competitor eBay listing URL">
            <input
              className={inputClass}
              type="url"
              placeholder="https://www.ebay.co.uk/itm/..."
              value={competitorUrl}
              onChange={(e) => setCompetitorUrl(e.target.value)}
              disabled={busy !== null}
              required
            />
          </Field>
          <Field label="Source AliExpress product URL">
            <input
              className={inputClass}
              type="url"
              placeholder="https://www.aliexpress.com/item/..."
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              disabled={busy !== null}
              required
            />
          </Field>
          <button
            type="submit"
            disabled={busy !== null}
            className="mt-1 self-start rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-90 transition-colors"
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
        </form>

        {/* Step 2 — choose variations */}
        {preview && (
          <div className="mt-6 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-primary)] text-xs font-bold text-white">
                2
              </span>
              <span className="text-sm font-bold text-[var(--color-ink)]">Choose what to list</span>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-[var(--color-line)] p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Competitor</p>
                <p className="mt-1.5 text-sm font-semibold text-[var(--color-ink)] leading-snug">{preview.competitor.title}</p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {preview.competitor.priceText || "price not read"} · {preview.competitor.categoryPath.slice(-2).join(" › ")}
                </p>
              </div>
              <div className="rounded-xl border border-[var(--color-line)] p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Source product</p>
                <p className="mt-1.5 text-sm font-semibold text-[var(--color-ink)] leading-snug">{preview.source.title}</p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {preview.source.priceText || "price not read"} · {preview.source.totalCombinations || 1} option
                  {preview.source.totalCombinations === 1 ? "" : "s"} on the supplier page
                </p>
                {preview.source.imageUrls.length > 0 && (
                  <div className="mt-3 flex gap-1.5 overflow-x-auto">
                    {preview.source.imageUrls.map((url) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={url} src={url} alt="" className="h-12 w-12 flex-shrink-0 rounded-md border border-[var(--color-line)] object-cover" />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {preview.source.axes.length === 0 ? (
              <p className="mt-5 text-sm text-[var(--color-muted)]">
                This product has no variations — it will be drafted as a single listing.
              </p>
            ) : (
              <div className="mt-5 space-y-5">
                {preview.source.axes.map((axis) => {
                  const chosen = selection[axis.name] || new Set<string>();
                  const allValues = axis.values.map((v) => v.value);
                  return (
                    <div key={axis.name}>
                      <div className="flex items-baseline justify-between">
                        <p className="text-sm font-bold text-[var(--color-ink)]">
                          {axis.name}{" "}
                          <span className="font-normal text-[var(--color-muted)]">
                            — {chosen.size} of {axis.values.length}
                          </span>
                        </p>
                        <div className="flex gap-3 text-xs">
                          <button type="button" onClick={() => setAll(axis.name, allValues, true)} className="text-[var(--color-accent)] hover:underline">
                            All
                          </button>
                          <button type="button" onClick={() => setAll(axis.name, allValues, false)} className="text-[var(--color-muted)] hover:underline">
                            None
                          </button>
                        </div>
                      </div>
                      <div className={`mt-2 grid gap-2 ${axis.hasImages ? "grid-cols-3 sm:grid-cols-6" : "grid-cols-2 sm:grid-cols-4"}`}>
                        {axis.values.map((option) => {
                          const on = chosen.has(option.value);
                          return (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => toggle(axis.name, option.value)}
                              disabled={busy !== null}
                              className={`flex items-center gap-2 rounded-lg border p-2 text-left text-xs transition-colors ${
                                on
                                  ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-ink)]"
                                  : "border-[var(--color-line)] text-[var(--color-muted)]"
                              }`}
                            >
                              {axis.hasImages ? (
                                option.imageUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={option.imageUrl} alt="" className={`h-10 w-10 flex-shrink-0 rounded-md object-cover ${on ? "" : "opacity-50"}`} />
                                ) : (
                                  <div className="h-10 w-10 flex-shrink-0 rounded-md bg-[var(--color-paper)]" />
                                )
                              ) : (
                                <input type="checkbox" readOnly checked={on} className="pointer-events-none" />
                              )}
                              <span className="min-w-0 truncate font-medium">{option.value}</span>
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
                    {selectedCount < preview.source.totalCombinations && ` (of ${preview.source.totalCombinations} offered)`}
                  </>
                ) : (
                  "Single listing"
                )}
              </p>
              <button
                type="button"
                onClick={handleDraft}
                disabled={busy !== null || (preview.source.axes.length > 0 && selectedCount === 0)}
                className="rounded-md bg-[var(--color-primary)] px-5 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40 transition-colors"
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
        )}
      </div>
    </main>
  );
}
