"use client";

import { useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, TeamMember, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { HeaderAvatar } from "@/components/AccountMenu";
import { PageSkeleton } from "@/components/PageSkeleton";
import { InfoBadge, SettingRow } from "@/components/SettingRow";
import { cacheUser, useCachedUser } from "@/lib/session";
import { homeFor, rememberTeam } from "@/lib/team";
import { initials } from "@/components/AccountRail";

// Workspace settings: its owner's alone (a co-manager or a team member is
// sent to their home). The workspace at a glance, its name (changed here),
// its people and eBay accounts with where to manage them, and deleting it:
// typing its name, everything in it going, the owner's login staying only
// if they're in another workspace.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function WorkspaceNameForm({ name, onSaved }: { name: string; onSaved: (name: string) => void }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = value.trim().length > 0 && value.trim() !== name;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!changed) return;
    setBusy(true);
    setError(null);
    try {
      const { team } = await api.renameTeam(value.trim());
      onSaved(team.name);
      setValue(team.name);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't rename the workspace. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <div className="flex gap-2">
        <input
          className="input min-w-0 flex-1"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          placeholder="Workspace name"
          maxLength={60}
          aria-label="Workspace name"
        />
        <button type="submit" disabled={!changed || busy} className="btn btn-primary flex-shrink-0">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {error ? (
        <p className="mt-1.5 text-[12.5px] text-[var(--color-danger)]">{error}</p>
      ) : saved ? (
        <p className="mt-1.5 text-[12.5px] font-medium text-emerald-700">Saved. Everyone in it now sees this name.</p>
      ) : null}
    </form>
  );
}

// Deleting the workspace: what goes, and its name typed to be sure.
function DeleteWorkspaceDialog({ name, accounts, keepsLogin, onCancel, onDeleted }: { name: string; accounts: number; keepsLogin: boolean; onCancel: () => void; onDeleted: (loginKept: boolean) => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();

  async function remove(e: FormEvent) {
    e.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { loginKept } = await api.deleteWorkspace(typed.trim());
      onDeleted(loginKept);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete the workspace. Try again.");
      setBusy(false);
    }
  }

  const goes = [
    accounts ? `Its ${plural(accounts, "eBay account")} in Liston, with their listings, drafts, orders and messages (nothing changes on eBay itself)` : "Its listings, drafts and orders in Liston",
    "Hunted products, workspace chat, shared files and everyone's activity in it",
    "The logins of members who are in no other workspace",
    keepsLogin ? "Your own login stays, for the other workspaces you're in" : "Your own login, since you're in no other workspace",
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => !busy && onCancel()}>
      <form
        onSubmit={remove}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-workspace-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl bg-[var(--color-panel)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="delete-workspace-title" className="text-lg font-semibold text-[var(--color-ink)]">{`Delete ${name}?`}</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">This can&apos;t be undone. These go for good:</p>
        <ul className="mt-3 space-y-1.5">
          {goes.map((line, i) => (
            <li key={line} className="flex items-start gap-2 text-[13px] text-[var(--color-ink)]">
              <span className={`mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${i === goes.length - 1 && keepsLogin ? "bg-emerald-500" : "bg-rose-500"}`} aria-hidden />
              {line}
            </li>
          ))}
        </ul>
        <label className="mt-5 block text-[13px] font-medium text-[var(--color-ink)]" htmlFor="delete-workspace-name">
          {`Type ${name} to confirm`}
        </label>
        <input id="delete-workspace-name" className="input mt-1.5" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus placeholder={name} />
        {error && <p className="mt-2 text-[12.5px] text-[var(--color-danger)]">{error}</p>}
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} disabled={busy} className="btn btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={!matches || busy} className="btn btn-danger">
            {busy ? "Deleting…" : "Delete workspace"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function WorkspaceSettingsPage() {
  const router = useRouter();
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [accounts, setAccounts] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem("token")) {
      router.replace("/login");
      return;
    }
    let live = true;
    // Deferred a tick: the load sets state, which an effect mustn't do in its own body.
    const t = setTimeout(async () => {
      try {
        const { user } = await api.me();
        if (!live) return;
        setUser(user);
        cacheUser(user);
        // Only the workspace's owner has its settings.
        if (user.team?.role !== "owner") {
          router.replace(homeFor(user.role));
          return;
        }
        const [team, connections] = await Promise.all([api.listTeamMembers(), api.listConnections()]);
        if (!live) return;
        setMembers(team.members);
        setAccounts(connections.connections.length);
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) {
          localStorage.removeItem("token");
          router.replace("/login");
          return;
        }
        setError("Couldn't load the workspace. Try refreshing.");
      }
    }, 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [router]);

  if (!user || !user.team) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
        <PageSkeleton />
      </main>
    );
  }

  const workspace = user.team;
  const active = (members || []).filter((m) => !m.deactivated_at);
  const coManagers = active.filter((m) => m.owner_access_at).length;
  const otherWorkspaces = (user.teams || []).filter((t) => t.id !== workspace.id).length;
  const planName = user.plan_name ?? "Unassigned";

  function onDeleted(loginKept: boolean) {
    cacheUser(null);
    rememberTeam(null);
    if (loginKept) {
      // Their other workspaces carry on: the next page opens the one they're in.
      window.location.assign(homeFor("member"));
    } else {
      localStorage.removeItem("token");
      window.location.assign("/signup");
    }
  }

  return (
    <AppShell
      connectionsUsed={Number(user.connections_used ?? 0)}
      maxConnections={user.max_connections ?? 0}
      planName={planName}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-ink)]">Workspace settings</h1>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Your workspace&apos;s name, its people and its eBay accounts.</p>
          </div>
          <div className="page-header-controls">
            <HeaderAvatar email={user.email} avatarUrl={user.avatar_url} />
          </div>
        </div>
      }
    >
      {error && (
        <div className="notice notice-danger mb-4 max-w-3xl">
          <span className="flex-1">{error}</span>
        </div>
      )}

      <div className="max-w-3xl space-y-6">
        <div className="card">
          {/* The workspace at a glance. */}
          <div className="flex flex-col gap-4 rounded-t-[var(--radius-card)] border-b border-[var(--color-line)] bg-[radial-gradient(120%_140%_at_0%_0%,var(--color-primary-soft)_0%,transparent_55%)] px-5 py-5 sm:flex-row sm:items-center">
            <span className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl bg-[var(--color-primary)] text-[22px] font-bold text-white shadow-[0_8px_20px_-8px_rgba(79,70,229,0.6)]" aria-hidden>
              {initials(workspace.name, "W")}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[17px] font-semibold tracking-tight text-[var(--color-ink)]">{workspace.name}</p>
              <p className="truncate text-[12.5px] text-[var(--color-muted)]">{`Owned by you · ${user.email}`}</p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <InfoBadge tone="indigo" icon="shield">
                  Workspace owner
                </InfoBadge>
                {accounts !== null && (
                  <InfoBadge tone="slate" icon="store">
                    {plural(accounts, "eBay account")}
                  </InfoBadge>
                )}
                {members && (
                  <InfoBadge tone="slate" icon="people">
                    {plural(active.length, "member")}
                  </InfoBadge>
                )}
                {coManagers > 0 && (
                  <InfoBadge tone="violet" icon="key">
                    {plural(coManagers, "co-manager")}
                  </InfoBadge>
                )}
              </div>
            </div>
          </div>

          <SettingRow title="Workspace name" description="What everyone in it sees at the top of Liston, on the workspace switch and in notifications.">
            <WorkspaceNameForm
              name={workspace.name}
              onSaved={(name) => {
                const next = { ...user, team: { ...workspace, name }, teams: user.teams?.map((t) => (t.id === workspace.id ? { ...t, name } : t)) };
                setUser(next);
                cacheUser(next);
              }}
            />
          </SettingRow>

          <SettingRow title="Members" description="Who works in this workspace, what each can open, and who's a co-manager.">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[13px] text-[var(--color-muted)]">
                {members ? `${plural(active.length, "member")}${coManagers ? `, ${plural(coManagers, "co-manager")}` : ""}` : "Loading…"}
              </p>
              <Link href="/team" className="btn btn-secondary btn-sm flex-shrink-0">
                Manage members
              </Link>
            </div>
          </SettingRow>

          <SettingRow title="eBay accounts" description="The marketplace accounts this workspace drafts, publishes and sells on." last>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[13px] text-[var(--color-muted)]">{accounts === null ? "Loading…" : accounts ? `${plural(accounts, "account")} connected` : "None connected yet"}</p>
              <Link href="/connections" className="btn btn-secondary btn-sm flex-shrink-0">
                Manage accounts
              </Link>
            </div>
          </SettingRow>
        </div>

        <div className="card border-rose-200">
          <SettingRow
            title="Delete workspace"
            description={`Deletes this workspace and everything in it, and the logins of members in no other workspace. ${
              otherWorkspaces ? "Your login stays for the other workspaces you're in." : "Your login goes with it, since you're in no other workspace."
            }`}
            last
          >
            <div className="flex items-center justify-between gap-4">
              <p className="text-[13px] text-[var(--color-muted)]">This can&apos;t be undone.</p>
              <button type="button" onClick={() => setDeleting(true)} className="btn btn-secondary btn-sm text-[var(--color-danger)]">
                Delete workspace
              </button>
            </div>
          </SettingRow>
        </div>
      </div>

      {deleting && <DeleteWorkspaceDialog name={workspace.name} accounts={accounts ?? 0} keepsLogin={otherWorkspaces > 0} onCancel={() => setDeleting(false)} onDeleted={onDeleted} />}
    </AppShell>
  );
}
