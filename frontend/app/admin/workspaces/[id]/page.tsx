"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AdminWorkspaceDetail, api, ApiError, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cacheUser, useCachedUser } from "@/lib/session";
import { Alert } from "@/components/Alert";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatDateTime, formatShortDate } from "@/lib/format";
import { timeAgo } from "@/components/team/team-shared";
import { CARD, FIGURE, NOTE, SectionHead, StatCard, StatRow, statIcon } from "@/components/StatCard";
import { AdminChip, DeleteWorkspaceDialog, StatusChip, WorkspaceFace, plural } from "@/components/admin/workspace-shared";

// One workspace, for the admin: its owner, when it joined and was let in,
// and how much it uses Liston, as counts only (its people, its eBay
// accounts by marketplace, never which accounts or anything in them; its
// orders, the work done in it and the team's time over the last 30 days,
// its inbox and chat, the files it keeps). Its actions are here: approve or
// reject while it waits, revoke or restore after, and delete.

const ICONS = {
  people: statIcon(
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0111 0" />
      <path d="M16 5.6a3.2 3.2 0 010 5.8M17.5 14a5.5 5.5 0 013 5" />
    </>,
  ),
  accounts: statIcon(
    <>
      <path d="M4 8.5h16l-1.2 10a1.5 1.5 0 01-1.5 1.3H6.7a1.5 1.5 0 01-1.5-1.3L4 8.5z" />
      <path d="M8.5 8.5V7a3.5 3.5 0 017 0v1.5" />
    </>,
  ),
  orders: statIcon(
    <>
      <path d="M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7L12 3.5z" />
      <path d="M4.8 7.9L12 12l7.2-4.1M12 12v8.3" />
    </>,
  ),
  time: statIcon(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5l3 1.5" />
    </>,
  ),
  work: statIcon(
    <>
      <path d="M5 13l4 4L19 7" />
    </>,
  ),
  inbox: statIcon(
    <>
      <path d="M4.5 6h15a1 1 0 011 1v9a1 1 0 01-1 1H10l-4.5 3.5V17h-1a1 1 0 01-1-1V7a1 1 0 011-1z" />
    </>,
  ),
  files: statIcon(
    <>
      <path d="M7 3.5h6.5L18 8v11.5a1 1 0 01-1 1H7a1 1 0 01-1-1v-15a1 1 0 011-1z" />
      <path d="M13 3.5V8h5" />
    </>,
  ),
  about: statIcon(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5M12 8h.01" />
    </>,
  ),
  danger: statIcon(
    <>
      <path d="M12 9v4M12 16.5h.01" />
      <path d="M10.3 4.2L3 17a2 2 0 001.7 3h14.6a2 2 0 001.7-3L13.7 4.2a2 2 0 00-3.4 0z" />
    </>,
  ),
};

const INK = "text-[var(--color-ink)]";

function bytesText(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function hoursText(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// A fact in the About card: its name and value.
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-[12.5px] text-[var(--color-muted)]">{label}</dt>
      <dd className="text-right text-[13px] font-medium text-[var(--color-ink)]">{children}</dd>
    </div>
  );
}

export default function WorkspaceDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;
  const [ws, setWs] = useState<AdminWorkspaceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"revoke" | "reject" | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const { workspace } = await api.adminWorkspace(id);
    setWs(workspace);
  }, [id]);

  useEffect(() => {
    // After this render, as the other pages do.
    const t = setTimeout(() => {
      Promise.all([api.me(), load()])
        .then(([me]) => {
          if (!me.user.is_admin) {
            router.replace("/dashboard");
            return;
          }
          setUser(me.user);
          cacheUser(me.user);
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401) router.replace("/login");
          else if (err instanceof ApiError && err.status === 403) router.replace("/dashboard");
          else setError(err instanceof ApiError && err.status === 404 ? "This workspace no longer exists." : "Couldn't load this workspace.");
        });
    }, 0);
    return () => clearTimeout(t);
  }, [load, router]);

  async function decide(status: "active" | "rejected") {
    if (!ws) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { user: result } = await api.decideAccessRequest(ws.id, status);
      // A waiting sign-up rejected is deleted: back to the list.
      if (result.deleted) {
        router.replace(`/admin/access?deleted=${encodeURIComponent(ws.team_name || ws.email)}`);
        return;
      }
      setNote(
        status === "active"
          ? ws.access_status === "pending"
            ? "Approved, and they've been emailed."
            : "Access restored, and they've been emailed."
          : "Access revoked: they're locked out and emailed. Everything in it is kept.",
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
        <PageSkeleton />
      </main>
    );
  }

  const reviewedLabel = ws?.access_status === "rejected" ? "Revoked" : "Approved";

  return (
    <AppShell
      connectionsUsed={Number(user.connections_used ?? 0)}
      maxConnections={user.max_connections ?? 0}
      planName={user.plan_name ?? "Unassigned"}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-1 items-start gap-3 sm:gap-4">
            <Link
              href="/admin/access"
              className="mt-[12px] flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-ink)] hover:shadow-[var(--shadow-card)]"
              aria-label="Back to Workspaces"
              title="Back to Workspaces"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]">
                <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            {ws && <WorkspaceFace id={ws.id} name={ws.team_name || ws.name} email={ws.email} size={52} />}
            <div className="min-w-0 flex-1 pt-0.5">
              <h1 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[20px] font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ink)]">
                <span className="min-w-0 truncate">{ws?.team_name || "Workspace"}</span>
                {ws && <StatusChip status={ws.access_status} />}
                {ws?.is_admin && <AdminChip />}
              </h1>
              {ws && (
                <>
                  <p className="mt-1 break-all sm:truncate sm:break-normal text-[13px] text-[var(--color-muted)]">
                    {"Owner: "}
                    <span className="font-medium text-[var(--color-ink)]">{ws.name || "No name given"}</span>
                    {` · ${ws.email}`}
                  </p>
                  <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--color-muted)]">
                    <span title={formatDateTime(ws.created_at)}>{`Created ${formatShortDate(ws.created_at)}`}</span>
                    {ws.access_reviewed_at && <span title={formatDateTime(ws.access_reviewed_at)}>{`${reviewedLabel} ${formatShortDate(ws.access_reviewed_at)}`}</span>}
                    <span>{ws.last_login_at ? `Last login ${timeAgo(ws.last_login_at)}` : "Never logged in"}</span>
                  </p>
                </>
              )}
            </div>
          </div>
          {ws && !ws.is_admin && (
            <div className="flex flex-shrink-0 items-center gap-2 max-sm:w-full max-sm:pl-11 sm:mt-2.5">
              {ws.access_status === "pending" && (
                <>
                  <button type="button" onClick={() => setConfirm("reject")} disabled={busy} className="btn btn-ghost btn-sm !h-9 text-[var(--color-danger)]">
                    Reject
                  </button>
                  <button type="button" onClick={() => decide("active")} disabled={busy} className="btn btn-primary btn-sm !h-9 !px-4">
                    {busy ? "Saving…" : "Approve"}
                  </button>
                </>
              )}
              {ws.access_status === "active" && (
                <button
                  type="button"
                  onClick={() => setConfirm("revoke")}
                  disabled={busy}
                  className="inline-flex h-9 items-center rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-4 text-[13px] font-semibold text-rose-600 transition-colors hover:border-rose-200 hover:bg-rose-50"
                >
                  Revoke access
                </button>
              )}
              {ws.access_status === "rejected" && (
                <button type="button" onClick={() => decide("active")} disabled={busy} className="btn btn-primary btn-sm !h-9 !px-4">
                  {busy ? "Restoring…" : "Restore access"}
                </button>
              )}
            </div>
          )}
        </div>
      }
    >
      <div className="max-w-6xl space-y-5 pb-6">
        {error && <Alert>{error}</Alert>}
        {note && <Alert variant="success">{note}</Alert>}

        {!ws ? (
          !error && <PageSkeleton rows={3} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="People"
                hue="indigo"
                icon={ICONS.people}
                details={
                  <>
                    <StatRow label="Co-managers" ink={INK}>
                      {ws.people.co_managers}
                    </StatRow>
                    <StatRow label="Invitations waiting" ink={INK}>
                      {ws.people.invitations}
                    </StatRow>
                    <StatRow label="Removed members" ink={INK}>
                      {ws.people.removed}
                    </StatRow>
                  </>
                }
              >
                <span className={`${FIGURE} ${INK}`}>{ws.people.members + 1}</span>
                <span className={NOTE}>{`The owner and ${plural(ws.people.members, "member")}`}</span>
              </StatCard>
              <StatCard
                label="eBay accounts"
                hue="sky"
                icon={ICONS.accounts}
                details={
                  ws.accounts.marketplaces.length ? (
                    <>
                      {ws.accounts.marketplaces.map((m) => (
                        <StatRow key={m.id} label={m.name} ink={INK}>
                          {m.accounts}
                        </StatRow>
                      ))}
                    </>
                  ) : (
                    <p className="text-[var(--color-muted)]">None linked yet.</p>
                  )
                }
              >
                <span className={`${FIGURE} ${INK}`}>{ws.accounts.total}</span>
                <span className={NOTE}>
                  {`On ${plural(ws.accounts.marketplaces.length, "marketplace")}`}
                  {ws.accounts.needsAttention ? ` · ${ws.accounts.needsAttention} to reconnect` : ""}
                </span>
              </StatCard>
              <StatCard label="Orders" hue="emerald" icon={ICONS.orders}>
                <span className={`${FIGURE} ${INK}`}>{ws.orders.last_30.toLocaleString()}</span>
                <span className={NOTE}>{`In the last 30 days · ${ws.orders.total.toLocaleString()} in Liston`}</span>
              </StatCard>
              <StatCard label="Team time" hue="amber" icon={ICONS.time} hint="Members' working time in Liston over the last 30 days">
                <span className={`${FIGURE} ${INK}`}>{hoursText(ws.time.working_minutes)}</span>
                <span className={NOTE}>{`Working, last 30 days · ${plural(ws.time.people, "member")}`}</span>
              </StatCard>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
              <StatCard
                label="Work in the last 30 days"
                hue="violet"
                icon={ICONS.work}
                details={
                  <>
                    <StatRow label="Listings published" ink={INK}>
                      {ws.work.published}
                    </StatRow>
                    <StatRow label="Drafts made" ink={INK}>
                      {ws.work.drafted}
                    </StatRow>
                    <StatRow label="Supplier orders placed" ink={INK}>
                      {ws.work.supplier_orders}
                    </StatRow>
                    <StatRow label="Orders dispatched" ink={INK}>
                      {ws.work.dispatched}
                    </StatRow>
                    <StatRow label="Products hunted" ink={INK}>
                      {ws.work.hunted}
                    </StatRow>
                    <StatRow label="Buyers answered" ink={INK}>
                      {ws.work.buyers_answered}
                    </StatRow>
                  </>
                }
              >
                <span className={`${FIGURE} ${INK}`}>{ws.work.actions.toLocaleString()}</span>
                <span className={NOTE}>{ws.work.last_active_at ? `Actions · last ${timeAgo(ws.work.last_active_at)}` : "Actions · nothing recorded yet"}</span>
              </StatCard>
              <StatCard
                label="Inbox and chat"
                hue="teal"
                icon={ICONS.inbox}
                details={
                  <>
                    <StatRow label="Buyer conversations" ink={INK}>
                      {ws.inbox.conversations.toLocaleString()}
                    </StatRow>
                    <StatRow label="Chat messages, 30 days" ink={INK}>
                      {ws.inbox.chatMessages.toLocaleString()}
                    </StatRow>
                  </>
                }
              >
                <span className={`${FIGURE} ${INK}`}>{ws.inbox.conversations.toLocaleString()}</span>
                <span className={NOTE}>eBay conversations kept in Liston</span>
              </StatCard>
              <StatCard
                label="Files"
                hue="slate"
                icon={ICONS.files}
                details={
                  <>
                    <StatRow label="Files kept" ink={INK}>
                      {ws.files.count.toLocaleString()}
                    </StatRow>
                    <StatRow label="Storage used" ink={INK}>
                      {bytesText(ws.files.bytes)}
                    </StatRow>
                  </>
                }
              >
                <span className={`${FIGURE} ${INK}`}>{bytesText(ws.files.bytes)}</span>
                <span className={NOTE}>Chat files and uploads</span>
              </StatCard>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <section className={`${CARD} p-4 sm:p-5`}>
                <SectionHead hue="slate" icon={ICONS.about} title="About" sub="The account behind the workspace" />
                <dl className="mt-3 divide-y divide-[var(--color-line)]">
                  <Fact label="Owner">{ws.name || "No name given"}</Fact>
                  <Fact label="Email">
                    <span className="break-all">{ws.email}</span>
                    <span className={`ml-2 text-[11.5px] font-semibold ${ws.email_verified_at ? "text-emerald-600" : "text-amber-600"}`}>{ws.email_verified_at ? "Verified" : "Not verified"}</span>
                  </Fact>
                  <Fact label="Plan">{ws.plan_name || "None"}</Fact>
                  <Fact label="Created">{formatDateTime(ws.created_at)}</Fact>
                  <Fact label={ws.access_status === "pending" ? "Access" : reviewedLabel}>
                    {ws.access_status === "pending" ? "Waiting for approval" : ws.access_reviewed_at ? formatDateTime(ws.access_reviewed_at) : "At sign-up"}
                  </Fact>
                  <Fact label="Owner also works in">{plural(ws.other_workspaces, "other workspace")}</Fact>
                </dl>
              </section>

              {ws.is_admin ? (
                <section className={`${CARD} p-4 sm:p-5`}>
                  <SectionHead hue="slate" icon={ICONS.danger} title="An admin's workspace" sub="Admins' accounts can't be revoked or deleted from here." />
                </section>
              ) : (
                <section className={`${CARD} border-rose-200 p-4 sm:p-5`}>
                  <SectionHead hue="rose" icon={ICONS.danger} title="Delete this workspace" sub="Deletes the owner's login and everything in the workspace. It can't be undone." />
                  <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[12.5px] leading-relaxed text-[var(--color-muted)] marker:text-rose-300">
                    <li>{`${plural(ws.accounts.total, "eBay account")} and all their listings, orders and messages in Liston`}</li>
                    <li>{`${plural(ws.logins_only_here, "member login")} that ${ws.logins_only_here === 1 ? "is" : "are"} in no other workspace`}</li>
                    <li>Its chat, files and settings</li>
                  </ul>
                  <button
                    type="button"
                    onClick={() => setDeleting(true)}
                    className="mt-4 inline-flex h-9 items-center self-start rounded-full bg-rose-600 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-rose-700"
                  >
                    Delete workspace
                  </button>
                </section>
              )}
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "revoke" ? `Revoke access for ${ws?.team_name || ws?.email}?` : `Reject ${ws?.team_name || ws?.email}?`}
        description={
          confirm === "revoke"
            ? "Everyone in it is locked out at once, and the owner is emailed. Its accounts, listings and data are kept, and you can restore access here."
            : "They're emailed that access isn't available, and their sign-up is deleted. They can sign up again later."
        }
        confirmLabel={confirm === "revoke" ? "Revoke access" : "Reject"}
        danger
        loading={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          await decide("rejected");
        }}
      />
      <DeleteWorkspaceDialog
        key={deleting ? "open" : "closed"}
        account={
          deleting && ws
            ? {
                id: ws.id,
                email: ws.email,
                name: ws.name,
                team_name: ws.team_name,
                accounts: ws.accounts.total,
                logins_only_here: ws.logins_only_here,
                other_workspaces: ws.other_workspaces,
              }
            : null
        }
        onCancel={() => setDeleting(false)}
        onDeleted={() => router.replace(`/admin/access?deleted=${encodeURIComponent(ws?.team_name || ws?.email || "The workspace")}`)}
      />
    </AppShell>
  );
}
