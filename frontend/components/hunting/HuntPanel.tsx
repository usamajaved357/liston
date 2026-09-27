"use client";

import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, HuntDetail, HuntTimelineEvent } from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { money, count } from "@/components/research/format";
import { HuntResult } from "./HuntResult";
import { DecisionDialog, Decision } from "./DecisionDialog";
import { Person, StageChip, Thumb, ago, announceHuntingChange, profitInk, roiText, signedMoney , EDIT_BUTTON, EditIcon } from "./HuntBits";

// One hunted product, opened from the list: where it stands and why, the
// hunter's note, the full profit check, its history, and what the viewer
// can do with it (decide, fix and resubmit, draft; a reviewer can remove it).

function Banner({ tone, children }: { tone: "indigo" | "amber" | "rose" | "emerald" | "sky" | "teal"; children: ReactNode }) {
  const tones = {
    indigo: "border-indigo-200 bg-indigo-50/70",
    amber: "border-amber-200 bg-amber-50/80",
    rose: "border-rose-200 bg-rose-50/70",
    emerald: "border-emerald-200 bg-emerald-50/70",
    sky: "border-sky-200 bg-sky-50/70",
    teal: "border-teal-200 bg-teal-50/70",
  };
  return <div className={`rounded-[var(--radius-card)] border px-4 py-3 text-[13px] leading-relaxed text-[var(--color-ink)] ${tones[tone]}`}>{children}</div>;
}

function Quote({ text }: { text: string }) {
  return <p className="mt-1.5 whitespace-pre-line border-l-2 border-current/20 pl-3 text-[13px] text-[var(--color-ink)]">{text}</p>;
}

function StatusBanner({ hunt, you }: { hunt: HuntDetail; you: string }) {
  const who = (p: HuntDetail["reviewer"]) => (p ? (p.id === you ? "you" : p.name) : "a reviewer");
  switch (hunt.stage) {
    case "pending":
      return (
        <Banner tone="indigo">
          <b className="font-semibold">Waiting for review</b> since {ago(hunt.submittedAt)}
          {hunt.resubmits ? ` · resubmitted ${hunt.resubmits === 1 ? "once" : `${hunt.resubmits} times`}` : ""}.
          {hunt.hunter?.id === you && " The owner or a reviewer decides on it."}
        </Banner>
      );
    case "sent_back":
      return (
        <Banner tone="amber">
          <b className="font-semibold">Sent back</b> by {who(hunt.reviewer)} {ago(hunt.decidedAt)}.
          {hunt.decisionNote && <Quote text={hunt.decisionNote} />}
          {hunt.permissions.canResubmit && <p className="mt-2 text-[12.5px] text-amber-900/80">Edit the links or your note below if needed, then resubmit it for review.</p>}
        </Banner>
      );
    case "rejected":
      return (
        <Banner tone="rose">
          <b className="font-semibold">Rejected</b> by {who(hunt.reviewer)} {ago(hunt.decidedAt)}
          {hunt.rejectReasonLabel ? ` · ${hunt.rejectReasonLabel}` : ""}.
          {hunt.decisionNote && <Quote text={hunt.decisionNote} />}
        </Banner>
      );
    case "approved":
      return (
        <Banner tone="emerald">
          <b className="font-semibold">Approved</b> {hunt.autoApproved ? "as the owner added it" : `by ${who(hunt.reviewer)}`} {ago(hunt.decidedAt)}.
          {hunt.decisionNote && <Quote text={hunt.decisionNote} />}
          {hunt.permissions.canDraft && <p className="mt-1 text-[12.5px] text-emerald-900/80">Ready to draft: the draft screen opens with the options that earn already ticked.</p>}
        </Banner>
      );
    case "drafted":
      return (
        <Banner tone="sky">
          <b className="font-semibold">Drafted</b>
          {hunt.draftedBy ? ` by ${hunt.draftedBy.id === you ? "you" : hunt.draftedBy.name}` : ""} {ago(hunt.draftedAt)}.
          {hunt.listingId && hunt.permissions.canDraft && (
            <Link href={`/accounts/${hunt.connectionId}/listings/draft/${hunt.listingId}`} className="ml-1.5 font-semibold text-sky-700 hover:underline">
              Open the draft
            </Link>
          )}
        </Banner>
      );
    case "listed":
      return (
        <Banner tone="teal">
          <b className="font-semibold">Listed on eBay</b> {ago(hunt.listedAt)}
          {hunt.itemIds.length ? ` · #${hunt.itemIds[hunt.itemIds.length - 1]}` : ""}.
          <span className="mt-1 block">
            {hunt.sales
              ? `${money(hunt.sales.sales, hunt.sales.currency || hunt.currency)} from ${count(hunt.sales.orders)} order${hunt.sales.orders === 1 ? "" : "s"} (${count(hunt.sales.units)} sold) in the last 90 days.`
              : "No sales yet in the last 90 days."}
          </span>
        </Banner>
      );
    default:
      return null;
  }
}

const EVENT_WORDS: Record<HuntTimelineEvent["kind"], string> = {
  hunted: "Hunted",
  approved: "Approved",
  rejected: "Rejected",
  sent_back: "Sent back",
  resubmitted: "Resubmitted",
  updated: "Changed",
  drafted: "Drafted",
  listed: "Listed on eBay",
};
const EVENT_DOT: Record<HuntTimelineEvent["kind"], string> = {
  hunted: "bg-indigo-500",
  approved: "bg-emerald-500",
  rejected: "bg-rose-500",
  sent_back: "bg-amber-500",
  resubmitted: "bg-indigo-400",
  updated: "bg-slate-400",
  drafted: "bg-sky-500",
  listed: "bg-teal-500",
};

function Timeline({ events, you }: { events: HuntTimelineEvent[]; you: string }) {
  if (!events.length) return null;
  return (
    <section className="card p-4">
      <h3 className="text-[13px] font-semibold text-[var(--color-ink)]">History</h3>
      <ol className="relative mt-3 space-y-3 before:absolute before:bottom-1 before:left-[5px] before:top-1 before:w-px before:bg-[var(--color-line)]">
        {events.map((e, i) => (
          <li key={`${e.kind}-${i}`} className="relative flex gap-3 pl-0">
            <span className={`relative z-10 mt-1.5 h-[11px] w-[11px] flex-shrink-0 rounded-full ring-2 ring-[var(--color-panel)] ${EVENT_DOT[e.kind]}`} aria-hidden />
            <div className="min-w-0 text-[12.5px]">
              <p className="text-[var(--color-ink)]">
                <b className="font-semibold">{EVENT_WORDS[e.kind]}</b>
                {e.by ? ` by ${e.by.id === you ? "you" : e.by.name}` : ""}
                {e.auto ? " (the owner's own find, approved as added)" : ""}
                {e.reason ? ` · ${e.reason}` : ""}
                <span className="text-[var(--color-muted)]"> · {new Date(e.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
              </p>
              {e.note && <p className="mt-0.5 whitespace-pre-line text-[var(--color-muted)]">&ldquo;{e.note}&rdquo;</p>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Edit (the hunter's, while it waits or was sent back): the links and the note, read again on save.
// startOpen: opened from the list's Edit, so the form is there straight away.
function EditLinks({ hunt, onSaved, startOpen = false, onClosed }: { hunt: HuntDetail; onSaved: (h: HuntDetail) => void; startOpen?: boolean; onClosed?: () => void }) {
  const [open, setOpen] = useState(startOpen);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (open) formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [open]);
  const close = () => {
    setOpen(false);
    onClosed?.();
  };
  const [competitorUrl, setCompetitorUrl] = useState(hunt.competitorUrl || "");
  const [sourceUrl, setSourceUrl] = useState(hunt.sourceUrl);
  const [note, setNote] = useState(hunt.hunterNote || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // A cleared competitor is taken away: the product is priced at the target return.
      const saved = await api.huntUpdate(hunt.id, { competitorUrl: competitorUrl.trim() || null, sourceUrl: sourceUrl.trim(), note });
      close();
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save it. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={EDIT_BUTTON}>
        <EditIcon />
        Edit
      </button>
    );
  }
  return (
    <form ref={formRef} onSubmit={save} className="card w-full space-y-3 border-amber-200 p-4 ring-4 ring-amber-50">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-800">
        <EditIcon />
        Edit this product
      </p>
      <label className="block">
        <span className="label">
          Competitor on eBay <span className="font-normal normal-case text-[var(--color-muted)]">(optional)</span>
        </span>
        <input className="input mt-1.5" type="url" value={competitorUrl} onChange={(e) => setCompetitorUrl(e.target.value)} placeholder="https://www.ebay.co.uk/itm/…" disabled={busy} />
      </label>
      <label className="block">
        <span className="label">Supplier on AliExpress</span>
        <input className="input mt-1.5" type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} disabled={busy} required />
      </label>
      <label className="block">
        <span className="label">Your note</span>
        <textarea className="input mt-1.5 min-h-[72px] py-2" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} disabled={busy} />
      </label>
      {error && <div className="notice notice-danger">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={close} disabled={busy} className="btn btn-ghost btn-sm">
          Cancel
        </button>
        <button type="submit" disabled={busy} className="btn btn-primary btn-sm">
          {busy ? "Checking…" : "Save and check again"}
        </button>
      </div>
    </form>
  );
}

// The action that moves a product on: solid, full width on phones.
const primaryAction =
  "inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-[var(--color-primary)] px-5 text-[13.5px] font-semibold text-white shadow-[0_6px_16px_-8px_rgba(79,70,229,0.7)] transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-60 sm:w-auto";

function ActionIcon({ kind }: { kind: "remove" | "approve" | "reject" | "send_back" | "resubmit" | "draft" }) {
  const paths: Record<typeof kind, React.ReactNode> = {
    remove: <path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.2a1 1 0 001 .8h4.6a1 1 0 001-.8L14 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
    approve: <path d="M5 10.5l3.2 3.2L15 6.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
    reject: <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />,
    send_back: <path d="M8 5.5L4.5 9 8 12.5M5 9h6.5a3.5 3.5 0 010 7H10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
    resubmit: <path d="M15 8.5A5.5 5.5 0 105.5 13M15 4.5v4h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
    draft: <path d="M5 15l.6-2.8 6.9-6.9 2.2 2.2-6.9 6.9L5 15z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />,
  };
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 flex-shrink-0" aria-hidden>
      {paths[kind]}
    </svg>
  );
}

export function HuntPanel({ huntId, you, onClose, onChanged, startEditing = false }: { huntId: string; you: string; onClose: () => void; onChanged: (hunt: HuntDetail | null) => void; startEditing?: boolean }) {
  // Opened from the list's Edit: the edit form is open once, until it's saved or cancelled.
  const [editFirst, setEditFirst] = useState(startEditing);
  const router = useRouter();
  const [hunt, setHunt] = useState<HuntDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [busy, setBusy] = useState<"recheck" | "resubmit" | "remove" | "draft" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [moved, setMoved] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // (The page keys the panel by product, so a new product starts empty.)
  useEffect(() => {
    let cancelled = false;
    api
      .huntDetail(huntId)
      .then((h) => !cancelled && setHunt(h))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't open this product."));
    return () => {
      cancelled = true;
    };
  }, [huntId]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !decision && onClose();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose, decision]);

  function update(next: HuntDetail) {
    setHunt(next);
    onChanged(next);
    announceHuntingChange();
  }

  async function decide(input: { decision: Decision; reason?: string; note?: string }) {
    try {
      update(await api.huntDecide(huntId, input));
      setDecision(null);
    } catch (err) {
      throw new Error(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    }
  }

  async function run(kind: "recheck" | "resubmit", call: () => Promise<HuntDetail>) {
    setBusy(kind);
    setError(null);
    setMoved(null);
    try {
      const next = await call();
      if (kind === "recheck" && next.previous && next.previous.profit !== next.headline.profit) {
        setMoved(`Profit ${signedMoney(next.previous.profit, next.currency)} → ${signedMoney(next.headline.profit, next.currency)} since the last check.`);
      } else if (kind === "recheck") {
        setMoved("Checked again: the figures haven't changed.");
      }
      update(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    try {
      await api.huntRemove(huntId);
      announceHuntingChange();
      onChanged(null);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove it.");
      setBusy(null);
      setConfirmRemove(false);
    }
  }

  const p = hunt?.permissions;
  const decisionsOffered: Decision[] = hunt && p?.canDecide ? (["send_back", "reject", "approve"] as Decision[]).filter((d) => !(d === "approve" && hunt.stage === "approved") && !(d === "reject" && hunt.stage === "rejected") && !(d === "send_back" && hunt.stage === "sent_back")) : [];
  const hasActions = Boolean(hunt && (decisionsOffered.length || p?.canResubmit || p?.canDraft || p?.canRemove));

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Hunted product">
      <div className="absolute inset-0 bg-[var(--color-ink)]/30 backdrop-blur-[1px] animate-[fadeIn_150ms_ease-out]" onClick={onClose} aria-hidden />
      <div className="relative flex h-full w-full max-w-[900px] flex-col bg-[var(--color-paper)] shadow-2xl animate-[slideIn_200ms_ease-out]">
        <header className="border-b border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-4 sm:px-6">
          <div className="flex items-start gap-3.5">
            {hunt ? <Thumb src={hunt.imageUrl} size={56} /> : <div className="h-14 w-14 flex-shrink-0 animate-pulse rounded-xl bg-[var(--color-line)]" />}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-primary)]">Hunted product</p>
              {hunt ? <h2 className="mt-0.5 line-clamp-2 text-[15px] font-semibold leading-snug text-[var(--color-ink)]">{hunt.title}</h2> : <div className="mt-1.5 h-4 w-3/4 animate-pulse rounded bg-[var(--color-line)]" />}
              {hunt && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[var(--color-muted)]">
                  <StageChip stage={hunt.stage} />
                  <span className="inline-flex items-center gap-1">
                    <Person person={hunt.hunter} you={you} size={18} /> · {ago(hunt.createdAt)}
                  </span>
                  <span>
                    <b className={`font-semibold tabular-nums ${profitInk(hunt.headline.profit, hunt.headline.roi, hunt.targetRoiPercent, hunt.verdict === "unpriced")}`}>{signedMoney(hunt.headline.profit, hunt.currency)}</b> · {roiText(hunt.headline.roi)}
                    {hunt.verdict === "unpriced" ? " at your price" : ""}
                  </span>
                </div>
              )}
            </div>
            {/* Always a ring, not only when the browser shows focus: the same look every time. */}
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border-2 border-[var(--color-primary)]/70 bg-white text-[var(--color-ink)] outline-none transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)] hover:text-[var(--color-primary)] focus-visible:border-[var(--color-primary)] focus-visible:bg-[var(--color-primary-soft)]"
              // It draws its own ring, so the app's global focus outline would make a second one.
              style={{ outline: "none" }}
              aria-label="Close"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
          {error && <div className="notice notice-danger">{error}</div>}
          {!hunt && !error && (
            <div className="space-y-4">
              <div className="h-20 animate-pulse rounded-[var(--radius-card)] bg-[var(--color-line)]/60" />
              <div className="h-64 animate-pulse rounded-[var(--radius-card)] bg-[var(--color-line)]/60" />
            </div>
          )}
          {hunt && (
            <>
              <StatusBanner hunt={hunt} you={you} />
              {hunt.hunterNote && (
                <div className="card px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{hunt.hunter?.id === you ? "Your note" : `${hunt.hunter?.name || "The hunter"}'s note`}</p>
                  <p className="mt-1 whitespace-pre-line text-[13px] text-[var(--color-ink)]">{hunt.hunterNote}</p>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-[var(--color-muted)]">Figures from {ago(hunt.checkedAt)}</span>
                {p?.canRecheck && (
                  <button type="button" onClick={() => run("recheck", () => api.huntRecheck(huntId))} disabled={busy !== null} className="btn btn-ghost btn-sm text-[var(--color-primary)]">
                    {busy === "recheck" ? "Checking…" : "Check again"}
                  </button>
                )}
                {p?.canEdit && <EditLinks key={hunt.checkedAt} hunt={hunt} onSaved={update} startOpen={editFirst} onClosed={() => setEditFirst(false)} />}
                {moved && <span className="text-[12px] font-medium text-[var(--color-ink)]">{moved}</span>}
              </div>
              <HuntResult result={hunt.result} />
              <Timeline events={hunt.timeline} you={you} />
            </>
          )}
        </div>

        {hunt && hasActions && (
          <footer className="flex-shrink-0 border-t border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_-18px_rgba(15,23,42,0.3)] sm:px-6">
            <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              {/* Taking it off the list (reviewers only): quiet until pointed at. */}
              <div className="flex justify-center sm:justify-start">
                {p?.canRemove && (
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(true)}
                    disabled={busy !== null}
                    className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-[var(--color-muted)] transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                  >
                    <ActionIcon kind="remove" />
                    Remove
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {/* The reviewer's other answers, side by side, then the one that moves it on. */}
                {decisionsOffered.filter((d) => d !== "approve").length > 0 && (
                  <div className="flex flex-1 gap-2 sm:flex-none">
                    {decisionsOffered
                      .filter((d) => d !== "approve")
                      .map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setDecision(d)}
                          disabled={busy !== null}
                          className={`inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full border px-4 text-[13.5px] font-semibold transition-colors disabled:opacity-50 sm:flex-none ${
                            d === "reject"
                              ? "border-rose-200 bg-white text-rose-600 hover:border-rose-300 hover:bg-rose-50"
                              : "border-[var(--color-line)] bg-white text-[var(--color-ink)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper)]"
                          }`}
                        >
                          <ActionIcon kind={d} />
                          {d === "reject" ? "Reject" : "Send back"}
                        </button>
                      ))}
                  </div>
                )}
                {(decisionsOffered.includes("approve") || p?.canResubmit || p?.canDraft) && decisionsOffered.some((d) => d !== "approve") && (
                  <span className="mx-1 hidden h-6 w-px bg-[var(--color-line)] sm:block" aria-hidden />
                )}
                {decisionsOffered.includes("approve") && (
                  <button type="button" onClick={() => setDecision("approve")} disabled={busy !== null} className={primaryAction}>
                    <ActionIcon kind="approve" />
                    Approve
                  </button>
                )}
                {p?.canResubmit && (
                  <button type="button" onClick={() => run("resubmit", () => api.huntResubmit(huntId))} disabled={busy !== null} className={primaryAction}>
                    <ActionIcon kind="resubmit" />
                    {busy === "resubmit" ? "Resubmitting…" : "Resubmit for review"}
                  </button>
                )}
                {p?.canDraft && (
                  <button
                    type="button"
                    onClick={() => {
                      setBusy("draft");
                      router.push(`/accounts/${hunt.connectionId}/listings/new?hunt=${hunt.id}`);
                    }}
                    disabled={busy !== null}
                    className={primaryAction}
                  >
                    <ActionIcon kind="draft" />
                    {busy === "draft" ? "Opening…" : hunt.stage === "approved" ? "Draft this product" : "Draft it again"}
                    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 opacity-80" aria-hidden>
                      <path d="M7.5 5l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </footer>
        )}
      </div>

      <DecisionDialog decision={decision} reasons={hunt?.reasons || []} title={hunt?.title || ""} onClose={() => setDecision(null)} onSubmit={decide} />
      <ConfirmDialog
        open={confirmRemove}
        title="Remove this product?"
        description={
          hunt?.hunter && hunt.hunter.id !== you
            ? `It comes off the hunting list, whatever its stage, and ${hunt.hunter.name} is notified. Its history stays in the team's activity.`
            : "It comes off the hunting list, whatever its stage. Its history stays in the team's activity."
        }
        confirmLabel="Remove"
        danger
        loading={busy === "remove"}
        onConfirm={remove}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  );
}
