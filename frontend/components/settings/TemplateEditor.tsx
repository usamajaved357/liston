"use client";

import { Fragment, ReactNode, useEffect, useLayoutEffect, useRef } from "react";

// Settings → Messages: the editor shared by the automatic messages and the
// quick replies. The text grows with what's written (no box to scroll
// inside), fill-ins go in at the cursor from named chips ({buyer} shown as
// "First name"), and beside it the message as the buyer reads it, filled in
// for an example order, under the store's name. A {word} Liston doesn't
// know is flagged, since it would reach the buyer as it is.

export type FillIn = { key: string; label: string; hint?: string };

/** A message's text with its fill-ins marked (one Liston doesn't know in amber). */
export function TokenText({ text, known }: { text: string; known: readonly string[] }) {
  const parts = text.split(/(\{[a-z_]+\})/gi);
  return (
    <>
      {parts.map((part, i) => {
        const token = /^\{([a-z_]+)\}$/i.exec(part);
        if (!token) return <Fragment key={i}>{part}</Fragment>;
        const ok = known.includes(token[1].toLowerCase());
        return (
          <span key={i} className={`rounded px-[3px] font-medium ${ok ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]" : "bg-amber-50 text-amber-700"}`}>
            {part}
          </span>
        );
      })}
    </>
  );
}

/** The {words} in a text that aren't fill-ins Liston knows. */
export function strangeTokens(text: string, known: readonly string[]): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\{([a-z_]+)\}/gi)) if (!known.includes(m[1].toLowerCase())) found.add(m[0]);
  return [...found];
}

export function TemplateEditor({
  id,
  value,
  onChange,
  fillIns,
  limit,
  preview,
  from,
  to,
  note,
  top,
  footer,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (text: string) => void;
  fillIns: FillIn[];
  limit: number;
  // The message filled in for the example order.
  preview: string;
  // Who it's from (the store) and to (the example buyer), for the preview's heading.
  from: string;
  to: string;
  note?: ReactNode;
  // Above the message (a quick reply's name).
  top?: ReactNode;
  footer: ReactNode;
  autoFocus?: boolean;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const known = fillIns.map((f) => f.key);
  const strange = strangeTokens(value, known);

  // The box fits its text, so the whole message is in view while it's written.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(180, el.scrollHeight + 2)}px`;
  }, [value]);

  // After a fill-in goes in, the cursor sits just after it.
  useEffect(() => {
    if (caret.current === null || !area.current) return;
    area.current.focus();
    area.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);

  function insert(key: string) {
    const el = area.current;
    const token = `{${key}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    caret.current = start + token.length;
    onChange(`${value.slice(0, start)}${token}${value.slice(end)}`);
  }

  const initial = (from.trim()[0] || "S").toUpperCase();

  return (
    <div className="border-t border-[var(--color-line)] bg-[var(--color-paper)]/60 px-5 py-5 sm:px-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-3">
          {top}
          <div>
            <label htmlFor={id} className="text-[12px] font-semibold text-[var(--color-ink)]">
              Message
            </label>
            <textarea
              ref={area}
              id={id}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              maxLength={limit}
              placeholder={"Hi {buyer},\n\n…"}
              className="input mt-1.5 w-full resize-none overflow-hidden py-2.5 text-[13px] leading-[1.6]"
            />
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[11.5px] font-medium text-[var(--color-muted)]">Insert</span>
              {fillIns.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => insert(f.key)}
                  aria-label={`Insert ${f.label}`}
                  title={`{${f.key}}${f.hint ? `: ${f.hint}` : ""}`}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-2.5 py-[3px] text-[11.5px] font-medium text-[var(--color-ink)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                >
                  <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3 text-[var(--color-muted)]" aria-hidden>
                    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  {f.label}
                </button>
              ))}
              <span className={`ml-auto text-[11.5px] tabular-nums ${value.length > limit * 0.9 ? "text-amber-700" : "text-[var(--color-muted)]"}`}>
                {value.length.toLocaleString()} / {limit.toLocaleString()}
              </span>
            </div>
            {strange.length > 0 && <p className="mt-1.5 text-[11.5px] text-amber-700">{strange.join(", ")} isn&apos;t a fill-in Liston knows, so it would reach the buyer as it is.</p>}
          </div>
        </div>

        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-[var(--color-ink)]">What the buyer reads</p>
          <div className="mt-1.5 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            <div className="flex items-center gap-2.5 border-b border-[var(--color-line)] px-4 py-2.5">
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-[12px] font-semibold text-white" aria-hidden>
                {initial}
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[12.5px] font-semibold text-[var(--color-ink)]">{from || "Your store"}</span>
                <span className="block truncate text-[11.5px] text-[var(--color-muted)]">to {to} · eBay Messages</span>
              </span>
            </div>
            <div className="whitespace-pre-line px-4 py-3.5 text-[13px] leading-[1.6] text-[var(--color-ink)]">
              {preview.trim() ? preview : <span className="text-[var(--color-muted)]">Your message, filled in for an example order.</span>}
            </div>
          </div>
          {note && <div className="mt-2 text-[11.5px] leading-snug text-[var(--color-muted)]">{note}</div>}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">{footer}</div>
    </div>
  );
}
