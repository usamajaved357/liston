"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { BackHeader } from "@/components/BackHeader";
import { Alert } from "@/components/Alert";
import { api, ApiError } from "@/lib/api";

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
  "Reading the competitor listing…",
  "Reading the source product…",
  "Drafting your listing with AI…",
  "Preparing your images…",
  "Almost done…",
];

export default function DraftListingPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const [competitorUrl, setCompetitorUrl] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [statusIndex, setStatusIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setStatusIndex(0);
    intervalRef.current = setInterval(() => {
      setStatusIndex((i) => Math.min(i + 1, STATUS_MESSAGES.length - 1));
    }, 5000);

    try {
      const { listing } = await api.generateDraftListing(params.id, {
        competitorUrl,
        sourceUrl,
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
          Paste a competitor&apos;s eBay listing and your AliExpress source product — Liston reads both, drafts an
          original, improved listing with AI (including real colour/size variations), and shows it to you here to
          review before anything goes live. Prices are worked out from the supplier&apos;s own cost to hit the target
          return set in{" "}
          <Link href={`/accounts/${params.id}/settings`} className="text-[var(--color-accent)] hover:underline">
            Settings
          </Link>
          , where your policies and shipping location also need to be set first.
        </p>

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
          <button
            type="submit"
            disabled={submitting}
            className="mt-2 rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-90 transition-colors"
          >
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                {STATUS_MESSAGES[statusIndex]}
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
