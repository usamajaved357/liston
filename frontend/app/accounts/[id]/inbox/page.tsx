"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { useConnection } from "@/lib/useConnection";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { AccountPageSkeleton } from "@/components/Skeleton";
import { InboxView } from "@/components/inbox/InboxView";

// The Inbox on an account: team chat (the whole team, every account) and
// this account's eBay messages (with Inbox access).
export default function AccountInboxPage() {
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
      fill
      header={
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Inbox</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Your team, and {connection.label}&apos;s buyers</p>
        </div>
      }
    >
      <Suspense fallback={null}>
        <InboxView me={user.id} isOwner={user.role !== "member"} connectionId={connection.id} canSeeEbay={!connection.permissions || Boolean(connection.permissions.inbox)} />
      </Suspense>
    </AccountShell>
  );
}
