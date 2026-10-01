"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { api, DiscoverSubjectRef } from "@/lib/api";

// Discover's search box, on every Discover screen: type a keyword and
// press Enter to see its figures on eBay, or pick one of the eBay
// categories matching what's typed.

type Suggestion = { id: string; name: string; path: string[]; leaf: boolean };

export function DiscoverSearch({ connectionId, onOpen, initial = "" }: { connectionId: string; onOpen: (subject: DiscoverSubjectRef) => void; initial?: string }) {
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<{ q: string; items: Suggestion[] } | null>(null);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const text = q.trim();

  // Categories for what's typed, a moment after typing stops.
  useEffect(() => {
    if (text.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .discoverSuggest(connectionId, text)
        .then((d) => !cancelled && setFound({ q: text, items: d.categories }))
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connectionId, text]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const categories = found && found.q === text ? found.items : [];
  const options: { key: string; subject: DiscoverSubjectRef; label: React.ReactNode }[] =
    text.length >= 2
      ? [
          {
            key: "q",
            subject: { q: text },
            label: (
              <span className="flex items-center gap-2">
                <SearchGlyph />
                <span className="truncate">
                  Search eBay for <span className="font-semibold text-[var(--color-ink)]">“{text}”</span>
                </span>
              </span>
            ),
          },
          ...categories.map((c) => ({
            key: c.id,
            subject: { categoryId: c.id },
            label: (
              <span className="block min-w-0">
                <span className="block truncate font-medium text-[var(--color-ink)]">{c.name}</span>
                {c.path.length > 0 && <span className="block truncate text-[11px] text-[var(--color-muted)]">{c.path.join(" › ")}</span>}
              </span>
            ),
          })),
        ]
      : [];

  function pick(subject: DiscoverSubjectRef) {
    setOpen(false);
    onOpen(subject);
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const option = options[active] || options[0];
    if (option) pick(option.subject);
  }

  return (
    <div ref={wrap} className="relative w-full sm:max-w-[460px]">
      <form onSubmit={submit} role="search">
        <label className="relative block">
          <span className="sr-only">Search a category or keyword</span>
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]">
            <SearchGlyph />
          </span>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(options.length - 1, a + 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              }
            }}
            maxLength={80}
            placeholder="Search a keyword or category, e.g. cat water fountain"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="discover-search-options"
            aria-expanded={open && options.length > 0}
            className="input input-sm !h-9 !pl-9 !pr-9 !text-[13px]"
          />
          {q && (
            <button
              type="button"
              onClick={() => {
                setQ("");
                setOpen(false);
              }}
              aria-label="Clear the search"
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </label>
      </form>
      {open && options.length > 0 && (
        <ul id="discover-search-options" role="listbox" className="absolute left-0 right-0 z-40 mt-1.5 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] py-1 text-[12.5px] shadow-lg">
          {options.map((o, i) => (
            <li key={o.key} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.subject)}
                className={`flex w-full items-center px-3 py-2 text-left text-[var(--color-muted)] ${i === active ? "bg-[var(--color-paper)]" : ""}`}
              >
                {o.label}
              </button>
              {i === 0 && categories.length > 0 && <p className="px-3 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Categories</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 flex-shrink-0" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
