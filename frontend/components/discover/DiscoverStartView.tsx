"use client";

import { FormEvent, useState } from "react";
import { DiscoverCategoryCard, DiscoverStart, DiscoverSubjectRef } from "@/lib/api";
import { count } from "@/components/research/format";
import { AccountDelivery, BudgetLine, ScoreBadge } from "./discover-ui";

// Where Discover starts: a keyword to explore, the account's own categories
// (from the listings Liston made for it) and eBay's top-level categories,
// each with its opportunity once read.

function CategoryCard({ category, onOpen, note }: { category: DiscoverCategoryCard; onOpen: () => void; note?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card group flex min-w-0 items-center gap-3 px-3.5 py-3 text-left transition-[box-shadow,border-color] hover:border-[var(--color-line-strong)] hover:shadow-md"
    >
      <span className="min-w-0 flex-1">
        {category.path && category.path.length > 0 && <span className="block truncate text-[11px] text-[var(--color-muted)]">{category.path.join(" › ")}</span>}
        <span className="block truncate text-[13px] font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{category.name}</span>
        <span className="block text-[11.5px] text-[var(--color-muted)]">{category.scanned ? `${count(category.scanned.total)} live` : note || "Not read yet"}</span>
      </span>
      {category.scanned ? <ScoreBadge score={category.scanned.score} band={category.scanned.band} size="sm" /> : null}
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 shrink-0 text-[var(--color-muted)] group-hover:text-[var(--color-primary)]" aria-hidden>
        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export function DiscoverStartView({ data, onOpen }: { data: DiscoverStart; onOpen: (subject: DiscoverSubjectRef) => void }) {
  const [q, setQ] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (q.trim().length >= 2) onOpen({ q: q.trim() });
  }
  return (
    <div className="space-y-5">
      <section className="card px-4 py-4">
        <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Find what to hunt on {data.market.name}</h2>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
          Explore a keyword or a category: Liston reads its leading listings on eBay and how many each has sold, then shows how fast it sells, how crowded it is,
          what buyers pay, whether you can match the sellers&apos; delivery, and the keywords of the titles that sell.
        </p>
        <form onSubmit={submit} className="mt-3 flex flex-col gap-2 sm:flex-row">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Keyword</span>
            <svg viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]" aria-hidden>
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={80} placeholder="A keyword, e.g. cat water fountain" className="input input-sm !pl-9" />
          </label>
          <button type="submit" disabled={q.trim().length < 2} className="btn btn-primary btn-sm">
            Explore
          </button>
        </form>
        <p className="mt-2 text-[11.5px] text-[var(--color-muted)]">
          <AccountDelivery account={data.account} />
        </p>
      </section>

      {data.yourCategories.length > 0 && (
        <section>
          <h3 className="mb-2 text-[12.5px] font-semibold text-[var(--color-ink)]">Your categories</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-2.5">
            {data.yourCategories.map((c) => (
              <CategoryCard key={c.id} category={c} onOpen={() => onOpen({ categoryId: c.id })} note={`${c.listings} of your listings`} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-[12.5px] font-semibold text-[var(--color-ink)]">All categories</h3>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-2.5">
          {data.topCategories.map((c) => (
            <CategoryCard key={c.id} category={c} onOpen={() => onOpen({ categoryId: c.id })} />
          ))}
        </div>
      </section>

      <BudgetLine budget={data.budget} />
    </div>
  );
}
