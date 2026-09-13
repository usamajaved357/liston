"use client";

import { useParams } from "next/navigation";
import { useConnection } from "@/lib/useConnection";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";

export default function AccountCampaignsPage() {
  const params = useParams<{ id: string }>();
  const { connection, loading, error } = useConnection(params.id);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--color-muted)] text-sm">Loading…</p>
      </main>
    );
  }

  if (error || !connection) {
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
      status={connection.status}
    >
      <div className="flex items-center justify-between mb-7">
        <h1 className="text-xl font-extrabold text-[var(--color-ink)]">Campaigns</h1>
      </div>

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
