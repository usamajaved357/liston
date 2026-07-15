"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, User } from "@/lib/api";
import { AccountMenu } from "@/components/AccountMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert } from "@/components/Alert";

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");
  const [confirmAction, setConfirmAction] = useState<"logout" | "delete" | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/login");
      return;
    }

    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => {
        localStorage.removeItem("token");
        router.replace("/login");
      })
      .finally(() => setLoading(false));
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

  const connectionsUsed = Number(user.connections_used ?? 0);
  const maxConnections = user.max_connections ?? 0;
  const listingsUsed = user.listings_used_this_month ?? 0;
  const listingsIncluded = user.listings_included_per_month ?? 0;
  const connectionsPct = maxConnections ? Math.min(100, (connectionsUsed / maxConnections) * 100) : 0;
  const listingsPct = listingsIncluded ? Math.min(100, (listingsUsed / listingsIncluded) * 100) : 0;

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
        <h1 className="text-2xl font-semibold text-[var(--color-ink)]">
          Welcome, {user.email}
        </h1>
        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}

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
          <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium text-[var(--color-muted)]">Plan</h2>
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-accent)]">
                {user.plan_name ?? "Unassigned"}
              </span>
            </div>
            <p className="mt-3 text-sm text-[var(--color-ink)]">
              Connected accounts: {connectionsUsed} of {maxConnections}
            </p>
            <div className="mt-2 h-1.5 w-full rounded-full bg-[var(--color-line)] overflow-hidden">
              <div
                className="h-full bg-[var(--color-accent)]"
                style={{ width: `${connectionsPct}%` }}
              />
            </div>
          </div>

          <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
            <h2 className="text-sm font-medium text-[var(--color-muted)]">Listings this month</h2>
            <p className="mt-3 text-sm text-[var(--color-ink)]">
              {listingsUsed} of {listingsIncluded} included
            </p>
            <div className="mt-2 h-1.5 w-full rounded-full bg-[var(--color-line)] overflow-hidden">
              <div
                className="h-full bg-[var(--color-accent)]"
                style={{ width: `${listingsPct}%` }}
              />
            </div>
          </div>
        </div>

        <div className="mt-8 rounded-lg border border-dashed border-[var(--color-line)] p-8 text-center">
          <p className="text-sm text-[var(--color-muted)]">
            Connections aren&apos;t built yet. This is where you&apos;ll add a store to track
            once the Connections module ships.
          </p>
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
    </main>
  );
}
