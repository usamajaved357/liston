"use client";

import { useState } from "react";
import { EbayNote, EbayWorkStatus, TeamPerson } from "@/lib/api";
import { MenuItem, PopMenu } from "../ChatBubble";
import { colorFor, initialOf, timeLabel } from "../inbox-format";

// A buyer's conversation as team work, in the thread's header: who has it
// (a round button with their initial, or a person outline for no one; a
// pick gives it to someone with the Inbox on this account, who's told) and
// where it stands (Open · Waiting · Done, a buyer writing again opens it);
// and a note only the team sees, drawn among the messages in amber.

export const WORK: Record<EbayWorkStatus, { label: string; dot: string; text: string; hint: string }> = {
  open: { label: "Open", dot: "bg-sky-500", text: "text-sky-700", hint: "Needs handling" },
  waiting: { label: "Waiting", dot: "bg-amber-500", text: "text-amber-700", hint: "Waiting on the buyer, a supplier or eBay" },
  done: { label: "Done", dot: "bg-emerald-500", text: "text-emerald-700", hint: "Resolved" },
};

export function PersonDot({ person, size = 22 }: { person: TeamPerson; size?: number }) {
  return (
    <span className="flex flex-shrink-0 items-center justify-center rounded-full font-semibold text-white" style={{ width: size, height: size, fontSize: Math.round(size * 0.45), background: colorFor(person.name) }} aria-hidden>
      {initialOf(person.name)}
    </span>
  );
}

const check = (
  <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden>
    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const blank = <span className="h-3.5 w-3.5" aria-hidden />;

/** Who has the conversation; a pick gives it to someone (or no one). */
export function AssignButton({ team, assignee, me, disabled, onAssign }: { team: TeamPerson[]; assignee: TeamPerson | null; me: string | null; disabled?: boolean; onAssign: (userId: string | null) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const items: MenuItem[] = [
    ...team.map((p) => ({ label: p.id === me ? `${p.name} (you)` : p.name, icon: p.id === assignee?.id ? check : blank, onSelect: () => onAssign(p.id) })),
    ...(assignee ? [{ label: "No one", icon: blank, onSelect: () => onAssign(null) }] : []),
  ];
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        title={assignee ? `${assignee.name} has this conversation` : "Give this conversation to someone"}
        aria-label={assignee ? `Given to ${assignee.name}` : "Give to someone"}
        className="flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full px-1.5 text-[12px] font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] disabled:opacity-50"
      >
        {assignee ? (
          <PersonDot person={assignee} />
        ) : (
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-dashed border-[var(--color-muted)]/60">
            <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden>
              <circle cx="8" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M3.5 13.5c.6-2.3 2.4-3.5 4.5-3.5s3.9 1.2 4.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </span>
        )}
        <span className="hidden max-w-[90px] truncate xl:inline">{assignee ? assignee.name : "Assign"}</span>
      </button>
      {anchor && <PopMenu anchor={anchor} items={items} onClose={() => setAnchor(null)} />}
    </>
  );
}

/** Where the conversation stands; a pick changes it. */
export function WorkButton({ status, by, disabled, onChange }: { status: EbayWorkStatus; by: TeamPerson | null; disabled?: boolean; onChange: (s: EbayWorkStatus) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const w = WORK[status];
  const items: MenuItem[] = (Object.keys(WORK) as EbayWorkStatus[]).map((k) => ({ label: WORK[k].label, icon: k === status ? check : blank, onSelect: () => onChange(k) }));
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        title={by && status !== "open" ? `${w.label}, marked by ${by.name}` : w.hint}
        aria-label={`Status: ${w.label}`}
        className={`flex h-7 flex-shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] pl-2 pr-1.5 text-[11.5px] font-semibold transition-colors hover:bg-[var(--color-paper)] disabled:opacity-50 ${w.text}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${w.dot}`} aria-hidden />
        {/* On a phone the dot says it; the header keeps room for the buyer's name. */}
        <span className="hidden sm:inline">{w.label}</span>
        <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3 text-[var(--color-muted)]" aria-hidden>
          <path d="M4.5 6.5l3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {anchor && <PopMenu anchor={anchor} items={items} onClose={() => setAnchor(null)} />}
    </>
  );
}

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
