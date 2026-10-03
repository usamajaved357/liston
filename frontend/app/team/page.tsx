"use client";

import { useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, User, Connection, TeamMember, TeamMetricKey } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cacheUser, useCachedUser } from "@/lib/session";
import { formatShortDate } from "@/lib/format";
import { LoginDetails, MemberAvatar, OwnerAccessBadge, YouBadge, accessSummary, timeAgo } from "@/components/team/team-shared";
import { minutesText } from "@/components/team/time-format";
import { EmptyCard, statIcon } from "@/components/StatCard";

// The Team page: one compact card per member (who, what they can reach,
// when they were last active, what they've done today and their time in
// Liston today, working and idle, with a dot while they're in it now). A
// card opens the member's page, where their work, time and access live.
// Members with owner access are marked; someone with it sees the page as
// the owner does, their own card marked You.

// Today's figures in a line, the non-zero ones in this order.
const TODAY_WORDS: [TeamMetricKey, string, string][] = [
  ["supplier_orders", "supplier order", "supplier orders"],
  ["dispatched", "dispatched", "dispatched"],
  ["cases", "case", "cases"],
  ["published", "published", "published"],
  ["edited", "edit", "edits"],
  ["relisted", "relisted", "relisted"],
  ["ended", "ended", "ended"],
  ["drafted", "draft", "drafts"],
  ["draft_work", "draft worked on", "drafts worked on"],
  ["hunted", "product hunted", "products hunted"],
  ["hunts_reviewed", "hunt reviewed", "hunts reviewed"],
  ["inbox_answered", "buyer answered", "buyers answered"],
];
function todayParts(member: TeamMember): string[] {
  const t = member.today;
  if (!t) return [];
  return TODAY_WORDS.filter(([k]) => t[k] > 0).map(([k, one, many]) => `${t[k]} ${t[k] === 1 ? one : many}`);
}

// A small capsule on a member's card: what they've done today, their time.
function Pill({ tone = "plain", children, title }: { tone?: "plain" | "work" | "time"; children: React.ReactNode; title?: string }) {
  const look = tone === "work" ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)] ring-[var(--color-primary)]/15" : tone === "time" ? "bg-emerald-50 text-emerald-700 ring-emerald-100" : "bg-[var(--color-paper)] text-[var(--color-muted)] ring-[var(--color-line)]";
  return (
    <span title={title} className={`inline-flex max-w-full items-center gap-1 truncate whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${look}`}>
      {children}
    </span>
  );
}

function MemberCard({ member, connections, knownFeatures, me }: { member: TeamMember; connections: Connection[]; knownFeatures: string[]; me: string }) {
  const removed = Boolean(member.deactivated_at);
  const today = todayParts(member);
  const live = !removed && member.time?.inListon;
  const timed = !removed && member.time && member.time.working + member.time.idle > 0;
  return (
    <Link
      href={`/team/${member.id}`}
      className={`group relative flex min-w-0 items-start gap-3.5 rounded-[18px] border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-[var(--shadow-card)] transition-all hover:border-[var(--color-primary)]/30 hover:shadow-[0_1px_2px_rgba(15,23,42,0.04),0_14px_30px_-14px_rgba(15,23,42,0.2)] ${removed ? "opacity-70" : ""}`}
    >
      {/* Their photo, with a green dot while a Liston tab of theirs is open. */}
      <span className="relative flex-shrink-0">
        <MemberAvatar member={member} size={44} />
        {live && <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-[var(--color-panel)]" title="In Liston now" aria-label="In Liston now" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-[14.5px] font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{member.name || member.email}</p>
          {member.id === me && <YouBadge />}
          {member.owner_access_at && <OwnerAccessBadge />}
          {removed && <span className="chip text-[10.5px] text-[var(--color-muted)]">Removed {formatShortDate(member.deactivated_at!)}</span>}
        </div>
        <p className="mt-0.5 truncate text-[12px] text-[var(--color-muted)]">{removed ? member.email : accessSummary(member, connections, knownFeatures)}</p>
        <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5">
          {!member.lastActiveAt ? (
            <Pill>{`No recorded work yet · added ${formatShortDate(member.created_at)}`}</Pill>
          ) : (
            <>
              {today.length ? today.slice(0, 3).map((part) => <Pill key={part} tone="work" title="Today">{part}</Pill>) : <Pill>Nothing yet today</Pill>}
              {timed && (
                <Pill tone="time" title={member.time!.idle > 0 ? `${minutesText(member.time!.idle)} idle` : undefined}>
                  {minutesText(member.time!.working)} working today
                </Pill>
              )}
              <span className="text-[11px] text-[var(--color-muted)]">Active {timeAgo(member.lastActiveAt)}</span>
            </>
          )}
        </div>
      </div>
      <svg viewBox="0 0 24 24" fill="none" className="mt-3 h-4 w-4 flex-shrink-0 text-[var(--color-muted)] transition-transform group-hover:translate-x-0.5" aria-hidden>
        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

type Added = { email: string; name: string | null; password: string | null };

// A new email gets a login with the password typed; someone already on
// Liston (in another team, or with a team of their own) joins with their
// own login, as on Slack, so no password is needed or used for them.
function AddMemberForm({ onAdd, onCancel }: { onAdd: (added: Added) => void; onCancel: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { member, existingLogin } = await api.addTeamMember({ email, name: name || undefined, password: password || undefined });
      onAdd({ email: member.email, name: member.name, password: existingLogin ? null : password });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this member. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Add a member</h2>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Open them once added to choose what they can see.</p>
        </div>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-icon" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label className="label" htmlFor="tm-name">Name</label>
          <input id="tm-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" autoComplete="off" className="input mt-1" />
        </div>
        <div>
          <label className="label" htmlFor="tm-email">Email</label>
          <input id="tm-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="off" required className="input mt-1" />
        </div>
        <div>
          <label className="label" htmlFor="tm-password">
            Password <span className="font-normal text-[var(--color-muted)]">(new logins)</span>
          </label>
          <input id="tm-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" className="input mt-1" />
        </div>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-muted)]">
        Someone new gets a login with this password, shown to you once to pass on. Someone already on Liston, in another team, joins with the email and password they use now: leave the password blank for them.
      </p>

      {error && (
        <div className="notice notice-danger mt-4">
          <span className="flex-1">{error}</span>
        </div>
      )}

      <div className="mt-5 flex items-center gap-2">
        <button type="submit" disabled={submitting || !email || (password.length > 0 && password.length < 8)} className="btn btn-primary btn-sm">
          {submitting ? "Adding…" : "Add member"}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}

// Someone already on Liston joined with their own login: nothing to pass on.
function JoinedWithOwnLogin({ who, team, onDismiss }: { who: string; team: string; onDismiss: () => void }) {
  return (
    <div className="card flex items-start gap-3 border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] p-5">
      <svg viewBox="0 0 20 20" fill="none" className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--color-accent)]" aria-hidden>
        <path d="M5 10.5l3.2 3.2L15 6.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--color-ink)]">{`${who} joined ${team} with their own login`}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
          They already sign in to Liston, so they use the same email and password, and switch to this team from the team name at the top of their sidebar. They&apos;ve been told. Open them to choose what they can see here.
        </p>
      </div>
      <button type="button" onClick={onDismiss} className="btn btn-ghost btn-icon" aria-label="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

// The team's name as the page's title; its owner renames it here.
function TeamTitle({ name, canRename, onRenamed }: { name: string; canRename: boolean; onRenamed: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const { team } = await api.renameTeam(value.trim());
      onRenamed(team.name);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't rename the workspace. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <form onSubmit={save} className="flex flex-wrap items-center gap-2">
        <input
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
          maxLength={60}
          aria-label="Workspace name"
          className="input h-9 w-[min(320px,70vw)] text-[15px] font-semibold"
        />
        <button type="submit" disabled={saving || !value.trim() || value.trim() === name} className="btn btn-primary btn-sm">
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => setEditing(false)} className="btn btn-ghost btn-sm">
          Cancel
        </button>
        {error && <span className="w-full text-[12px] text-[var(--color-danger)]">{error}</span>}
      </form>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <h1 className="truncate text-lg font-semibold text-[var(--color-ink)]">{name}</h1>
      {canRename && (
        <button
          type="button"
          onClick={() => {
            setValue(name);
            setEditing(true);
          }}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
          aria-label="Rename the workspace"
          title="Rename the workspace"
        >
          <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
            <path d="M12.8 4.2l3 3L7.5 15.5H4.5v-3l8.3-8.3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default function TeamPage() {
  const router = useRouter();
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;
  const [connections, setConnections] = useState<Connection[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [knownFeatures, setKnownFeatures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [revealed, setRevealed] = useState<{ email: string; password: string } | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  const [showFormer, setShowFormer] = useState(false);

  async function loadAll() {
    try {
      const [meData, connectionsData, teamData] = await Promise.all([api.me(), api.listConnections(), api.listTeamMembers()]);
      setUser(meData.user);
      cacheUser(meData.user);
      setConnections(connectionsData.connections);
      setMembers(teamData.members);
      setKnownFeatures(teamData.knownFeatures);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        localStorage.removeItem("token");
        router.replace("/login");
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setError("Only the workspace owner or a co-manager can manage members.");
        return;
      }
      setError("Couldn't load the members. Try refreshing.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/login");
      return;
    }
    // After this render, as the member page does.
    const t = setTimeout(loadAll, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Cold start with nothing cached: a skeleton, never a blank page.
  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
        <PageSkeleton />
      </main>
    );
  }

  const active = members.filter((m) => !m.deactivated_at);
  const former = members.filter((m) => m.deactivated_at);

  return (
    <AppShell
      connectionsUsed={Number(user.connections_used ?? 0)}
      maxConnections={user.max_connections ?? 0}
      planName={user.plan_name ?? "Unassigned"}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div>
          <TeamTitle
            key={user.team?.name || "team"}
            name={user.team?.name || "Workspace"}
            canRename={user.role === "owner" && !user.owner_access}
            onRenamed={(teamName) => {
              const next = { ...user, team: user.team ? { ...user.team, name: teamName } : user.team, teams: user.teams?.map((t) => (t.id === user.team?.id ? { ...t, name: teamName } : t)) };
              setUser(next);
              cacheUser(next);
            }}
          />
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            {`Members get their own login and see only what ${user.owner_access ? "they're allowed" : "you allow"}. Open one to see their work and change their access.`}
          </p>
        </div>
      }
    >
      {loading ? (
        <PageSkeleton rows={2} />
      ) : (
        <div className="max-w-4xl">
          {error && (
            <div className="notice notice-danger mb-4">
              <span className="flex-1">{error}</span>
            </div>
          )}

          {user.owner_access && (
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary-soft)]/60 px-4 py-3">
              <OwnerAccessBadge size="md" />
              <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[var(--color-ink)]">
                {`${user.owner?.name || user.owner?.email || "The workspace owner"} made you a co-manager, so you run the workspace. Your own login and other co-managers' are ${user.owner?.name || "the workspace owner"}'s to change.`}
              </p>
            </div>
          )}

          {user.role === "owner" && (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-[var(--color-muted)]">
                  <span className="font-medium text-[var(--color-ink)]">{active.length}</span> member{active.length === 1 ? "" : "s"}
                </p>
                {!adding && (
                  <button type="button" onClick={() => setAdding(true)} className="btn btn-primary btn-sm">
                    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                    </svg>
                    Add member
                  </button>
                )}
              </div>

              {adding && (
                <div className="mb-6">
                  <AddMemberForm
                    onAdd={(added) => {
                      setAdding(false);
                      if (added.password) {
                        setJoined(null);
                        setRevealed({ email: added.email, password: added.password });
                      } else {
                        setRevealed(null);
                        setJoined(added.name || added.email);
                      }
                      loadAll();
                    }}
                    onCancel={() => setAdding(false)}
                  />
                </div>
              )}

              {revealed && (
                <div className="mb-6">
                  <LoginDetails email={revealed.email} password={revealed.password} onDismiss={() => setRevealed(null)} />
                </div>
              )}
              {joined && (
                <div className="mb-6">
                  <JoinedWithOwnLogin who={joined} team={user.team?.name || "your workspace"} onDismiss={() => setJoined(null)} />
                </div>
              )}

              {active.length === 0 ? (
                !adding && (
                  <EmptyCard
                    icon={statIcon(<><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0111 0" /><path d="M16 5.6a3.2 3.2 0 010 5.8M17.5 14a5.5 5.5 0 013 5" /></>, "h-6 w-6")}
                    title="No members yet"
                  >
                    <p>Add a member, then open them to pick which accounts and areas they can work in.</p>
                    <button type="button" onClick={() => setAdding(true)} className="btn btn-primary btn-sm mt-4">
                      Add your first member
                    </button>
                  </EmptyCard>
                )
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {active.map((member) => (
                    <MemberCard key={member.id} member={member} connections={connections} knownFeatures={knownFeatures} me={user.id} />
                  ))}
                </div>
              )}

              {former.length > 0 && (
                <div className="mt-8">
                  <button type="button" onClick={() => setShowFormer((v) => !v)} className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)]">
                    <svg viewBox="0 0 24 24" fill="none" className={`h-3.5 w-3.5 transition-transform ${showFormer ? "rotate-90" : ""}`} aria-hidden>
                      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Former members · {former.length}
                  </button>
                  {showFormer && (
                    <>
                      <p className="mt-1 text-[12px] text-[var(--color-muted)]">They can&apos;t log in. Their work stays on record, and they can be restored from their page.</p>
                      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                        {former.map((member) => (
                          <MemberCard key={member.id} member={member} connections={connections} knownFeatures={knownFeatures} me={user.id} />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </AppShell>
  );
}
