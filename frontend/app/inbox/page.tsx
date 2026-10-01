"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { MemberSidebarFooter } from "@/components/MemberSidebarFooter";
import { NotificationBell } from "@/components/NotificationBell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { cacheUser, useCachedUser } from "@/lib/session";
import { InboxView } from "@/components/inbox/InboxView";

// The Inbox outside any one account: team chat, and every account's eBay
// messages. Notifications open here (?c= a conversation).
export default function InboxPage() {
  const router = useRouter();
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem("token")) {
      router.replace("/login");
      return;
    }
    api
      .me()
      .then(({ user }) => {
        setUser(user);
        cacheUser(user);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          localStorage.removeItem("token");
          router.replace("/login");
        }
      });
  }, [router]);

  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
        <PageSkeleton />
      </main>
    );
  }
  const isOwner = user.role !== "member";
  return (
    <AppShell
      connectionsUsed={Number(user.connections_used ?? 0)}
      maxConnections={user.max_connections ?? 0}
      planName={user.plan_name ?? "Unassigned"}
      role={user.role}
      isAdmin={user.is_admin}
      fill
      sidebarFooter={isOwner ? undefined : <MemberSidebarFooter user={user} onLogout={() => setConfirmLogout(true)} />}
      header={
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-ink)]">Inbox</h1>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Talk to your team.</p>
          </div>
          <NotificationBell />
        </div>
      }
    >
      <Suspense fallback={null}>
        <InboxView me={user.id} isOwner={isOwner} />
      </Suspense>
      <ConfirmDialog
        open={confirmLogout}
        title="Log out?"
        description="You'll need your email and password to come back."
        confirmLabel="Log out"
        onConfirm={() => {
          localStorage.removeItem("token");
          router.push("/login");
        }}
        onCancel={() => setConfirmLogout(false)}
      />
    </AppShell>
  );
}
