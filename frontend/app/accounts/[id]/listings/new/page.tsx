"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { BackHeader } from "@/components/BackHeader";
import { Alert } from "@/components/Alert";
import { api, ApiError, RawScrapedFields } from "@/lib/api";
import { pingExtension, scrapeViaExtension } from "@/lib/extensionBridge";

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

const STATUS_MESSAGES = [
  "Scraping the competitor listing…",
  "Scraping the source product…",
  "Drafting your listing with AI…",
  "Almost done…",
];

const EXTENSION_STATUS_MESSAGES = [
  "Reading the competitor listing in your browser…",
  "Reading the source product in your browser…",
  "Drafting your listing with AI…",
  "Almost done…",
];

export default function DraftListingPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const [competitorUrl, setCompetitorUrl] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [sellPrice, setSellPrice] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const [submitting, setSubmitting] = useState(false);
  const [statusIndex, setStatusIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hasExtension, setHasExtension] = useState<boolean | null>(null);
  const [statusMessages, setStatusMessages] = useState(STATUS_MESSAGES);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    pingExtension().then(setHasExtension);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setStatusIndex(0);
    const usingExtension = await pingExtension();
    const messages = usingExtension ? EXTENSION_STATUS_MESSAGES : STATUS_MESSAGES;
    setStatusMessages(messages);
    intervalRef.current = setInterval(() => {
      setStatusIndex((i) => Math.min(i + 1, messages.length - 1));
    }, 5000);

    try {
      let competitorRaw: RawScrapedFields | undefined;
      let sourceRaw: RawScrapedFields | undefined;

      if (usingExtension) {
        const [competitorResult, sourceResult] = await Promise.all([
          scrapeViaExtension(competitorUrl),
          scrapeViaExtension(sourceUrl),
        ]);
        // Only attach what the extension actually got — if either fetch
        // failed, that side just falls back to the server scraping it
        // itself, same as if the extension weren't installed at all.
        if (competitorResult.ok) competitorRaw = competitorResult.data as RawScrapedFields;
        if (sourceResult.ok) sourceRaw = sourceResult.data as RawScrapedFields;
      }

      const { listing } = await api.generateDraftListing(params.id, {
        competitorUrl,
        sourceUrl,
        competitorRaw,
        sourceRaw,
        costPrice: Number(costPrice),
        sellPrice: Number(sellPrice),
        currency,
      });
      router.push(`/accounts/${params.id}/listings/draft/${listing.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't draft this listing. Try again.");
      setSubmitting(false);
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
  }

  return (
    <main className="min-h-screen">
      <BackHeader backHref={`/accounts/${params.id}/listings`} backLabel="Back to listings" />

      <div className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-extrabold text-[var(--color-ink)]">Draft a listing</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)] leading-relaxed">
          Paste a competitor&apos;s eBay listing and your AliExpress source product — Liston scrapes both, drafts an
          original, improved listing with AI (including real colour/size variations), and shows it to you here to
          review before anything goes live. Make sure you&apos;ve set your default policies and shipping location in{" "}
          <Link href={`/accounts/${params.id}/settings`} className="text-[var(--color-accent)] hover:underline">
            Settings
          </Link>{" "}
          first.
        </p>

        {hasExtension === false && (
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            Tip: install the Liston browser extension for more reliable drafting — it reads these pages through your
            own browser instead of Liston's server. Works fine without it too, just less reliable against sites that
            block automated requests.
          </p>
        )}

        {error && (
          <div className="mt-5">
            <Alert>{error}</Alert>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="mt-6 flex flex-col gap-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6"
        >
          <Field label="Competitor eBay listing URL">
            <input
              className={inputClass}
              type="url"
              placeholder="https://www.ebay.co.uk/itm/..."
              value={competitorUrl}
              onChange={(e) => setCompetitorUrl(e.target.value)}
              disabled={submitting}
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
              disabled={submitting}
              required
            />
          </Field>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Cost price">
              <input
                className={inputClass}
                type="number"
                min="0"
                step="0.01"
                value={costPrice}
                onChange={(e) => setCostPrice(e.target.value)}
                disabled={submitting}
                required
              />
            </Field>
            <Field label="Sell price">
              <input
                className={inputClass}
                type="number"
                min="0"
                step="0.01"
                value={sellPrice}
                onChange={(e) => setSellPrice(e.target.value)}
                disabled={submitting}
                required
              />
            </Field>
            <Field label="Currency">
              <select
                className={inputClass}
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                disabled={submitting}
              >
                <option value="GBP">GBP</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </Field>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-90 transition-colors"
          >
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                {statusMessages[statusIndex]}
                <ThinkingDots />
              </span>
            ) : (
              "Draft with AI"
            )}
          </button>
          {submitting && (
            <p className="text-xs text-center text-[var(--color-muted)]">This can take up to a minute.</p>
          )}
        </form>
      </div>
    </main>
  );
}
