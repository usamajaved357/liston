"use client";

import { EbayNote } from "@/lib/api";
import { timeLabel } from "../inbox-format";

// A note on a buyer's conversation that only the team sees, drawn among
// the messages in amber.

/** A note among the messages: the team's only, on the right with the seller's side, in amber. */
export function NoteBubble({ note, onDelete }: { note: EbayNote; onDelete?: () => void }) {
  return (
    <div className="mt-2 flex justify-end px-[clamp(12px,1.5%,20px)]">
      <div className="group relative max-w-[85%] rounded-md border border-amber-200 bg-amber-50 px-[9px] pb-[6px] pt-[5px] text-[13px] leading-[19px] text-amber-950 shadow-[var(--shadow-bubble)] sm:max-w-[min(65%,440px)]">
        <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-amber-700">
          <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden>
            <rect x="3" y="2.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          Note{note.author ? ` · ${note.mine ? "you" : note.author.name}` : ""}
          <span className="font-normal normal-case tracking-normal text-amber-700/80">· the buyer doesn&apos;t see this</span>
        </p>
        <p className="mt-0.5 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{note.body}</p>
        <p className="mt-0.5 flex items-center justify-end gap-2 text-[10.5px] tabular-nums text-amber-700/80">
          {onDelete && note.canDelete && (
            <button type="button" onClick={onDelete} className="font-medium opacity-0 transition-opacity hover:underline focus:opacity-100 group-hover:opacity-100">
              Delete
            </button>
          )}
          {timeLabel(note.createdAt)}
        </p>
      </div>
    </div>
  );
}
