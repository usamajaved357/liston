"use client";

import { useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, User, Connection, TeamMember, TeamMetricKey } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cacheUser, useCachedUser } from "@/lib/session";
import { formatShortDate } from "@/lib/format";
import { LoginDetails, MemberAvatar, accessSummary, timeAgo } from "@/components/team/team-shared";

// The Team page: one compact card per member (who, what they can reach,
// when they were last active, what they've done today). A card opens the
// member's page, where their work and their access live.

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
];
function todayLine(member: TeamMember): string | null {
  const t = member.today;
  if (!t) return null;
  const parts = TODAY_WORDS.filter(([k]) => t[k] > 0).map(([k, one, many]) => `${t[k]} ${t[k] === 1 ? one : many}`);
  return parts.length ? parts.slice(0, 3).join(" · ") : null;
}

function MemberCard({ member, connections, knownFeatures }: { member: TeamMember; connections: Connection[]; knownFeatures: string[] }) {
  const removed = Boolean(member.deactivated_at);
  const today = todayLine(member);
  return (
    <Link
      href={`/team/${member.id}`}
      className={`card group flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:border-[var(--color-primary)]/40 ${removed ? "opacity-70" : ""}`}
    >
      <MemberAvatar member={member} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[14px] font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{member.name || member.email}</p>
          {removed && <span className="chip text-[10.5px] text-[var(--color-muted)]">Removed {formatShortDate(member.deactivated_at!)}</span>}
        </div>
        <p className="truncate text-[12px] text-[var(--color-muted)]">{removed ? member.email : accessSummary(member, connections, knownFeatures)}</p>
        <p className="mt-1 truncate text-[11.5px] text-[var(--color-muted)]">
          {!member.lastActiveAt ? (
            `No recorded work yet · added ${formatShortDate(member.created_at)}`
          ) : (
            <>
              {today ? <span className="font-medium text-[var(--color-ink)]">Today: {today}</span> : "Nothing yet today"}
              <span aria-hidden> · </span>
              Last active {timeAgo(member.lastActiveAt)}
            </>
          )}
        </p>
      </div>
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 flex-shrink-0 text-[var(--color-muted)] transition-transform group-hover:translate-x-0.5" aria-hidden>
        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

function AddMemberForm({ onAdd, onCancel }: { onAdd: (email: string, password: string) => void; onCancel: () => void }) {
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
      await api.addTeamMember({ email, name: name || undefined, password });
      onAdd(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this team member. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Add a team member</h2>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">They get their own login. Open them once added to choose what they can see.</p>
        </div>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-icon" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <div>
          <label className="label" htmlFor="tm-name">Name</label>
          <input id="tm-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" autoComplete="off" className="input mt-1" />
        </div>
        <div>
          <label className="label" htmlFor="tm-email">Email</label>
          <input id="tm-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="off" required className="input mt-1" />
        </div>
        <div>
          <label className="label" htmlFor="tm-password">Password</label>
          <input id="tm-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" className="input mt-1" />
        </div>
      </div>
      <p className="mt-2 text-[12px] text-[var(--color-muted)]">You&apos;ll get their login details to pass on once they&apos;re added. They can change the password themselves later.</p>

      {error && (
        <div className="notice notice-danger mt-4">
          <span className="flex-1">{error}</span>
        </div>
      )}

      <div className="mt-5 flex items-center gap-2">
        <button type="submit" disabled={submitting || !email || password.length < 8} className="btn btn-primary btn-sm">
          {submitting ? "Adding…" : "Add member"}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
          Cancel
        </button>
      </div>
    </form>
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
        setError("Only the account owner can manage team members.");
        return;
      }
      setError("Couldn't load your team. Try refreshing.");
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
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Cold start with nothing cached: a skeleton, never a blank page.
  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-10">
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
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Team</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Teammates get their own login and see only what you allow. Open one to see their work and change their access.</p>
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

          {user.role === "owner" && (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-[var(--color-muted)]">
                  <span className="font-medium text-[var(--color-ink)]">{active.length}</span> team member{active.length === 1 ? "" : "s"}
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
                    onAdd={(email, password) => {
                      setAdding(false);
                      setRevealed({ email, password });
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

              {active.length === 0 ? (
                !adding && (
                  <div className="card px-6 py-12 text-center">
                    <p className="text-sm font-medium text-[var(--color-ink)]">No team members yet</p>
                    <p className="mt-1 text-[13px] text-[var(--color-muted)]">Add a teammate, then open them to pick which accounts and areas they can work in.</p>
                    <button type="button" onClick={() => setAdding(true)} className="btn btn-primary btn-sm mt-4">
                      Add your first member
                    </button>
                  </div>
                )
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {active.map((member) => (
                    <MemberCard key={member.id} member={member} connections={connections} knownFeatures={knownFeatures} />
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
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        {former.map((member) => (
                          <MemberCard key={member.id} member={member} connections={connections} knownFeatures={knownFeatures} />
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
