"use client";

import { useParams } from "next/navigation";
import { useConnection } from "@/lib/useConnection";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { AccountPageSkeleton } from "@/components/Skeleton";

export default function AccountCampaignsPage() {
  const params = useParams<{ id: string }>();
  const { connection, user, loading, error } = useConnection(params.id);

  if (loading) {
    return <AccountPageSkeleton />;
  }

  if (error || !connection || !user) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <Alert>{error || "This account connection doesn't exist, or isn't yours."}</Alert>
      </main>
    );
  }

  return (
    <AccountShell
      connectionId={connection.id}
      label={connection.label}
      platformKey={connection.platform_key}
      platformName={connection.platform_name}
      marketplace={connection.marketplace}
      status={connection.status}
      permissions={connection.permissions}
      user={user}
      header={
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Campaigns</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            {connection.label} · {connection.platform_name}
          </p>
        </div>
      }
    >
      <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-bold text-[var(--color-ink)]">Promoted listings</h2>
          <span className="rounded-full bg-[var(--color-line)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-muted)]">
            Coming soon
          </span>
        </div>
        <div className="mt-4 rounded-lg border border-dashed border-[var(--color-line)] p-8 text-center">
          <p className="text-sm text-[var(--color-muted)]">
            Promoted listings and ad spend for this account, once eBay's Marketing API is wired up.
          </p>
        </div>
      </div>
    </AccountShell>
  );
}
