"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AccessRequest, api, ApiError, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { Alert } from "@/components/Alert";
import { formatDateTime } from "@/lib/format";

// The in-app version of the approve/reject email, for when the email is
// lost or the admin would rather see everyone waiting at once.
export default function AccessRequestsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [reviewed, setReviewed] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "rejected">("all");

  useEffect(() => {
    Promise.all([api.me(), api.listAccessRequests()])
      .then(([me, list]) => {
        if (!me.user.is_admin) {
          router.replace("/dashboard");
          return;
        }
        setUser(me.user);
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

  async function decide(id: string, status: "active" | "rejected" | "pending") {
    setBusyId(id);
    setError(null);
    try {
      await api.decideAccessRequest(id, status);
      // Move the row between the two lists locally rather than refetching.
      const from = requests.find((r) => r.id === id) || reviewed.find((r) => r.id === id);
      if (from) {
        const updated = { ...from, access_status: status, access_reviewed_at: status === "pending" ? null : new Date().toISOString() };
        setRequests((list) => (status === "pending" ? [...list.filter((r) => r.id !== id), updated] : list.filter((r) => r.id !== id)));
        setReviewed((list) => (status === "pending" ? list.filter((r) => r.id !== id) : [updated, ...list.filter((r) => r.id !== id)]));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that decision.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-[var(--color-muted)]">Loading…</p>
      </main>
    );
  }

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

  const StatusPill = ({ status }: { status: "active" | "rejected" }) =>
    status === "active" ? (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
        <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
          <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Approved
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-200">
        <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
        Rejected
      </span>
    );

  const UndoIcon = (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M4 10h11a5 5 0 010 10h-4M4 10l4-4M4 10l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

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
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">People who signed up and are waiting for a yes.</p>
        </div>
      }
    >
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Waiting</h2>
        <span className="rounded-full bg-[var(--color-primary-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-primary)]">{requests.length}</span>
      </div>

      {requests.length === 0 ? (
        <div className="card px-6 py-10 text-center">
          <p className="text-sm font-medium text-[var(--color-ink)]">Nobody waiting</p>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">New sign-ups appear here and in your inbox.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <div key={r.id} className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <Person r={r} />
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => decide(r.id, "rejected")} disabled={busyId === r.id} className="btn btn-secondary btn-sm text-[var(--color-danger)]">
                    Reject
                  </button>
                  <button type="button" onClick={() => decide(r.id, "active")} disabled={busyId === r.id} className="btn btn-primary btn-sm">
                    Approve
                  </button>
                </div>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto]">
                <div>
                  <p className="label">About their business</p>
                  <p className={`mt-1 text-[13.5px] leading-relaxed ${r.access_note ? "text-[var(--color-ink)]" : "italic text-[var(--color-muted)]"}`}>
                    {r.access_note || "No note left."}
                  </p>
                </div>
                <div className="flex flex-wrap items-start gap-1.5 sm:justify-end">
                  <span className="chip font-medium" title="When they signed up">{formatDateTime(r.created_at)}</span>
                  <span className={`chip font-medium ${r.email_verified_at ? "chip-accent" : "chip-warning"}`}>
                    {r.email_verified_at ? "Email verified" : "Email not verified"}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {reviewed.length > 0 && (
        <div className="mt-10">
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
                  ["rejected", "Rejected"],
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
            {shown.length === 0 ? (
              <p className="px-5 py-8 text-center text-[13px] text-[var(--color-muted)]">Nothing {filter === "active" ? "approved" : "rejected"} in the last 30 days.</p>
            ) : (
              shown.map((r) => (
                <div key={r.id} className="grid items-center gap-4 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
                  <Person r={r} size="sm" />
                  <div className="flex flex-col items-start gap-1 sm:items-center">
                    <StatusPill status={r.access_status === "active" ? "active" : "rejected"} />
                    <span className="text-[11px] text-[var(--color-muted)]">{r.access_reviewed_at ? formatDateTime(r.access_reviewed_at) : ""}</span>
                  </div>
                  <div className="flex items-center justify-end gap-1.5">
                    {r.access_status === "rejected" ? (
                      <button type="button" onClick={() => decide(r.id, "active")} disabled={busyId === r.id} className="btn btn-secondary btn-sm">
                        Approve instead
                      </button>
                    ) : (
                      <button type="button" onClick={() => decide(r.id, "rejected")} disabled={busyId === r.id} className="btn btn-secondary btn-sm text-[var(--color-danger)]">
                        Revoke
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => decide(r.id, "pending")}
                      disabled={busyId === r.id}
                      className="btn btn-ghost btn-icon"
                      title="Undo — put back in the queue"
                      aria-label="Undo decision"
                    >
                      {UndoIcon}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}
