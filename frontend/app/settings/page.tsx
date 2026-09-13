"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { AccountMenu } from "@/components/AccountMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert } from "@/components/Alert";

function ComingSoonCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base font-bold text-[var(--color-ink)]">{title}</h2>
        <span className="rounded-full bg-[var(--color-line)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-muted)]">
          Coming soon
        </span>
      </div>
      <div className="mt-4 rounded-lg border border-dashed border-[var(--color-line)] p-8 text-center">
        <p className="text-sm text-[var(--color-muted)]">{description}</p>
      </div>
    </div>
  );
}

export default function WorkspaceSettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<"logout" | "delete" | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/login");
      return;
    }
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          localStorage.removeItem("token");
          router.replace("/login");
          return;
        }
        setActionError("Couldn't load your settings. Try refreshing.");
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
      setActionError(err instanceof ApiError ? err.message : "Couldn't delete your account. Try again.");
      setConfirmAction(null);
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

  const connectionsUsed = Number(user.connections_used ?? 0);
  const maxConnections = user.max_connections ?? 0;
  const listingsUsed = user.listings_used_this_month ?? 0;
  const listingsIncluded = user.listings_included_per_month ?? 0;
  const planName = user.plan_name ?? "Unassigned";

  return (
    <AppShell connectionsUsed={connectionsUsed} maxConnections={maxConnections} planName={planName}>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h1 className="text-xl font-extrabold text-[var(--color-ink)]">Settings</h1>
          <p className="text-sm text-[var(--color-muted)] mt-0.5">Workspace preferences for connections and listings.</p>
        </div>
        <AccountMenu
          email={user.email}
          planName={planName}
          avatarUrl={user.avatar_url}
          onLogout={() => setConfirmAction("logout")}
          onDeleteAccount={() => setConfirmAction("delete")}
        />
      </div>

      {actionError && (
        <div className="mb-4">
          <Alert>{actionError}</Alert>
        </div>
      )}

      <div className="space-y-5">
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-[var(--color-ink)]">Plan &amp; usage</h2>
              <p className="text-sm text-[var(--color-muted)] mt-1">
                You&apos;re on the <span className="font-semibold text-[var(--color-ink)]">{planName}</span> plan —{" "}
                {connectionsUsed}/{maxConnections} connections and {listingsUsed}/{listingsIncluded} listings this
                month.
              </p>
            </div>
            <span className="flex-shrink-0 rounded-full bg-[var(--color-line)] px-3 py-1.5 text-xs font-medium text-[var(--color-muted)]">
              Upgrade — coming soon
            </span>
          </div>
        </div>

        <ComingSoonCard
          title="Listing defaults"
          description="Set a default minimum ROI threshold, pricing rules, and whether new listings publish automatically or wait for review."
        />
        <ComingSoonCard
          title="Notifications"
          description="Choose when Liston emails you — failed syncs, drafts ready for review, or connections needing re-authorization."
        />
        <ComingSoonCard
          title="Sync schedule"
          description="Control how often Liston checks tracked competitor listings for price and stock changes."
        />
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
