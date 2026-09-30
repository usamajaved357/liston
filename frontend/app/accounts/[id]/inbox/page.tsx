"use client";

import { Suspense, useState } from "react";
import { useParams } from "next/navigation";
import { useConnection } from "@/lib/useConnection";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";
import { AccountPageSkeleton } from "@/components/Skeleton";
import { AccountInboxView } from "@/components/inbox/InboxView";

// The Inbox on an account: its eBay messages, with Inbox access (team chat
// is the Dashboard's Inbox). How fresh Liston's copy of eBay is sits in the
// header beside the bell, so the conversations get the page's height.
export default function AccountInboxPage() {
  const params = useParams<{ id: string }>();
  const { connection, user, loading, error } = useConnection(params.id);
  // The header's spot for the sync state, filled by the inbox below.
  const [syncSlot, setSyncSlot] = useState<HTMLElement | null>(null);

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

  const canSee = !connection.permissions || Boolean(connection.permissions.inbox);
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
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">{connection.label}&apos;s buyers and eBay</p>
        </div>
      }
      actions={canSee ? <span ref={setSyncSlot} className="flex items-center" /> : undefined}
    >
      {canSee ? (
        <Suspense fallback={null}>
          <AccountInboxView connectionId={connection.id} isOwner={user.role !== "member"} syncSlot={syncSlot} />
        </Suspense>
      ) : (
        <div className="card flex flex-1 items-center justify-center p-8 text-center text-[13px] text-[var(--color-muted)]">You don&apos;t have access to this account&apos;s messages. Ask the owner for Inbox access.</div>
      )}
    </AccountShell>
  );
}
