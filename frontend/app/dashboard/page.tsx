"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, Connection, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { AccountMenu } from "@/components/AccountMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert } from "@/components/Alert";
import { PlatformIcon } from "@/components/PlatformIcon";

const STATUS_STYLES: Record<Connection["status"], string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  expired: "bg-amber-50 text-amber-800 border-amber-200",
  error: "bg-red-50 text-red-700 border-red-200",
  suspended: "bg-red-50 text-red-700 border-red-200",
};

const RING_RADIUS = 36;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function RingStat({
  label,
  sublabel,
  value,
  pct,
}: {
  label: string;
  sublabel: string;
  value: string;
  pct: number;
}) {
  const offset = RING_CIRCUMFERENCE * (1 - pct / 100);

  return (
    <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 flex items-center gap-5">
      <div className="relative w-[84px] h-[84px] flex-shrink-0">
        <svg width="84" height="84" viewBox="0 0 84 84" className="-rotate-90">
          <circle cx="42" cy="42" r={RING_RADIUS} fill="none" stroke="var(--color-line)" strokeWidth="8" />
          <circle
            cx="42"
            cy="42"
            r={RING_RADIUS}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={offset}
            className="transition-all"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-[17px] font-extrabold text-[var(--color-ink)]">
          {value}
        </div>
      </div>
      <div>
        <span className="text-sm font-bold text-[var(--color-ink)] block">{label}</span>
        <span className="text-xs text-[var(--color-muted)] leading-relaxed block mt-1">{sublabel}</span>
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");
  const [confirmAction, setConfirmAction] = useState<"logout" | "delete" | null>(null);

  async function loadAll() {
    try {
      const [meData, connectionsData] = await Promise.all([api.me(), api.listConnections()]);
      setUser(meData.user);
      setConnections(connectionsData.connections);
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

  const [actionLoading, setActionLoading] = useState(false);

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
  const planName = user.plan_name ?? "Unassigned";

  const sortedConnections = [...connections].sort((a, b) =>
    a.platform_name === b.platform_name ? a.label.localeCompare(b.label) : a.platform_name.localeCompare(b.platform_name)
  );

  return (
    <AppShell connectionsUsed={connectionsUsed} maxConnections={maxConnections} planName={planName}>
      <div className="flex items-center justify-between mb-7">
        <h1 className="text-xl font-extrabold text-[var(--color-ink)]">Overview</h1>
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

      {!user.email_verified_at && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-900">
            Verify your email to secure your account.
            {resendState === "sent" && " Check your inbox for the new link."}
          </p>
          <button
            onClick={handleResendVerification}
            disabled={resendState !== "idle"}
            className="text-sm font-medium text-amber-900 underline decoration-amber-400 underline-offset-2 hover:text-amber-950 disabled:opacity-60"
          >
            {resendState === "sending" ? "Sending…" : resendState === "sent" ? "Sent" : "Resend verification email"}
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 mb-7">
        <RingStat
          label="Connected accounts"
          value={`${connectionsUsed}/${maxConnections}`}
          sublabel={
            atLimit
              ? "You've used all the connections your plan includes."
              : "marketplace accounts linked to Liston."
          }
          pct={connectionsPct}
        />
        <RingStat
          label="Listings this month"
          value={`${listingsUsed}/${listingsIncluded}`}
          sublabel="Included in your plan — resets each billing cycle."
          pct={listingsPct}
        />
      </div>

      <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-line)]">
          <div>
            <span className="text-[15px] font-extrabold text-[var(--color-ink)] block">Connected accounts</span>
            <span className="text-xs text-[var(--color-muted)]">Sorted by marketplace</span>
          </div>
        </div>

        {sortedConnections.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-[var(--color-muted)] mb-3">No accounts connected yet.</p>
            <Link
              href="/connections"
              className="inline-flex rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors"
            >
              Connect an account
            </Link>
          </div>
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
                <span
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-bold capitalize flex-shrink-0 ${STATUS_STYLES[connection.status]}`}
                >
                  {connection.status}
                </span>
              </li>
            ))}
          </ul>
        )}
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
    </AppShell>
  );
}
