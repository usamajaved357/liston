"use client";

import { useEffect, useRef, useState } from "react";

// The pieces of a list's CSV download (Orders, Listings): a checkbox to tick
// rows (one row, or every row on the page from the header, partly ticked when
// some are), and the button that downloads the ticked rows, or everything the
// filters show when none are, saying how many went into the file.

export function SelectBox({ checked, indeterminate = false, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className="flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center" onClick={(e) => e.stopPropagation()}>
      <input ref={ref} type="checkbox" checked={checked} onChange={onChange} aria-label={label} className="h-4 w-4 cursor-pointer rounded border-[var(--color-line-strong)] accent-[var(--color-primary)]" />
    </label>
  );
}

export function CsvButton({ selected, noun, run }: { selected: number; noun: string; run: () => Promise<number> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function click() {
    setBusy(true);
    setNote(null);
    try {
      const rows = await run();
      setNote(`${rows} ${rows === 1 ? noun : `${noun}s`} downloaded`);
    } catch (err) {
      setNote(err instanceof Error && err.message ? err.message : "Couldn't make the file. Try again.");
    } finally {
      setBusy(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setNote(null), 4000);
    }
  }

  // A slim capsule beside the header's sync time: quiet until rows are
  // ticked, then tinted to say the file is only those.
  return (
    <button
      type="button"
      onClick={click}
      disabled={busy}
      title={note || (selected ? `Download the ${selected} ticked ${selected === 1 ? noun : `${noun}s`} as a CSV file` : `Download every ${noun} these filters show as a CSV file`)}
      className={`inline-flex h-7 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[12px] font-medium transition-colors disabled:cursor-wait ${
        selected
          ? "border-[var(--color-primary)]/25 bg-[var(--color-primary-soft)] text-[var(--color-primary)] hover:border-[var(--color-primary)]/45"
          : "border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-ink)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper)]"
      }`}
    >
      {busy ? (
        <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden />
      ) : (
        <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 text-[var(--color-primary)]" aria-hidden>
          <path d="M12 4.5v10M8 10.5l4 4 4-4M5.5 19h13" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span aria-live="polite">{busy ? "Preparing…" : note || (selected ? `Download ${selected} selected` : "Download CSV")}</span>
    </button>
  );
}
