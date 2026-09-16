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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.me(), api.listAccessRequests()])
      .then(([me, list]) => {
        if (!me.user.is_admin) {
          router.replace("/dashboard");
          return;
        }
        setUser(me.user);
        setRequests(list.requests);
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
      await api.decideAccessRequest(id, status);
      setRequests((list) => list.filter((r) => r.id !== id));
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

  return (
    <AppShell
      connectionsUsed={Number(user.connections_used ?? 0)}
      maxConnections={user.max_connections ?? 0}
      planName={user.plan_name ?? "Unassigned"}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div>
          <h1 className="text-xl font-extrabold text-[var(--color-ink)]">Access requests</h1>
          <p className="mt-0.5 text-sm text-[var(--color-muted)]">People who signed up and are waiting for a yes.</p>
        </div>
      }
    >
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {requests.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm font-semibold text-[var(--color-ink)]">Nobody waiting</p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">New sign-ups appear here and in your inbox.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => (
            <div key={r.id} className="card flex flex-wrap items-center gap-4 p-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[var(--color-ink)]">
                  {r.name || r.email}
                  {r.name && <span className="ml-2 font-normal text-[var(--color-muted)]">{r.email}</span>}
                </p>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  Requested {formatDateTime(r.created_at)} · {r.email_verified_at ? "email verified" : "email not verified yet"}
                </p>
                {r.access_note && <p className="mt-2 text-sm text-[var(--color-ink)]">“{r.access_note}”</p>}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => decide(r.id, "rejected")} disabled={busyId === r.id} className="btn btn-danger-ghost btn-sm">
                  Reject
                </button>
                <button type="button" onClick={() => decide(r.id, "active")} disabled={busyId === r.id} className="btn btn-primary btn-sm">
                  Approve
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
