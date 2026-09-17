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

function initials(r: AccessRequest) {
  const source = (r.name || r.email).trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}


function Person({ r, size = "md" }: { r: AccessRequest; size?: "md" | "sm" }) {
  const big = size === "md";
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        className={`flex flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] font-semibold text-[var(--color-primary)] ${
          big ? "h-10 w-10 text-sm" : "h-9 w-9 text-xs"
        }`}
      >
        {initials(r)}
      </span>
      <div className="min-w-0">
        <p className={`truncate font-semibold text-[var(--color-ink)] ${big ? "text-[15px]" : "text-sm"}`}>{r.name || "No name given"}</p>
        <a href={`mailto:${r.email}`} className="block truncate text-[13px] text-[var(--color-muted)] hover:text-[var(--color-primary)] hover:underline">
          {r.email}
        </a>
      </div>
    </div>
  );
}


const StatusPill = ({ status }: { status: "active" | "rejected" | "pending" }) => {
  const styles = {
    active: ["bg-emerald-50 text-emerald-700 ring-emerald-200", "bg-emerald-500", "Approved"],
    rejected: ["bg-rose-50 text-rose-700 ring-rose-200", "bg-rose-500", "Access revoked"],
    pending: ["bg-amber-50 text-amber-800 ring-amber-200", "bg-amber-500", "Waiting"],
  }[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${styles[0]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${styles[1]}`} />
      {styles[2]}
    </span>
  );
};


// Every row in both lists shares one column template so names, statuses,
// dates and buttons line up top to bottom, whatever the row's state.
const COLS = "grid items-center gap-4 px-5 sm:grid-cols-[minmax(0,1fr)_130px_140px_200px]";
const ColHead = ({ children }: { children: React.ReactNode }) => (
  <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{children}</span>
);


// The in-app version of the approve/reject email, for when the email is
// lost or the admin would rather see everyone waiting at once.
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
        // A rejected applicant's account is gone — nothing to show.
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
      <main className="min-h-screen bg-[var(--color-paper)] p-10">
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
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Who gets into Liston. Approving an applicant also verifies their email.</p>
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
        <>
          <section>
            <div className="mb-3 flex items-baseline gap-2">
              <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Waiting for a decision</h2>
              <span className="rounded-full bg-[var(--color-primary-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-primary)]">{requests.length}</span>
            </div>

            {requests.length === 0 ? (
              <div className="card flex items-center gap-4 px-5 py-4">
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                    <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div>
                  <p className="text-sm font-medium text-[var(--color-ink)]">You&apos;re all caught up</p>
                  <p className="text-[13px] text-[var(--color-muted)]">New sign-ups show up here and in your inbox.</p>
                </div>
              </div>
            ) : (
              <div className="card divide-y divide-[var(--color-line)]">
                <div className={`${COLS} hidden py-2.5 sm:grid`}>
                  <ColHead>Applicant</ColHead>
                  <ColHead>Email</ColHead>
                  <ColHead>Signed up</ColHead>
                  <span />
                </div>
                {requests.map((r) => (
                  <div key={r.id} className="px-5 py-4">
                    <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_130px_140px_200px]">
                      <Person r={r} />
                      <div>
                        <span className={`chip font-medium ${r.email_verified_at ? "chip-accent" : "chip-warning"}`}>
                          {r.email_verified_at ? "Verified" : "Unverified"}
                        </span>
                      </div>
                      <span className="text-[13px] text-[var(--color-muted)]">{formatDateTime(r.created_at)}</span>
                      <div className="flex items-center justify-end gap-2">
                        <button type="button" onClick={() => setConfirmReject(r)} disabled={busyId === r.id} className="btn btn-danger btn-sm">
                          Reject
                        </button>
                        <button type="button" onClick={() => decide(r.id, "active")} disabled={busyId === r.id} className="btn btn-accent btn-sm">
                          Approve
                        </button>
                      </div>
                    </div>
                    <div className="mt-3 rounded-xl bg-[var(--color-paper)] px-4 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">About their business</p>
                      <p className={`mt-1 text-[13.5px] leading-relaxed ${r.access_note ? "text-[var(--color-ink)]" : "italic text-[var(--color-muted)]"}`}>
                        {r.access_note || "No note left."}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {reviewed.length > 0 && (
            <section className="mt-8">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Recently reviewed</h2>
                  <span className="text-[12px] text-[var(--color-muted)]">last 30 days</span>
                </div>
                <div className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
                  {(
                    [
                      ["all", "All"],
                      ["active", "Approved"],
                      ["rejected", "Revoked"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setFilter(key)}
                      className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors ${
                        filter === key ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                      }`}
                    >
                      {label}
                      <span className={filter === key ? "text-white/70" : "text-[var(--color-muted)]/70"}>{counts[key]}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="card divide-y divide-[var(--color-line)]">
                <div className={`${COLS} hidden py-2.5 sm:grid`}>
                  <ColHead>Person</ColHead>
                  <ColHead>Status</ColHead>
                  <ColHead>Reviewed</ColHead>
                  <span />
                </div>
                {shown.length === 0 ? (
                  <p className="px-5 py-8 text-center text-[13px] text-[var(--color-muted)]">Nothing {filter === "active" ? "approved" : "revoked"} in the last 30 days.</p>
                ) : (
                  shown.map((r) => (
                    <div key={r.id} className={`${COLS} py-3`}>
                      <Person r={r} size="sm" />
                      <div>
                        <StatusPill status={r.access_status === "active" ? "active" : "rejected"} />
                      </div>
                      <span className="text-[13px] text-[var(--color-muted)]">{r.access_reviewed_at ? formatDateTime(r.access_reviewed_at) : "—"}</span>
                      <div className="flex items-center justify-end">
                        {r.access_status === "rejected" ? (
                          <button type="button" onClick={() => decide(r.id, "active")} disabled={busyId === r.id} className="btn btn-accent btn-sm w-[132px]">
                            Restore access
                          </button>
                        ) : (
                          <button type="button" onClick={() => setConfirmReject(r)} disabled={busyId === r.id} className="btn btn-danger btn-sm w-[132px]">
                            Revoke access
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmReject !== null}
        title={confirmReject?.access_status === "active" ? `Revoke access for ${confirmReject?.name || confirmReject?.email}?` : `Reject ${confirmReject?.name || confirmReject?.email}?`}
        description={
          confirmReject?.access_status === "active"
            ? "They'll be locked out immediately and emailed. Their connections, listings and team are kept, and you can restore access from here."
            : "They'll be emailed that access isn't available, and their sign-up will be deleted. They can sign up again later."
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
