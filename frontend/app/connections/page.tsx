"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, Connection, Platform, User } from "@/lib/api";
import { landingPathForConnection } from "@/lib/permissions";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cacheUser, useCachedUser } from "@/lib/session";
import { AccountMenu } from "@/components/AccountMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert } from "@/components/Alert";
import { PlatformIcon } from "@/components/PlatformIcon";
import { AddConnectionPanel } from "@/components/AddConnectionPanel";
import { formatShortDate } from "@/lib/format";

const STATUS: Record<Connection["status"], { label: string; dot: string; chip: string }> = {
  active: { label: "Connected", dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  expired: { label: "Reconnect needed", dot: "bg-amber-500", chip: "bg-amber-50 text-amber-800 ring-amber-200" },
  error: { label: "Needs attention", dot: "bg-rose-500", chip: "bg-rose-50 text-rose-700 ring-rose-200" },
  suspended: { label: "Suspended", dot: "bg-rose-500", chip: "bg-rose-50 text-rose-700 ring-rose-200" },
};

function StatusPill({ status }: { status: Connection["status"] }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${s.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

const TrashIcon = (
  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// One connected account per row: who it is, whether it's healthy, and a
// way in. Everything else lives inside the account itself.
function AccountRow({ connection, onRemove }: { connection: Connection; onRemove: () => void }) {
  const base = `/accounts/${connection.id}`;
  return (
    <li className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-[var(--color-paper)]">
      <Link href={base} className="flex min-w-0 flex-1 items-center gap-4">
        <PlatformIcon platformKey={connection.platform_key} size={44} />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{connection.label}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-[var(--color-muted)]">
            {connection.marketplace && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-paper)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-ink)] ring-1 ring-inset ring-[var(--color-line)]" title={`${connection.marketplace.name} · ${connection.marketplace.currency}`}>
                <span aria-hidden>{connection.marketplace.flag}</span> {connection.marketplace.label} · {connection.marketplace.currency}
              </span>
            )}
            <span>
              {connection.platform_name} · connected {formatShortDate(connection.created_at)}
            </span>
          </p>
        </div>
      </Link>
      <StatusPill status={connection.status} />
      <button type="button" onClick={onRemove} className="btn btn-danger-ghost btn-icon -mr-2" title="Remove this account" aria-label="Remove this account">
        {TrashIcon}
      </button>
    </li>
  );
}

function ConnectionBanner() {
  const searchParams = useSearchParams();
  const connected = searchParams.get("connected");
  const ebayError = searchParams.get("ebayError");

  if (connected === "ebay") {
    return (
      <div className="mb-4">
        <Alert variant="success">Your eBay account is connected.</Alert>
      </div>
    );
  }
  if (ebayError) {
    return (
      <div className="mb-4">
        <Alert>Couldn&apos;t connect your eBay account ({ebayError}). Try again below.</Alert>
      </div>
    );
  }
  return null;
}

// A team member never manages connections (no add/remove, no plan/billing
// context) — they only ever see the account(s) an owner granted them access
// to, as a bare list (no admin affordances at all). Deliberately no
// auto-redirect even with a single account: this page is also where
// AccountShell's "Your accounts" link and its logout live, so it must always
// be a real, working landing spot rather than something that immediately
// bounces the viewer back to wherever they came from.
function MemberAccountPicker({ user, connections }: { user: User; connections: Connection[] }) {
  const router = useRouter();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDeleteAccount() {
    setDeleting(true);
    try {
      await api.deleteAccount();
      localStorage.removeItem("token");
      router.push("/login");
    } catch {
      setError("Couldn't remove your login. Try again.");
      setConfirmDelete(false);
      setDeleting(false);
    }
  }

  return (
    <main className="min-h-screen px-6 py-10">
      <div className="mx-auto max-w-lg">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-extrabold text-[var(--color-ink)]">Your accounts</h1>
          <AccountMenu
            email={user.email}
            subtitle="Team member"
            avatarUrl={user.avatar_url}
            onLogout={() => setConfirmLogout(true)}
            onDeleteAccount={() => setConfirmDelete(true)}
          />
        </div>

        {error && (
          <div className="mb-4">
            <Alert>{error}</Alert>
          </div>
        )}

        {connections.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            You don&apos;t have access to any accounts yet. Ask whoever manages Liston for your team to grant
            you access.
          </p>
        ) : (
          <ul className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] overflow-hidden">
            {connections.map((connection) => (
              <li key={connection.id} className="border-b border-[var(--color-line)] last:border-b-0">
                <Link
                  href={landingPathForConnection(connection)}
                  className="flex items-center gap-3.5 px-5 py-4 hover:bg-[var(--color-paper)] transition-colors"
                >
                  <PlatformIcon platformKey={connection.platform_key} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-[var(--color-ink)] truncate">{connection.label}</p>
                    <p className="text-xs text-[var(--color-muted)]">{connection.platform_name}</p>
                  </div>
                  <StatusPill status={connection.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmLogout}
        title="Log out?"
        description="You'll need to log in again to access your accounts."
        confirmLabel="Log out"
        onCancel={() => setConfirmLogout(false)}
        onConfirm={() => {
          localStorage.removeItem("token");
          router.push("/login");
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Remove your login?"
        description="This removes your own team-member login. It doesn't affect the accounts or data owned by whoever gave you access."
        confirmLabel="Remove my login"
        danger
        loading={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDeleteAccount}
      />
    </main>
  );
}

export default function ConnectionsPage() {
  const router = useRouter();
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;
  const [connections, setConnections] = useState<Connection[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"logout" | "delete" | null>(null);
  const [pendingDeleteConnectionId, setPendingDeleteConnectionId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  async function loadAll() {
    try {
      const [meData, connectionsData, platformsData] = await Promise.all([api.me(), api.listConnections(), api.listPlatforms()]);
      setUser(meData.user);
      cacheUser(meData.user);
      setConnections(connectionsData.connections);
      setPlatforms(platformsData.platforms);
      setLoading(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        localStorage.removeItem("token");
        router.replace("/login");
        return;
      }
      setError("Couldn't load your connections. Try refreshing.");
      setLoading(false);
    }
  }

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/login");
      return;
    }
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  function handleLogout() {
    localStorage.removeItem("token");
    router.push("/login");
  }

  async function handleDeleteAccount() {
    setActionLoading(true);
    try {
      await api.deleteAccount();
      localStorage.removeItem("token");
      router.push("/signup");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete your account. Try again.");
      setConfirmAction(null);
      setActionLoading(false);
    }
  }

  async function handleDeleteConnection() {
    if (!pendingDeleteConnectionId) return;
    setActionLoading(true);
    try {
      await api.deleteConnection(pendingDeleteConnectionId);
      setPendingDeleteConnectionId(null);
      await loadAll();
    } catch {
      setError("Couldn't remove that connection. Try again.");
    } finally {
      setActionLoading(false);
    }
  }

  // Cold start with nothing cached: a skeleton, never a blank page.
  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-10">
        <PageSkeleton />
      </main>
    );
  }

  // Connection management (add/remove, plan limits) is an owner-only
  // concept — a member only ever sees the account(s) they were granted.
  if (user.role === "member") {
    return <MemberAccountPicker user={user} connections={connections} />;
  }

  const connectionsUsed = connections.length;
  const maxConnections = user.max_connections ?? 0;
  // Plan limits are switched off server-side for now (ENFORCE_PLAN_LIMITS);
  // the UI follows suit so the add flow is never blocked.
  const atLimit = false;
  const planName = user.plan_name ?? "Unassigned";
  const pendingDelete = connections.find((c) => c.id === pendingDeleteConnectionId);

  const sortedConnections = [...connections].sort((a, b) =>
    a.platform_name === b.platform_name ? a.label.localeCompare(b.label) : a.platform_name.localeCompare(b.platform_name)
  );
  const needsAttention = connections.filter((c) => c.status !== "active").length;
  const showAddPanel = adding || (!loading && connections.length === 0);

  return (
    <AppShell
      connectionsUsed={connectionsUsed}
      maxConnections={maxConnections}
      planName={planName}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-ink)]">Connections</h1>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">The marketplace accounts Liston can draft and publish to.</p>
          </div>
          <div className="page-header-controls">
            <AccountMenu
              email={user.email}
              subtitle={`${planName} plan`}
              avatarUrl={user.avatar_url}
              onLogout={() => setConfirmAction("logout")}
              onDeleteAccount={() => setConfirmAction("delete")}
            />
          </div>
        </div>
      }
    >
      {error && (
        <div className="notice notice-danger mb-4">
          <span className="flex-1">{error}</span>
        </div>
      )}

      <Suspense fallback={null}>
        <ConnectionBanner />
      </Suspense>

      {loading ? (
        <PageSkeleton rows={2} />
      ) : (
        <>
          {connections.length > 0 && (
            <div className="mb-3 flex max-w-3xl flex-wrap items-center justify-between gap-3">
              <p className="text-[13px] text-[var(--color-muted)]">
                <span className="font-medium text-[var(--color-ink)]">{connections.length}</span> account{connections.length === 1 ? "" : "s"} connected
                {needsAttention > 0 && (
                  <>
                    {" · "}
                    <span className="font-medium text-amber-700">{needsAttention} need{needsAttention === 1 ? "s" : ""} attention</span>
                  </>
                )}
              </p>
              {!adding && (
                <button type="button" onClick={() => setAdding(true)} className="btn btn-primary btn-sm">
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                  </svg>
                  Add account
                </button>
              )}
            </div>
          )}

          {showAddPanel && (
            <div className="mb-6 max-w-3xl">
              <AddConnectionPanel platforms={platforms} atLimit={atLimit} maxConnections={maxConnections} onCancel={connections.length > 0 ? () => setAdding(false) : undefined} />
            </div>
          )}

          {connections.length > 0 && (
            <ul className="card max-w-3xl divide-y divide-[var(--color-line)] overflow-hidden">
              {sortedConnections.map((connection) => (
                <AccountRow key={connection.id} connection={connection} onRemove={() => setPendingDeleteConnectionId(connection.id)} />
              ))}
            </ul>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmAction === "logout"}
        title="Log out?"
        description="You'll need to log in again to access your dashboard."
        confirmLabel="Log out"
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleLogout}
      />
      <ConfirmDialog
        open={confirmAction === "delete"}
        title="Delete your account?"
        description="This permanently deletes your account, connections, and listing data. This action cannot be undone."
        confirmLabel="Delete account"
        danger
        loading={actionLoading}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleDeleteAccount}
      />
      <ConfirmDialog
        open={pendingDeleteConnectionId !== null}
        title={pendingDelete ? `Remove ${pendingDelete.label}?` : "Remove this account?"}
        description="Liston will no longer be able to read orders or draft and publish listings for this account. Your live eBay listings are not affected."
        confirmLabel="Remove"
        danger
        loading={actionLoading}
        onCancel={() => setPendingDeleteConnectionId(null)}
        onConfirm={handleDeleteConnection}
      />
    </AppShell>
  );
}
