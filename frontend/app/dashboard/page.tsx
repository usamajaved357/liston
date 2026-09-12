"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, Connection, Platform, User } from "@/lib/api";
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

function StatTile({
  label,
  value,
  sublabel,
  pct,
}: {
  label: string;
  value: string;
  sublabel: string;
  pct: number;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
      <h2 className="text-sm font-medium text-[var(--color-muted)]">{label}</h2>
      <p className="mt-2 text-2xl font-semibold text-[var(--color-ink)]">{value}</p>
      <p className="mt-1 text-xs text-[var(--color-muted)]">{sublabel}</p>
      <div className="mt-3 h-1.5 w-full rounded-full bg-[var(--color-line)] overflow-hidden">
        <div className="h-full rounded-full bg-[var(--color-accent)] transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ConnectionBanner() {
  const searchParams = useSearchParams();
  const connected = searchParams.get("connected");
  const ebayError = searchParams.get("ebayError");

  if (connected === "ebay") {
    return (
      <div className="mt-4">
        <Alert variant="success">Your eBay account is connected.</Alert>
      </div>
    );
  }
  if (ebayError) {
    return (
      <div className="mt-4">
        <Alert>Couldn&apos;t connect your eBay account ({ebayError}). Try again below.</Alert>
      </div>
    );
  }
  return null;
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");
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
      setError("Couldn't load your dashboard. Try refreshing.");
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

  async function handleResendVerification() {
    setResendState("sending");
    try {
      await api.resendVerification();
      setResendState("sent");
    } catch {
      setResendState("idle");
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
  const listingsUsed = user.listings_used_this_month ?? 0;
  const listingsIncluded = user.listings_included_per_month ?? 0;
  const connectionsPct = maxConnections ? Math.min(100, (connectionsUsed / maxConnections) * 100) : 0;
  const listingsPct = listingsIncluded ? Math.min(100, (listingsUsed / listingsIncluded) * 100) : 0;
  const atLimit = connectionsUsed >= maxConnections;

  return (
    <main className="min-h-screen">
      <header className="border-b border-[var(--color-line)] bg-[var(--color-panel)]">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--color-primary)] text-white text-sm font-semibold">
              L
            </div>
            <span className="font-semibold text-[var(--color-ink)]">Liston</span>
          </div>
          <AccountMenu
            onLogout={() => setConfirmAction("logout")}
            onDeleteAccount={() => setConfirmAction("delete")}
          />
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-10">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-accent)]">Dashboard</p>
            <h1 className="mt-1 text-2xl font-semibold text-[var(--color-ink)]">{user.email}</h1>
          </div>
          <span className="rounded-full bg-[var(--color-primary)]/5 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-primary)]">
            {user.plan_name ?? "Unassigned"} plan
          </span>
        </div>

        {error && (
          <div className="mt-4">
            <Alert>{error}</Alert>
          </div>
        )}

        <Suspense fallback={null}>
          <ConnectionBanner />
        </Suspense>

        {!user.email_verified_at && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm text-amber-900">
              Verify your email to secure your account.
              {resendState === "sent" && " Check your inbox for the new link."}
            </p>
            <button
              onClick={handleResendVerification}
              disabled={resendState !== "idle"}
              className="text-sm font-medium text-amber-900 underline decoration-amber-400 underline-offset-2 hover:text-amber-950 disabled:opacity-60"
            >
              {resendState === "sending"
                ? "Sending…"
                : resendState === "sent"
                  ? "Sent"
                  : "Resend verification email"}
            </button>
          </div>
        )}

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <StatTile
            label="Connected accounts"
            value={`${connectionsUsed} / ${maxConnections}`}
            sublabel="marketplace accounts linked"
            pct={connectionsPct}
          />
          <StatTile
            label="Listings this month"
            value={`${listingsUsed} / ${listingsIncluded}`}
            sublabel="included in your plan"
            pct={listingsPct}
          />
        </div>

        {connections.length > 0 && (
          <div className="mt-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
            <h2 className="text-base font-semibold text-[var(--color-ink)] mb-4">Connected accounts</h2>
            <ul className="space-y-3">
              {connections.map((connection) => (
                <li
                  key={connection.id}
                  className="flex items-center justify-between rounded-md border border-[var(--color-line)] px-4 py-3 transition-colors hover:border-[var(--color-accent)]/50"
                >
                  <Link href={`/accounts/${connection.id}`} className="flex items-center gap-3 flex-1 min-w-0">
                    <PlatformIcon platformKey={connection.platform_key} size={36} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[var(--color-ink)] truncate">{connection.label}</p>
                      <p className="text-xs text-[var(--color-muted)]">{connection.platform_name}</p>
                    </div>
                  </Link>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[connection.status]}`}
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
          </div>
        )}

        <div className="mt-8">
          <AddConnectionPanel platforms={platforms} atLimit={atLimit} maxConnections={maxConnections} />
        </div>
      </div>

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
    </main>
  );
}
