"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AccessRequest, AdminWorkspace, api, ApiError, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cacheUser, useCachedUser } from "@/lib/session";
import { Alert } from "@/components/Alert";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatShortDate } from "@/lib/format";
import { PillTabs } from "@/components/PillTabs";
import { timeAgo } from "@/components/team/team-shared";
import { CARD, FIGURE, NOTE, SectionHead, StatCard, statIcon } from "@/components/StatCard";
import { AdminChip, StatusChip, WorkspaceFace, plural } from "@/components/admin/workspace-shared";

// Workspaces (admins only): every business on Liston. Usage at the top;
// anyone waiting for access as a card with Approve and Reject (the
// approve/reject email's in-app twin); then every workspace in one list,
// searched by its name or its owner's name or email and filtered by status,
// each row opening the workspace's own page, where the rest of its actions
// are (revoke, restore, delete) beside how much it uses Liston.

const ICONS = {
  workspaces: statIcon(
    <>
      <path d="M4 20V8.5L12 4l8 4.5V20" />
      <path d="M9 20v-5h6v5" />
    </>,
  ),
  waiting: statIcon(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5l3 1.5" />
    </>,
  ),
  accounts: statIcon(
    <>
      <path d="M4 8.5h16l-1.2 10a1.5 1.5 0 01-1.5 1.3H6.7a1.5 1.5 0 01-1.5-1.3L4 8.5z" />
      <path d="M8.5 8.5V7a3.5 3.5 0 017 0v1.5" />
    </>,
  ),
  people: statIcon(
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0111 0" />
      <path d="M16 5.6a3.2 3.2 0 010 5.8M17.5 14a5.5 5.5 0 013 5" />
    </>,
  ),
  search: (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
      <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M13.2 13.2L17 17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
};

type Filter = "all" | "active" | "pending" | "rejected";

// Someone waiting for access: who, their workspace, what they said, and the decision.
function Applicant({ r, busy, onApprove, onReject }: { r: AccessRequest; busy: boolean; onApprove: () => void; onReject: () => void }) {
  return (
    <article className={`${CARD} p-4 sm:p-5`}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <WorkspaceFace id={r.id} name={r.team_name || r.name} email={r.email} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={`/admin/workspaces/${r.id}`} className="truncate text-[15px] font-semibold text-[var(--color-ink)] hover:text-[var(--color-primary)]">
              {r.team_name || r.name || r.email}
            </Link>
            {!r.email_verified_at && <span className="inline-flex h-5 items-center rounded-full bg-amber-50 px-2 text-[10.5px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">Email not verified</span>}
          </div>
          <p className="truncate text-[12.5px] text-[var(--color-muted)]">{[r.name, r.email].filter(Boolean).join(" · ")}</p>
          <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">{`Signed up ${timeAgo(r.created_at)}`}</p>
        </div>
        <div className="flex w-full flex-shrink-0 items-center justify-end gap-2 sm:w-auto">
          <button type="button" onClick={onReject} disabled={busy} className="btn btn-ghost btn-sm text-[var(--color-danger)]">
            Reject
          </button>
          <button type="button" onClick={onApprove} disabled={busy} className="btn btn-primary btn-sm">
            {busy ? "Saving…" : "Approve"}
          </button>
        </div>
      </div>
      <div className="mt-3.5 rounded-xl bg-[var(--color-paper)] px-4 py-3 ring-1 ring-inset ring-[var(--color-line)]">
        <p className="text-[11.5px] font-medium text-[var(--color-muted)]">About their business</p>
        <p className={`mt-1 whitespace-pre-line text-[13px] leading-relaxed ${r.access_note ? "text-[var(--color-ink)]" : "italic text-[var(--color-muted)]"}`}>{r.access_note || "No note left."}</p>
      </div>
    </article>
  );
}

// The list's columns: the workspace, three counts centred under their headings, two dates, its status.
const GRID = "md:grid md:grid-cols-[minmax(0,2.6fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.95fr)_minmax(0,0.95fr)_minmax(0,0.95fr)_minmax(0,0.85fr)_16px] md:items-center md:gap-3";

function WorkspaceRow({ w }: { w: AdminWorkspace }) {
  const lastActive = w.last_active_at && (!w.last_login_at || w.last_active_at > w.last_login_at) ? w.last_active_at : w.last_login_at;
  return (
    <Link href={`/admin/workspaces/${w.id}`} className={`group flex flex-col gap-2 px-4 py-3.5 transition-colors hover:bg-[var(--color-paper)] sm:px-5 ${GRID}`}>
      <div className="flex min-w-0 items-center gap-3">
        <WorkspaceFace id={w.id} name={w.team_name || w.name} email={w.email} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-[13.5px] font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{w.team_name || "Untitled workspace"}</p>
            {w.is_admin && <AdminChip />}
          </div>
          <p className="truncate text-[12px] text-[var(--color-muted)]">{[w.name, w.email].filter(Boolean).join(" · ")}</p>
        </div>
        <span className="md:hidden">
          <StatusChip status={w.access_status} />
        </span>
      </div>
      {/* On a phone the figures read as one line under the name. */}
      <p className="pl-[52px] text-[11.5px] text-[var(--color-muted)] md:hidden">
        {[plural(w.members, "member"), plural(w.accounts, "eBay account"), plural(w.marketplaces, "marketplace"), `created ${formatShortDate(w.created_at)}`].join(" · ")}
      </p>
      <span className="hidden text-center text-[13px] font-semibold tabular-nums text-[var(--color-ink)] md:block">{w.members}</span>
      <span className="hidden text-center text-[13px] font-semibold tabular-nums text-[var(--color-ink)] md:block">{w.accounts}</span>
      <span className="hidden text-center text-[13px] font-semibold tabular-nums text-[var(--color-ink)] md:block">{w.marketplaces}</span>
      <span className="hidden text-center text-[12.5px] text-[var(--color-muted)] md:block">{formatShortDate(w.created_at)}</span>
      <span className="hidden text-center text-[12.5px] text-[var(--color-muted)] md:block">{lastActive ? timeAgo(lastActive) : "Never"}</span>
      <span className="hidden justify-center md:flex">
        <StatusChip status={w.access_status} />
      </span>
      <svg viewBox="0 0 24 24" fill="none" className="hidden h-4 w-4 text-[var(--color-muted)] transition-transform group-hover:translate-x-0.5 md:block" aria-hidden>
        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

export default function WorkspacesPage() {
  const router = useRouter();
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState<AccessRequest | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  async function load() {
    const [list, all] = await Promise.all([api.listAccessRequests(), api.listAdminWorkspaces()]);
    setRequests(list.requests);
    setWorkspaces(all.workspaces);
  }

  useEffect(() => {
    // After this render, as the other pages do.
    const t = setTimeout(() => {
      // Back from a workspace that was deleted on its page: say so.
      const gone = new URLSearchParams(window.location.search).get("deleted");
      if (gone) window.history.replaceState(null, "", "/admin/access");
      Promise.all([api.me(), load()])
        .then(([me]) => {
          if (!me.user.is_admin) {
            router.replace("/dashboard");
            return;
          }
          setUser(me.user);
          cacheUser(me.user);
          if (gone) setNote(`${gone} was deleted.`);
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401) router.replace("/login");
          else if (err instanceof ApiError && err.status === 403) router.replace("/dashboard");
          else setError("Couldn't load the workspaces.");
        })
        .finally(() => setLoading(false));
    }, 0);
    return () => clearTimeout(t);
  }, [router]);

  async function decide(r: AccessRequest, status: "active" | "rejected") {
    setBusyId(r.id);
    setError(null);
    setNote(null);
    try {
      await api.decideAccessRequest(r.id, status);
      setNote(status === "active" ? `${r.team_name || r.email} is approved and has been emailed.` : `${r.email} was rejected and emailed; their sign-up is deleted.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that decision.");
    } finally {
      setBusyId(null);
    }
  }

  const counts = useMemo(
    () => ({
      all: workspaces.length,
      active: workspaces.filter((w) => w.access_status === "active").length,
      pending: workspaces.filter((w) => w.access_status === "pending").length,
      rejected: workspaces.filter((w) => w.access_status === "rejected").length,
    }),
    [workspaces],
  );
  const totals = useMemo(
    () => ({
      accounts: workspaces.reduce((n, w) => n + w.accounts, 0),
      withAccounts: workspaces.filter((w) => w.accounts > 0).length,
      members: workspaces.reduce((n, w) => n + w.members, 0),
    }),
    [workspaces],
  );
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return workspaces.filter((w) => (filter === "all" || w.access_status === filter) && (!q || [w.team_name, w.name, w.email].some((v) => v && v.toLowerCase().includes(q))));
  }, [workspaces, filter, search]);

  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
        <PageSkeleton />
      </main>
    );
  }

  return (
    <AppShell
      connectionsUsed={Number(user.connections_used ?? 0)}
      maxConnections={user.max_connections ?? 0}
      planName={user.plan_name ?? "Unassigned"}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Workspaces</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Every business on Liston: who&apos;s waiting to get in, who&apos;s in, and how much each one uses it.</p>
        </div>
      }
    >
      {loading ? (
        <PageSkeleton rows={3} />
      ) : (
        <div className="max-w-6xl space-y-6 pb-6">
          {error && <Alert>{error}</Alert>}
          {note && <Alert variant="success">{note}</Alert>}

          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatCard label="Workspaces" hue="indigo" icon={ICONS.workspaces}>
              <span className={`${FIGURE} text-[var(--color-ink)]`}>{counts.all}</span>
              <span className={NOTE}>{`${counts.active} active · ${counts.rejected} revoked`}</span>
            </StatCard>
            <StatCard label="Waiting" hue="amber" icon={ICONS.waiting}>
              <span className={`${FIGURE} ${counts.pending ? "text-amber-700" : "text-[var(--color-ink)]"}`}>{counts.pending}</span>
              <span className={NOTE}>{counts.pending ? "For approval, below" : "No one waiting for approval"}</span>
            </StatCard>
            <StatCard label="eBay accounts" hue="sky" icon={ICONS.accounts}>
              <span className={`${FIGURE} text-[var(--color-ink)]`}>{totals.accounts}</span>
              <span className={NOTE}>{`Linked in ${plural(totals.withAccounts, "workspace")}`}</span>
            </StatCard>
            <StatCard label="People" hue="emerald" icon={ICONS.people}>
              <span className={`${FIGURE} text-[var(--color-ink)]`}>{counts.all + totals.members}</span>
              <span className={NOTE}>{`${counts.all} owners · ${totals.members} members`}</span>
            </StatCard>
          </div>

          {requests.length > 0 && (
            <section className="space-y-3">
              <SectionHead hue="amber" icon={ICONS.waiting} title="Waiting for approval" sub="They can sign in, but use nothing until you approve them. Approving also verifies their email." />
              {requests.map((r) => (
                <Applicant key={r.id} r={r} busy={busyId === r.id} onApprove={() => decide(r, "active")} onReject={() => setConfirmReject(r)} />
              ))}
            </section>
          )}

          <section className={CARD}>
            <div className="flex flex-col gap-3 border-b border-[var(--color-line)] px-4 py-3.5 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
              <label className="relative flex min-w-0 items-center lg:w-[340px]">
                <span className="pointer-events-none absolute left-3 text-[var(--color-muted)]">{ICONS.search}</span>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by workspace, name or email"
                  aria-label="Search workspaces"
                  className="input h-10 w-full rounded-full !pl-9"
                />
              </label>
              <PillTabs
                label="Status"
                tabs={(
                  [
                    ["all", "All"],
                    ["active", "Active"],
                    ["pending", "Waiting"],
                    ["rejected", "Revoked"],
                  ] as const
                ).map(([key, label]) => ({ key, label, count: counts[key] }))}
                value={filter}
                onChange={setFilter}
              />
            </div>
            <div className={`hidden border-b border-[var(--color-line)] bg-[var(--color-paper)]/60 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-muted)] ${GRID}`}>
              <span>Workspace</span>
              <span className="text-center">Members</span>
              <span className="text-center">eBay accounts</span>
              <span className="text-center">Marketplaces</span>
              <span className="text-center">Created</span>
              <span className="text-center">Last active</span>
              <span className="text-center">Status</span>
              <span />
            </div>
            {shown.length === 0 ? (
              <p className="px-5 py-10 text-center text-[13px] text-[var(--color-muted)]">
                {workspaces.length === 0 ? "No workspaces yet." : search.trim() ? `No workspace matches "${search.trim()}".` : "None with this status."}
              </p>
            ) : (
              <div className="divide-y divide-[var(--color-line)]">
                {shown.map((w) => (
                  <WorkspaceRow key={w.id} w={w} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={confirmReject !== null}
        title={`Reject ${confirmReject?.team_name || confirmReject?.email}?`}
        description="They're emailed that access isn't available, and their sign-up is deleted. They can sign up again later."
        confirmLabel="Reject"
        danger
        loading={busyId === confirmReject?.id}
        onCancel={() => setConfirmReject(null)}
        onConfirm={async () => {
          if (!confirmReject) return;
          const r = confirmReject;
          setConfirmReject(null);
          await decide(r, "rejected");
        }}
      />
    </AppShell>
  );
}
