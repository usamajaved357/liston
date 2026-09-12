"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, Connection, Platform, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { AccountMenu } from "@/components/AccountMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert } from "@/components/Alert";
import { PlatformIcon } from "@/components/PlatformIcon";
import { AddConnectionPanel } from "@/components/AddConnectionPanel";

const STATUS_STYLES: Record<Connection["status"], string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  expired: "bg-amber-50 text-amber-800 border-amber-200",
  error: "bg-red-50 text-red-700 border-red-200",
  suspended: "bg-red-50 text-red-700 border-red-200",
};

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

export default function ConnectionsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<"logout" | "delete" | null>(null);
  const [pendingDeleteConnectionId, setPendingDeleteConnectionId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  async function loadAll() {
    try {
      const [meData, connectionsData, platformsData] = await Promise.all([
        api.me(),
        api.listConnections(),
        api.listPlatforms(),
      ]);
      setUser(meData.user);
      setConnections(connectionsData.connections);
      setPlatforms(platformsData.platforms);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        localStorage.removeItem("token");
        router.replace("/login");
        return;
      }
      setError("Couldn't load your connections. Try refreshing.");
    } finally {
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

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--color-muted)] text-sm">Loading…</p>
      </main>
    );
  }

  if (!user) {
    return null;
  }

  const connectionsUsed = connections.length;
  const maxConnections = user.max_connections ?? 0;
  const atLimit = connectionsUsed >= maxConnections;
  const planName = user.plan_name ?? "Unassigned";

  const sortedConnections = [...connections].sort((a, b) =>
    a.platform_name === b.platform_name ? a.label.localeCompare(b.label) : a.platform_name.localeCompare(b.platform_name)
  );

  return (
    <AppShell connectionsUsed={connectionsUsed} maxConnections={maxConnections} planName={planName}>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h1 className="text-xl font-extrabold text-[var(--color-ink)]">Connections</h1>
          <p className="text-sm text-[var(--color-muted)] mt-0.5">
            Marketplace accounts linked to Liston, per account.
          </p>
        </div>
        <AccountMenu
          email={user.email}
          planName={planName}
          avatarUrl={user.avatar_url}
          onLogout={() => setConfirmAction("logout")}
          onDeleteAccount={() => setConfirmAction("delete")}
        />
      </div>

      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      <Suspense fallback={null}>
        <ConnectionBanner />
      </Suspense>

      <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.03)] mb-7">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-line)]">
          <div>
            <span className="text-[15px] font-extrabold text-[var(--color-ink)] block">Connected accounts</span>
            <span className="text-xs text-[var(--color-muted)]">Sorted by marketplace</span>
          </div>
        </div>

        {sortedConnections.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-[var(--color-muted)]">No accounts connected yet.</p>
        ) : (
          <ul>
            {sortedConnections.map((connection) => (
              <li
                key={connection.id}
                className="flex items-center gap-3.5 px-5 py-4 border-b border-[var(--color-line)] last:border-b-0 transition-colors hover:bg-[var(--color-paper)]"
              >
                <Link href={`/accounts/${connection.id}`} className="flex items-center gap-3.5 flex-1 min-w-0">
                  <PlatformIcon platformKey={connection.platform_key} size={40} />
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[var(--color-ink)] truncate">{connection.label}</p>
                    <p className="text-xs text-[var(--color-muted)]">{connection.platform_name}</p>
                  </div>
                </Link>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-bold capitalize ${STATUS_STYLES[connection.status]}`}
                  >
                    {connection.status}
                  </span>
                  <button
                    onClick={() => setPendingDeleteConnectionId(connection.id)}
                    className="text-sm font-medium text-[var(--color-danger)] hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AddConnectionPanel platforms={platforms} atLimit={atLimit} maxConnections={maxConnections} />

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
        title="Remove this connection?"
        description="Liston will no longer be able to draft or publish listings to this account."
        confirmLabel="Remove"
        danger
        loading={actionLoading}
        onCancel={() => setPendingDeleteConnectionId(null)}
        onConfirm={handleDeleteConnection}
      />
    </AppShell>
  );
}
