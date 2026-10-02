"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AccessRequest, api, ApiError, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cacheUser, useCachedUser } from "@/lib/session";
import { Alert } from "@/components/Alert";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatDateTime } from "@/lib/format";
import { PillTabs } from "@/components/PillTabs";
import { timeAgo } from "@/components/team/team-shared";

// Access requests (admins only): the in-app version of the approve and
// reject email, for when the email is lost or the admin would rather see
// everyone at once. The counts at the top; everyone waiting as a card of
// their own (who, their workspace, when, whether their email is verified,
// what they said about their business) with Approve and Reject; and the
// last 30 days' decisions, each one reversible.

function initials(r: AccessRequest) {
  const parts = (r.name || r.email).trim().split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}

function Face({ r, size = 40 }: { r: AccessRequest; size?: number }) {
  return (
    <span
      style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
      className="flex flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] font-semibold text-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]/15"
      aria-hidden
    >
      {initials(r)}
    </span>
  );
}

function Chip({ tone, children }: { tone: "emerald" | "amber" | "rose" | "slate"; children: React.ReactNode }) {
  const tones = {
    emerald: ["bg-emerald-50 text-emerald-700 ring-emerald-200", "bg-emerald-500"],
    amber: ["bg-amber-50 text-amber-800 ring-amber-200", "bg-amber-500"],
    rose: ["bg-rose-50 text-rose-700 ring-rose-200", "bg-rose-500"],
    slate: ["bg-slate-50 text-slate-600 ring-slate-200", "bg-slate-400"],
  }[tone];
  return (
    <span className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${tones[0]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tones[1]}`} aria-hidden />
      {children}
    </span>
  );
}

function Count({ label, value, note, tone }: { label: string; value: number; note: string; tone?: "amber" }) {
  return (
    <div className="px-5 py-4">
      <p className="text-[12px] font-medium text-[var(--color-muted)]">{label}</p>
      <p className={`mt-1 text-[22px] font-semibold leading-tight tracking-tight tabular-nums ${tone === "amber" && value > 0 ? "text-amber-700" : "text-[var(--color-ink)]"}`}>{value}</p>
      <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">{note}</p>
    </div>
  );
}

// One applicant waiting for a decision.
function Applicant({ r, busy, onApprove, onReject }: { r: AccessRequest; busy: boolean; onApprove: () => void; onReject: () => void }) {
  return (
    <article className="card px-5 py-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <Face r={r} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-[15px] font-semibold text-[var(--color-ink)]">{r.name || "No name given"}</p>
            {r.email_verified_at ? <Chip tone="emerald">Email verified</Chip> : <Chip tone="amber">Email not verified</Chip>}
          </div>
          <a href={`mailto:${r.email}`} className="block truncate text-[13px] text-[var(--color-muted)] hover:text-[var(--color-primary)] hover:underline">
            {r.email}
          </a>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-[var(--color-muted)]">
            {r.team_name && <span>{`Workspace: ${r.team_name}`}</span>}
            <span title={formatDateTime(r.created_at)}>{`Signed up ${timeAgo(r.created_at)}`}</span>
          </p>
        </div>
        <div className="flex w-full flex-shrink-0 items-center justify-end gap-2 sm:w-auto">
          <button type="button" onClick={onReject} disabled={busy} className="btn btn-ghost btn-sm text-[var(--color-danger)]">
            Reject
          </button>
          <button type="button" onClick={onApprove} disabled={busy} className="btn btn-primary btn-sm">
            {busy ? "Saving…" : "Approve"}
          </button>
        </div>
      </div>
      <div className="mt-3.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] px-4 py-3">
        <p className="text-[11.5px] font-medium text-[var(--color-muted)]">About their business</p>
        <p className={`mt-1 whitespace-pre-line text-[13.5px] leading-relaxed ${r.access_note ? "text-[var(--color-ink)]" : "italic text-[var(--color-muted)]"}`}>{r.access_note || "No note left."}</p>
      </div>
    </article>
  );
}

export default function AccessRequestsPage() {
  const router = useRouter();
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [reviewed, setReviewed] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "rejected">("all");
  const [confirmReject, setConfirmReject] = useState<AccessRequest | null>(null);

  useEffect(() => {
    Promise.all([api.me(), api.listAccessRequests()])
      .then(([me, list]) => {
        if (!me.user.is_admin) {
          router.replace("/dashboard");
          return;
        }
        setUser(me.user);
        cacheUser(me.user);
        setRequests(list.requests);
        setReviewed(list.reviewed);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
        else if (err instanceof ApiError && err.status === 403) router.replace("/dashboard");
        else setError("Couldn't load access requests.");
      })
      .finally(() => setLoading(false));
  }, [router]);

  async function decide(id: string, status: "active" | "rejected") {
    setBusyId(id);
    setError(null);
    try {
      const { user: result } = await api.decideAccessRequest(id, status);
      const from = requests.find((r) => r.id === id) || reviewed.find((r) => r.id === id);
      setRequests((list) => list.filter((r) => r.id !== id));
      if (result.deleted || !from) {
        // A rejected applicant's sign-up is gone: nothing to show.
        setReviewed((list) => list.filter((r) => r.id !== id));
      } else {
        setReviewed((list) => [{ ...from, access_status: status, access_reviewed_at: new Date().toISOString() }, ...list.filter((r) => r.id !== id)]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that decision.");
    } finally {
      setBusyId(null);
    }
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
        <PageSkeleton />
      </main>
    );
  }

  const shown = reviewed.filter((r) => filter === "all" || r.access_status === filter);
  const counts = {
    all: reviewed.length,
    active: reviewed.filter((r) => r.access_status === "active").length,
    rejected: reviewed.filter((r) => r.access_status === "rejected").length,
  };

  return (
    <AppShell
      connectionsUsed={Number(user.connections_used ?? 0)}
      maxConnections={user.max_connections ?? 0}
      planName={user.plan_name ?? "Unassigned"}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Access requests</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Who gets into Liston. Approving someone also verifies their email.</p>
        </div>
      }
    >
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {loading ? (
        <PageSkeleton rows={2} />
      ) : (
        <div className="max-w-4xl space-y-8 pb-4">
          <section className="card grid grid-cols-3 divide-x divide-[var(--color-line)]">
            <Count label="Waiting" value={requests.length} note="for a decision" tone="amber" />
            <Count label="Approved" value={counts.active} note="in the last 30 days" />
            <Count label="Revoked" value={counts.rejected} note="in the last 30 days" />
          </section>

          <section>
            <div className="mb-3 flex items-baseline gap-2">
              <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Waiting for a decision</h2>
              {requests.length > 0 && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-800 ring-1 ring-inset ring-amber-200">{requests.length}</span>}
            </div>
            {requests.length === 0 ? (
              <div className="card flex items-center gap-4 px-5 py-5">
                <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-inset ring-emerald-200" aria-hidden>
                  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                    <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div>
                  <p className="text-[14px] font-semibold text-[var(--color-ink)]">You&apos;re all caught up</p>
                  <p className="text-[13px] text-[var(--color-muted)]">New sign-ups appear here, and in your email.</p>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {requests.map((r) => (
                  <Applicant key={r.id} r={r} busy={busyId === r.id} onApprove={() => decide(r.id, "active")} onReject={() => setConfirmReject(r)} />
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-baseline gap-2">
                <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Recently reviewed</h2>
                <span className="text-[12px] text-[var(--color-muted)]">last 30 days</span>
              </div>
              {reviewed.length > 0 && (
                <PillTabs
                  label="Reviewed"
                  tabs={(
                    [
                      ["all", "All"],
                      ["active", "Approved"],
                      ["rejected", "Revoked"],
                    ] as const
                  ).map(([key, label]) => ({ key, label, count: counts[key] }))}
                  value={filter}
                  onChange={setFilter}
                />
              )}
            </div>
            <div className="card overflow-hidden">
              {shown.length === 0 ? (
                <p className="px-5 py-8 text-center text-[13px] text-[var(--color-muted)]">
                  {reviewed.length === 0 ? "No decisions in the last 30 days." : `Nothing ${filter === "active" ? "approved" : "revoked"} in the last 30 days.`}
                </p>
              ) : (
                <ul className="divide-y divide-[var(--color-line)]">
                  {shown.map((r) => {
                    const approved = r.access_status === "active";
                    return (
                      <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                        <Face r={r} size={36} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13.5px] font-semibold text-[var(--color-ink)]">{r.name || r.email}</p>
                          <p className="truncate text-[12px] text-[var(--color-muted)]">{[r.name ? r.email : null, r.team_name].filter(Boolean).join(" · ")}</p>
                        </div>
                        <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
                          <span className="flex items-center gap-3">
                            {approved ? <Chip tone="emerald">Approved</Chip> : <Chip tone="rose">Revoked</Chip>}
                            <span className="w-[86px] text-[12px] text-[var(--color-muted)]" title={r.access_reviewed_at ? formatDateTime(r.access_reviewed_at) : undefined}>
                              {r.access_reviewed_at ? timeAgo(r.access_reviewed_at) : "—"}
                            </span>
                          </span>
                          {approved ? (
                            <button type="button" onClick={() => setConfirmReject(r)} disabled={busyId === r.id} className="btn btn-ghost btn-sm w-[96px] text-[var(--color-danger)]">
                              Revoke
                            </button>
                          ) : (
                            <button type="button" onClick={() => decide(r.id, "active")} disabled={busyId === r.id} className="btn btn-secondary btn-sm w-[96px]">
                              Restore
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={confirmReject !== null}
        title={confirmReject?.access_status === "active" ? `Revoke access for ${confirmReject?.name || confirmReject?.email}?` : `Reject ${confirmReject?.name || confirmReject?.email}?`}
        description={
          confirmReject?.access_status === "active"
            ? "They're locked out at once and emailed. Their accounts, listings and workspace are kept, and you can restore access from here."
            : "They're emailed that access isn't available, and their sign-up is deleted. They can sign up again later."
        }
        confirmLabel={confirmReject?.access_status === "active" ? "Revoke access" : "Reject"}
        danger
        loading={busyId === confirmReject?.id}
        onCancel={() => setConfirmReject(null)}
        onConfirm={async () => {
          if (!confirmReject) return;
          const id = confirmReject.id;
          setConfirmReject(null);
          await decide(id, "rejected");
        }}
      />
    </AppShell>
  );
}
