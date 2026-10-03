"use client";

import { useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, User, Connection, TeamMember, TeamInvite, TeamMetricKey } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cacheUser, useCachedUser } from "@/lib/session";
import { formatShortDate } from "@/lib/format";
import { CopyLinkButton, MemberAvatar, OwnerAccessBadge, SentCard, YouBadge, accessSummary, expiresText, timeAgo } from "@/components/team/team-shared";
import { minutesText } from "@/components/team/time-format";
import { EmptyCard, statIcon } from "@/components/StatCard";

// The Team page: one compact card per member (who, what they can reach,
// when they were last active, what they've done today and their time in
// Liston today, working and idle, with a dot while they're in it now). A
// card opens the member's page, where their work, time and access live.
// Members with owner access are marked; someone with it sees the page as
// the owner does, their own card marked You. People join by invitation: the
// invitations still waiting are listed above the members, and a login whose
// email was never confirmed (made before invitations) is marked so its
// email can be moved to a real one from the member's page.

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
function Pill({ tone = "plain", children, title }: { tone?: "plain" | "work" | "time" | "warn"; children: React.ReactNode; title?: string }) {
  const look =
    tone === "work"
      ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)] ring-[var(--color-primary)]/15"
      : tone === "time"
        ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
        : tone === "warn"
          ? "bg-amber-50 text-amber-700 ring-amber-200"
          : "bg-[var(--color-paper)] text-[var(--color-muted)] ring-[var(--color-line)]";
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
  // A login made before invitations: its email typed in, never proven. Only the workspace's own logins can be moved.
  const unconfirmed = !removed && !member.shared_login && member.email_confirmed === false;
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
          {member.pending_email ? (
            <Pill tone="warn" title={`Waiting for them to confirm ${member.pending_email}`}>
              Email change sent
            </Pill>
          ) : (
            unconfirmed && (
              <Pill tone="warn" title="Added before invitations: this email was typed in and never confirmed. Open them to move it to their real email.">
                Email not confirmed
              </Pill>
            )
          )}
        </div>
      </div>
      <svg viewBox="0 0 24 24" fill="none" className="mt-3 h-4 w-4 flex-shrink-0 text-[var(--color-muted)] transition-transform group-hover:translate-x-0.5" aria-hidden>
        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

// Someone joins by invitation: Liston emails them a link, someone new
// chooses their own name and password there, someone already on Liston
// joins with their login. Their access starts empty, or as a member's here.
function InviteForm({ members, onSent, onCancel }: { members: TeamMember[]; onSent: (sent: { invite: TeamInvite; emailed: boolean; again: boolean }) => void; onCancel: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [sameAs, setSameAs] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only members with access of their own to copy (a co-manager's is everything, not a setting).
  const models = members.filter((m) => !m.deactivated_at && !m.owner_access_at);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      onSent(await api.inviteMember({ email: email.trim(), name: name.trim() || undefined, sameAs: sameAs || null }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send the invitation. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-[18px] border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-[var(--shadow-card)] sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-100" aria-hidden>
            <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]">
              <path d="M3.5 6.5l6.5 4.5 6.5-4.5M4.5 5h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V6a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Invite a member</h2>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
              They get an email with a link to join. Someone new chooses their own password there; someone already on Liston joins with the login they have.
            </p>
          </div>
        </div>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-icon" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label className="label" htmlFor="inv-email">Email</label>
          <input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" autoComplete="off" required autoFocus className="input mt-1" />
        </div>
        <div>
          <label className="label" htmlFor="inv-name">
            Name <span className="font-normal text-[var(--color-muted)]">(optional)</span>
          </label>
          <input id="inv-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="They can change it" autoComplete="off" className="input mt-1" />
        </div>
        <div>
          <label className="label" htmlFor="inv-access">Access when they join</label>
          <select id="inv-access" value={sameAs} onChange={(e) => setSameAs(e.target.value)} className="input mt-1">
            <option value="">None yet, I&apos;ll choose</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{`Same as ${m.name || m.email}`}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="notice notice-danger mt-4">
          <span className="flex-1">{error}</span>
        </div>
      )}

      <div className="mt-5 flex items-center gap-2">
        <button type="submit" disabled={submitting || !email.includes("@")} className="btn btn-primary btn-sm">
          {submitting ? "Sending…" : "Send invitation"}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}

// An invitation still waiting: who, who sent it and when, when it runs out;
// its link, sending it again, or withdrawing it.
function InviteRow({ invite, onChanged }: { invite: TeamInvite; onChanged: (note: { title: string; emailed: boolean; invite: TeamInvite } | null) => void }) {
  const [busy, setBusy] = useState<"resend" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function act(kind: "resend" | "revoke") {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "resend") {
        const sent = await api.resendInvite(invite.id);
        onChanged({ title: `Invitation sent again to ${invite.name || invite.email}`, emailed: sent.emailed, invite: sent.invite });
      } else {
        await api.revokeInvite(invite.id);
        onChanged(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't do that. Try again.");
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 px-4 py-3 sm:flex-nowrap">
      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--color-line-strong)] bg-[var(--color-paper)] text-[var(--color-muted)]" aria-hidden>
        <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
          <path d="M3.5 6.5l6.5 4.5 6.5-4.5M4.5 5h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V6a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="min-w-0 flex-1 basis-[calc(100%-52px)] sm:basis-auto">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 break-all text-[13.5px] font-semibold text-[var(--color-ink)] sm:truncate sm:break-normal">{invite.name || invite.email}</p>
          {invite.existingLogin && (
            <span title="This email already has a Liston login, so they join with its password (or set a new one from the invitation)." className="inline-flex h-5 items-center rounded-full bg-teal-50 px-2 text-[10.5px] font-semibold text-teal-700 ring-1 ring-inset ring-teal-200">
              Has a Liston login
            </span>
          )}
          {invite.sameAs && <span className="inline-flex h-5 items-center truncate rounded-full bg-[var(--color-paper)] px-2 text-[10.5px] font-medium text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)]">{`Access as ${invite.sameAs.name || "a member"}`}</span>}
        </div>
        <p className="break-words text-[12px] text-[var(--color-muted)] sm:truncate">
          {invite.name ? `${invite.email} · ` : ""}
          {`Invited ${timeAgo(invite.sentAt)}${invite.invitedBy ? ` by ${invite.invitedBy}` : ""} · `}
          <span className={invite.expired ? "font-medium text-amber-700" : ""}>{expiresText(invite.expiresAt)}</span>
        </p>
        {error && <p className="mt-0.5 text-[12px] text-[var(--color-danger)]">{error}</p>}
      </div>
      <div className="ml-[52px] flex flex-shrink-0 items-center gap-1.5 sm:ml-0">
        {!invite.expired && <CopyLinkButton link={invite.link} />}
        <button
          type="button"
          onClick={() => act("resend")}
          disabled={busy !== null}
          className={`inline-flex h-7 items-center rounded-full border px-3 text-[12px] font-medium disabled:opacity-60 ${
            invite.expired ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white hover:opacity-90" : "border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-ink)] hover:border-[var(--color-primary)]/30 hover:text-[var(--color-primary)]"
          }`}
        >
          {busy === "resend" ? "Sending…" : invite.expired ? "Send again" : "Resend"}
        </button>
        <button
          type="button"
          onClick={() => act("revoke")}
          disabled={busy !== null}
          aria-label={`Withdraw the invitation to ${invite.email}`}
          title="Withdraw the invitation"
          className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-60"
        >
          <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
            <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
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
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  // The invitation just sent (or sent again): whether the email went, and its link.
  const [sent, setSent] = useState<{ title: string; emailed: boolean; invite: TeamInvite } | null>(null);
  const [showFormer, setShowFormer] = useState(false);

  async function loadAll() {
    try {
      const [meData, connectionsData, teamData, inviteData] = await Promise.all([api.me(), api.listConnections(), api.listTeamMembers(), api.listTeamInvites()]);
      setUser(meData.user);
      cacheUser(meData.user);
      setConnections(connectionsData.connections);
      setMembers(teamData.members);
      setKnownFeatures(teamData.knownFeatures);
      // Email changes show on the member's own page; here, the people still to join.
      setInvites(inviteData.invites.filter((i) => i.kind === "join"));
    } catch (err) {
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
            {`Members join by invitation with their own login, and see only what ${user.owner_access ? "they're allowed" : "you allow"}. Open one to see their work and change their access.`}
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
                    Invite member
                  </button>
                )}
              </div>

              {adding && (
                <div className="mb-6">
                  <InviteForm
                    members={members}
                    onSent={(result) => {
                      setAdding(false);
                      const who = result.invite.name || result.invite.email;
                      setSent({ title: result.again ? `Invitation sent again to ${who}` : `Invitation sent to ${who}`, emailed: result.emailed, invite: result.invite });
                      loadAll();
                    }}
                    onCancel={() => setAdding(false)}
                  />
                </div>
              )}

              {sent && (
                <div className="mb-6">
                  <SentCard title={sent.title} emailed={sent.emailed} email={sent.invite.email} link={sent.invite.link} onDismiss={() => setSent(null)} />
                </div>
              )}

              {invites.length > 0 && (
                <div className="mb-6">
                  <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--color-muted)]">{`Invited · ${invites.length}`}</p>
                  <div className="divide-y divide-[var(--color-line)] overflow-hidden rounded-[18px] border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-card)]">
                    {invites.map((invite) => (
                      <InviteRow
                        key={invite.id}
                        invite={invite}
                        onChanged={(note) => {
                          if (note) setSent(note);
                          else setInvites((list) => list.filter((i) => i.id !== invite.id));
                          loadAll();
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {active.length === 0 ? (
                !adding &&
                !invites.length && (
                  <EmptyCard
                    icon={statIcon(<><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0111 0" /><path d="M16 5.6a3.2 3.2 0 010 5.8M17.5 14a5.5 5.5 0 013 5" /></>, "h-6 w-6")}
                    title="No members yet"
                  >
                    <p>Invite someone by email. Once they join, open them to pick which accounts and areas they can work in.</p>
                    <button type="button" onClick={() => setAdding(true)} className="btn btn-primary btn-sm mt-4">
                      Invite your first member
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
