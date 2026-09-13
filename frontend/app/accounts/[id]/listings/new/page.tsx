"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/Logo";

export default function DraftListingPage() {
  const params = useParams<{ id: string }>();

  return (
    <main className="min-h-screen">
      <header className="border-b border-[var(--color-line)] bg-[var(--color-panel)]">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Logo size={32} />
            <span className="font-semibold text-[var(--color-ink)]">Liston</span>
          </div>
          <Link
            href={`/accounts/${params.id}/listings`}
            className="text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)] transition-colors"
          >
            Back to listings
          </Link>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-16 text-center">
        <span className="inline-flex rounded-full bg-[var(--color-accent)]/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-[var(--color-accent)]">
          Coming soon
        </span>
        <h1 className="mt-4 text-2xl font-extrabold text-[var(--color-ink)]">Draft a listing with AI</h1>
        <p className="mt-3 text-[15px] text-[var(--color-muted)] max-w-lg mx-auto leading-relaxed">
          This is where Liston will turn a competitor listing or a source product into an original,
          ready-to-publish eBay draft — AI-written title and description, sourced images, and a price
          checked against your ROI threshold — for you to review before it goes live.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-3 text-left">
          {[
            {
              step: "1",
              title: "Give it a source",
              description: "Paste a competitor eBay listing or a source product URL.",
            },
            {
              step: "2",
              title: "AI drafts it",
              description: "Original title, description, and pricing — checked against your margin rules.",
            },
            {
              step: "3",
              title: "Review & publish",
              description: "Everything lands here as a draft first. Nothing goes live without your say.",
            },
          ].map(({ step, title, description }) => (
            <div key={step} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-xs font-bold text-[var(--color-primary)]">
                {step}
              </span>
              <p className="mt-3 text-sm font-bold text-[var(--color-ink)]">{title}</p>
              <p className="mt-1 text-xs text-[var(--color-muted)] leading-relaxed">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
