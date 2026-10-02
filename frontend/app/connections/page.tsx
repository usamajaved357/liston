"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, Connection, Platform, User } from "@/lib/api";
import { landingPathForConnection } from "@/lib/permissions";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cacheUser, useCachedUser } from "@/lib/session";
import { AccountMenu } from "@/components/AccountMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert } from "@/components/Alert";
import { AccountCards } from "@/components/AccountCards";
import { AddConnectionPanel } from "@/components/AddConnectionPanel";
import { MemberAccess } from "@/components/MemberAccess";
import { NotificationBell } from "@/components/NotificationBell";
import { MemberSidebarFooter } from "@/components/MemberSidebarFooter";
import { ebayConnectError } from "@/lib/connect-errors";

const TrashIcon = (
  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ReconnectIcon = (
  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
    <path d="M20 11a8 8 0 00-14.9-3.9M4 5v4h4M4 13a8 8 0 0014.9 3.9M20 19v-4h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// The owner's actions on a card, as icons in its corner: re-run eBay's
// consent, or remove the account.
function OwnerActions({ connection, onRemove }: { connection: Connection; onRemove: () => void }) {
  const name = `${connection.label}${connection.marketplace ? ` · ${connection.marketplace.name}` : ""}`;
  return (
    <>
      {connection.platform_key === "ebay" && (
        <button
          type="button"
          onClick={async () => {
            try {
              const { authorizeUrl } = await api.reauthorizeConnection(connection.id, "/connections");
              window.location.href = authorizeUrl;
            } catch {
              /* the card stays; nothing to undo */
            }
          }}
          className="btn btn-ghost btn-icon !h-8 !w-8 text-[var(--color-muted)] hover:text-[var(--color-primary)]"
          title={`Reconnect ${name} to eBay (same account, fresh permissions)`}
          aria-label={`Reconnect ${name} to eBay`}
        >
          {ReconnectIcon}
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="btn btn-danger-ghost btn-icon !h-8 !w-8 !text-[var(--color-muted)] hover:!text-[var(--color-danger)]"
        title={`Remove ${name} from Liston`}
        aria-label={`Remove ${name}`}
      >
        {TrashIcon}
      </button>
    </>
  );
}

function ConnectionBanner() {
  const searchParams = useSearchParams();
  const connected = searchParams.get("connected");
  const ebayError = searchParams.get("ebayError");
  const reconnected = searchParams.get("reconnected") === "1";
  // How many sites of that eBay account the new sign-in went to.
  const sites = Number(searchParams.get("sites") || 1);

  if (connected === "ebay") {
    return (
      <div className="mb-4">
        <Alert variant="success">Your eBay account is connected.</Alert>
      </div>
    );
  }
  if (reconnected) {
    return (
      <div className="mb-4">
        <Alert variant="success">
          {sites > 1
            ? `Reconnected. This eBay account is linked on ${sites} markets, and ${sites === 2 ? "both" : `all ${sites}`} have the new sign-in.`
            : "Reconnected. The account has eBay's latest permissions."}
        </Alert>
      </div>
    );
  }
  if (ebayError) {
    return (
      <div className="mb-4">
        <Alert>{ebayConnectError(ebayError, "Try again below.")}</Alert>
      </div>
    );
  }
  return null;
}

// A team member's home. They never manage connections (no add/remove, no
// plan/billing) — they see the account(s) an owner gave them, each with what
// they can do there and what's waiting for them. Deliberately no auto-redirect even with a
// single account: this is where the account sidebar's "Dashboard" link
// lands, so it must always be a real page rather than something that
// bounces the viewer back to where they came from.
function MemberHome({ user, connections, loading }: { user: User; connections: Connection[]; loading: boolean }) {
  const router = useRouter();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const first = (user.name || "").trim().split(/\s+/)[0] || null;
  const attention = connections.filter((c) => c.status !== "active").length;

  return (
    <AppShell
      connectionsUsed={0}
      maxConnections={0}
      planName=""
      role="member"
      sidebarFooter={<MemberSidebarFooter user={user} onLogout={() => setConfirmLogout(true)} />}
      header={
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-[var(--color-ink)]">{first ? `Hi, ${first}` : "Welcome back"}</h1>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
              {loading
                ? "Your workspace's accounts."
                : connections.length
                  ? `You work on ${connections.length} account${connections.length === 1 ? "" : "s"} in ${user.team?.name || "your workspace"}. Pick one to get started.`
                  : `Accounts in ${user.team?.name || "your workspace"} show here once you're given access.`}
            </p>
          </div>
          {/* Profile and Log out live in the sidebar. */}
          <div className="page-header-controls !flex-shrink-0">
            <NotificationBell />
          </div>
        </div>
      }
    >
      {loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4" aria-hidden>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card space-y-3 p-4">
              <div className="flex gap-3">
                <div className="h-10 w-10 animate-pulse rounded-lg bg-[var(--color-line)]" />
                <div className="flex-1 space-y-2 pt-1">
                  <div className="h-3.5 w-2/5 animate-pulse rounded-full bg-[var(--color-line)]" />
                  <div className="h-3 w-3/5 animate-pulse rounded-full bg-[var(--color-line)]" />
                </div>
              </div>
              <div className="h-7 w-3/4 animate-pulse rounded-full bg-[var(--color-line)]" />
            </div>
          ))}
        </div>
      ) : connections.length === 0 ? (
        <div className="card mx-auto max-w-md px-6 py-10 text-center">
          <p className="text-[14px] font-semibold text-[var(--color-ink)]">No accounts yet</p>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-muted)]">Ask whoever manages Liston for your team to give you access to an account. It shows here as soon as they do.</p>
        </div>
      ) : (
        <AccountCards
          connections={connections}
          hrefFor={landingPathForConnection}
          extraFor={(c) => <MemberAccess connection={c} />}
          summary={
            attention > 0 ? (
              <span className="font-medium text-amber-700">
                {attention} account{attention === 1 ? " needs" : "s need"} reconnecting by the workspace owner
              </span>
            ) : undefined
          }
        />
      )}

      <ConfirmDialog
        open={confirmLogout}
        title="Log out?"
        description="You'll need to log in again to access your accounts."
        confirmLabel="Log out"
        onCancel={() => setConfirmLogout(false)}
        onConfirm={() => {
          localStorage.removeItem("token");
          router.push("/login");
        }}
      />
    </AppShell>
  );
}

export default function ConnectionsPage() {
  const router = useRouter();
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;
  const [connections, setConnections] = useState<Connection[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [pendingDeleteConnectionId, setPendingDeleteConnectionId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  async function loadAll() {
    try {
      const [meData, connectionsData, platformsData] = await Promise.all([api.me(), api.listConnections(), api.listPlatforms()]);
      setUser(meData.user);
      cacheUser(meData.user);
      setConnections(connectionsData.connections);
      setPlatforms(platformsData.platforms);
      // The rail's "Connect an eBay account" opens the panel here.
      if (new URLSearchParams(window.location.search).get("add") === "1") setAdding(true);
      setLoading(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        localStorage.removeItem("token");
        router.replace("/login");
        return;
      }
      setError("Couldn't load your connections. Try refreshing.");
      setLoading(false);
    }
  }

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/login");
      return;
    }
    // Deferred a tick: the load sets state, which an effect mustn't do in its own body.
    const t = setTimeout(loadAll, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // The rail's "Connect an eBay account" while already on this page.
  useEffect(() => {
    const onAdd = () => setAdding(true);
    window.addEventListener("liston:add-account", onAdd);
    return () => window.removeEventListener("liston:add-account", onAdd);
  }, []);

  function handleLogout() {
    localStorage.removeItem("token");
    router.push("/login");
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

  // Cold start with nothing cached: a skeleton, never a blank page.
  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
        <PageSkeleton />
      </main>
    );
  }

  // Connection management (add/remove, plan limits) is an owner-only
  // concept — a member only ever sees the account(s) they were granted.
  if (user.role === "member") {
    return <MemberHome user={user} connections={connections} loading={loading} />;
  }

  const connectionsUsed = connections.length;
  const maxConnections = user.max_connections ?? 0;
  // Plan limits are switched off server-side for now (ENFORCE_PLAN_LIMITS);
  // the UI follows suit so the add flow is never blocked.
  const atLimit = false;
  const planName = user.plan_name ?? "Unassigned";
  const pendingDelete = connections.find((c) => c.id === pendingDeleteConnectionId);

  const needsAttention = connections.filter((c) => c.status !== "active").length;
  const showAddPanel = adding || (!loading && connections.length === 0);

  return (
    <AppShell
      connectionsUsed={connectionsUsed}
      maxConnections={maxConnections}
      planName={planName}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-ink)]">Marketplace</h1>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">The marketplace accounts Liston can draft and publish to.</p>
          </div>
          <div className="page-header-controls">
            <AccountMenu
              email={user.email}
              subtitle={`${planName} plan`}
              avatarUrl={user.avatar_url}
              onLogout={() => setConfirmLogout(true)}
            />
          </div>
        </div>
      }
    >
      {error && (
        <div className="notice notice-danger mb-4">
          <span className="flex-1">{error}</span>
        </div>
      )}

      <Suspense fallback={null}>
        <ConnectionBanner />
      </Suspense>

      {loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card flex gap-3 p-4">
              <div className="h-10 w-10 animate-pulse rounded-lg bg-[var(--color-line)]" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-3.5 w-2/5 animate-pulse rounded-full bg-[var(--color-line)]" />
                <div className="h-3 w-3/5 animate-pulse rounded-full bg-[var(--color-line)]" />
                <div className="h-5 w-24 animate-pulse rounded-full bg-[var(--color-line)]" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {showAddPanel && (
            <div className="mb-6 max-w-3xl">
              <AddConnectionPanel platforms={platforms} atLimit={atLimit} maxConnections={maxConnections} onCancel={connections.length > 0 ? () => setAdding(false) : undefined} />
            </div>
          )}

          {connections.length > 0 && (
            <AccountCards
              connections={connections}
              actionsFor={(c) => <OwnerActions connection={c} onRemove={() => setPendingDeleteConnectionId(c.id)} />}
              summary={
                <>
                  <span className="font-medium text-[var(--color-ink)]">{connections.length}</span> account{connections.length === 1 ? "" : "s"} connected
                  {needsAttention > 0 && (
                    <>
                      {" · "}
                      <span className="font-medium text-amber-700">{needsAttention} need{needsAttention === 1 ? "s" : ""} attention</span>
                    </>
                  )}
                </>
              }
              toolbarEnd={
                !adding && (
                  <button type="button" onClick={() => setAdding(true)} className="btn btn-primary btn-sm">
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                    </svg>
                    Add account
                  </button>
                )
              }
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmLogout}
        title="Log out?"
        description="You'll need to log in again to access your dashboard."
        confirmLabel="Log out"
        onCancel={() => setConfirmLogout(false)}
        onConfirm={handleLogout}
      />
      <ConfirmDialog
        open={pendingDeleteConnectionId !== null}
        title={pendingDelete ? `Remove ${pendingDelete.label}${pendingDelete.marketplace ? ` · ${pendingDelete.marketplace.name}` : ""}?` : "Remove this account?"}
        description="Liston will no longer be able to read orders or draft and publish listings for this account. Your live eBay listings are not affected."
        confirmLabel="Remove"
        danger
        loading={actionLoading}
        onCancel={() => setPendingDeleteConnectionId(null)}
        onConfirm={handleDeleteConnection}
      />
    </AppShell>
  );
}
