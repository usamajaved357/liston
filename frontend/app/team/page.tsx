"use client";

import { useEffect, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, User, Connection, TeamMember, PermissionUpdate } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cacheUser, useCachedUser } from "@/lib/session";
import { formatShortDate } from "@/lib/format";
import { ConfirmDialog } from "@/components/ConfirmDialog";

const FEATURE_LABELS: Record<string, string> = {
  orders: "Orders",
  listings: "Listings",
  inbox: "Inbox",
  campaigns: "Campaigns",
};

function featureLabel(feature: string) {
  return FEATURE_LABELS[feature] || feature;
}

// One row per (connectionId | null) — null is the member's global default,
// applied to every connection unless a specific row below overrides it.
// For the global row a missing value means "not granted" (false). For a
// per-connection row a missing value means "inherit the global default" —
// kept as `undefined`, distinct from an explicit `false` override, so the
// UI can show and clear that third state instead of the two silently
// collapsing into the same checkbox (the exact bug reported live: an old
// explicit `false` override kept beating a later global `true`).
function permissionsGrid(
  member: TeamMember,
  connections: Connection[],
  knownFeatures: string[]
): { rowLabel: string; connectionId: string | null; values: Record<string, boolean | undefined> }[] {
  const byKey = new Map<string, Record<string, boolean>>();
  for (const p of member.permissions) {
    const key = p.connection_id ?? "__global__";
    if (!byKey.has(key)) byKey.set(key, {});
    byKey.get(key)![p.feature] = p.allowed;
  }

  const globalValues = byKey.get("__global__") || {};
  const rows = [
    {
      rowLabel: "All accounts (default)",
      connectionId: null as string | null,
      values: Object.fromEntries(knownFeatures.map((f) => [f, globalValues[f] ?? false])),
    },
    ...connections.map((c) => {
      const scoped = byKey.get(c.id) || {};
      return {
        rowLabel: c.label,
        connectionId: c.id,
        values: Object.fromEntries(knownFeatures.map((f) => [f, scoped[f]])),
      };
    }),
  ];

  return rows;
}

function initials(name: string | null, email: string) {
  const parts = (name || email).trim().split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}

const TrashIcon = (
  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// A capsule switch. `inherited` draws it softer so a per-account cell that
// is only following the default reads differently from a deliberate choice.
function Switch({ on, disabled, inherited, onChange, label }: { on: boolean; disabled?: boolean; inherited?: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-[22px] w-[38px] flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${
        on ? (inherited ? "bg-[var(--color-accent)]/45" : "bg-[var(--color-accent)]") : inherited ? "bg-[var(--color-line)]" : "bg-[var(--color-line-strong)]"
      }`}
    >
      <span className={`absolute left-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : "translate-x-0"}`} />
    </button>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="btn btn-ghost btn-icon"
      title="Copy"
      aria-label="Copy"
    >
      {copied ? (
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-[var(--color-accent)]">
          <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
          <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M5 15V6a2 2 0 012-2h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

// Shown once, right after a login is created or reset — the only moment the
// password exists in plain text. It's never stored or shown again.
function LoginDetails({ email, password, onDismiss }: { email: string; password: string; onDismiss: () => void }) {
  const loginUrl = typeof window !== "undefined" ? `${window.location.origin}/login` : "/login";
  const all = `Liston login\n${loginUrl}\nEmail: ${email}\nPassword: ${password}`;
  return (
    <div className="card border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-[var(--color-ink)]">Login details — share these with them now</p>
          <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">The password is shown only this once. If it&apos;s lost, change it from the padlock on the member&apos;s card.</p>
        </div>
        <button type="button" onClick={onDismiss} className="btn btn-ghost btn-icon" aria-label="Dismiss">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="mt-4 space-y-2">
        {[
          ["Login page", loginUrl],
          ["Email", email],
          ["Password", password],
        ].map(([label, value]) => (
          <div key={label} className="flex items-center gap-3">
            <span className="w-20 flex-shrink-0 text-[12px] font-medium text-[var(--color-muted)]">{label}</span>
            <code className="min-w-0 flex-1 truncate rounded-lg bg-white px-3 py-1.5 text-[13px] text-[var(--color-ink)] ring-1 ring-inset ring-[var(--color-line)]">{value}</code>
            <CopyButton value={value} />
          </div>
        ))}
      </div>
      <div className="mt-4">
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText(all)}
          className="btn btn-accent btn-sm"
        >
          Copy all
        </button>
      </div>
    </div>
  );
}

function ResetPasswordDialog({ member, onClose, onDone }: { member: TeamMember | null; onClose: () => void; onDone: (email: string, password: string) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  if (!member) return null;

  function generate() {
    const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(14);
    crypto.getRandomValues(bytes);
    setPassword(Array.from(bytes, (b) => alphabet[b % alphabet.length]).join(""));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setTeamMemberPassword(member!.id, password);
      onDone(member!.email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset the password. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.45)] p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="card w-full max-w-md p-6">
        <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Change password for {member.name || member.email}</h2>
        <p className="mt-1 text-[13px] text-[var(--color-muted)]">
          Passwords are stored scrambled, so the current one can&apos;t be shown. Set a new one here — it replaces the old one straight away and you&apos;ll see it once, to pass on.
        </p>
        <label className="label mt-5" htmlFor="rp-password">New password</label>
        <div className="mt-1 flex items-center gap-2">
          <input
            id="rp-password"
            type={visible ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            autoFocus
            className="input"
          />
          <button type="button" onClick={() => setVisible((v) => !v)} className="btn btn-ghost btn-icon flex-shrink-0" aria-label={visible ? "Hide" : "Show"}>
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
              <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" stroke="currentColor" strokeWidth="1.8" />
              <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.8" />
              {!visible && <path d="M4 20L20 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
            </svg>
          </button>
        </div>
        <button type="button" onClick={generate} className="mt-2 text-[12.5px] font-medium text-[var(--color-accent)] hover:underline">
          Generate a strong one
        </button>
        {error && (
          <div className="notice notice-danger mt-4">
            <span className="flex-1">{error}</span>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
            Cancel
          </button>
          <button type="submit" disabled={busy || password.length < 8} className="btn btn-primary btn-sm">
            {busy ? "Saving…" : "Set password"}
          </button>
        </div>
      </form>
    </div>
  );
}

function MemberCard({
  member,
  connections,
  knownFeatures,
  onChange,
  onRemove,
  onResetPassword,
}: {
  member: TeamMember;
  connections: Connection[];
  knownFeatures: string[];
  onChange: (memberId: string, updates: PermissionUpdate[]) => Promise<void>;
  onRemove: (memberId: string) => void;
  onResetPassword: (member: TeamMember) => void;
}) {
  const [saving, setSaving] = useState(false);
  const rows = permissionsGrid(member, connections, knownFeatures);
  const globalValues = rows[0].values;
  const grantedCount = knownFeatures.filter((f) => globalValues[f]).length;

  async function setValue(connectionId: string | null, feature: string, allowed: boolean | null) {
    setSaving(true);
    try {
      await onChange(member.id, [{ connectionId, feature, allowed }]);
    } finally {
      setSaving(false);
    }
  }

  // Tailwind can't see a class built at runtime, so the template is inline.
  const cols = "grid items-center gap-3 px-5";
  const colStyle = { gridTemplateColumns: `minmax(0,1fr) repeat(${knownFeatures.length}, 92px)` };

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3.5 px-5 py-4">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-sm font-semibold text-[var(--color-primary)]">
          {initials(member.name, member.email)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-[var(--color-ink)]">{member.name || member.email}</p>
          <p className="truncate text-[12px] text-[var(--color-muted)]">
            {member.name ? `${member.email} · ` : ""}added {formatShortDate(member.created_at)}
          </p>
        </div>
        {grantedCount > 0 && <span className="chip">{`${grantedCount} of ${knownFeatures.length} areas`}</span>}
        <button type="button" onClick={() => onResetPassword(member)} className="btn btn-ghost btn-icon" title="Change password" aria-label="Change password">
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="12" cy="16" r="1.3" fill="currentColor" />
          </svg>
        </button>
        <button type="button" onClick={() => onRemove(member.id)} className="btn btn-danger-ghost btn-icon -mr-2" title="Remove this member" aria-label="Remove this member">
          {TrashIcon}
        </button>
      </div>

      {connections.length === 0 ? (
        <p className="border-t border-[var(--color-line)] px-5 py-4 text-[13px] text-[var(--color-muted)]">Connect an eBay account first, then choose what this member can see.</p>
      ) : (
        <div className="border-t border-[var(--color-line)]">
          <div className={`${cols} border-b border-[var(--color-line)] bg-[var(--color-paper)] py-2`} style={colStyle}>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Access to</span>
            {knownFeatures.map((f) => (
              <span key={f} className="text-center text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                {featureLabel(f)}
              </span>
            ))}
          </div>

          <div className="divide-y divide-[var(--color-line)]">
            {rows.map((row) => {
              const isDefault = row.connectionId === null;
              return (
                <div key={row.connectionId ?? "global"} className={`${cols} py-3`} style={colStyle}>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--color-ink)]">{isDefault ? "All accounts" : row.rowLabel}</p>
                    <p className="text-[11.5px] text-[var(--color-muted)]">{isDefault ? "Default for every account" : "Follows the default unless changed"}</p>
                  </div>
                  {knownFeatures.map((f) => {
                    if (isDefault) {
                      return (
                        <div key={f} className="flex justify-center">
                          <Switch on={row.values[f] ?? false} disabled={saving} onChange={() => setValue(null, f, !row.values[f])} label={`${featureLabel(f)} on all accounts`} />
                        </div>
                      );
                    }
                    // Undefined = following the default. Flipping it here
                    // writes an explicit override for this one account.
                    const override = row.values[f];
                    const effective = override === undefined ? globalValues[f] ?? false : override;
                    return (
                      <div key={f} className="flex items-center justify-center">
                        <Switch on={effective} inherited={override === undefined} disabled={saving} onChange={() => setValue(row.connectionId, f, !effective)} label={`${featureLabel(f)} on ${row.rowLabel}`} />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
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
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">They get their own login. You choose what they can see after they&apos;re added.</p>
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
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [revealed, setRevealed] = useState<{ email: string; password: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<TeamMember | null>(null);

  async function loadAll() {
    try {
      const [meData, connectionsData, teamData] = await Promise.all([
        api.me(),
        api.listConnections(),
        api.listTeamMembers(),
      ]);
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

  async function handlePermissionChange(memberId: string, updates: PermissionUpdate[]) {
    const { permissions } = await api.updateMemberPermissions(memberId, updates);
    setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, permissions } : m)));
  }

  async function handleRemove() {
    if (!pendingRemoveId) return;
    setRemoving(true);
    try {
      await api.removeTeamMember(pendingRemoveId);
      setMembers((prev) => prev.filter((m) => m.id !== pendingRemoveId));
      setPendingRemoveId(null);
    } catch {
      setError("Couldn't remove this team member. Try again.");
    } finally {
      setRemoving(false);
    }
  }

  // Cold start with nothing cached: a skeleton, never a blank page. Once a
  // user is known (from cache or the API) the full shell renders and the
  // page's own content shows its loading state inside it.
  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-10">
        <PageSkeleton />
      </main>
    );
  }

  const connectionsUsed = Number(user.connections_used ?? 0);
  const maxConnections = user.max_connections ?? 0;
  const planName = user.plan_name ?? "Unassigned";

  return (
    <AppShell
      connectionsUsed={connectionsUsed}
      maxConnections={maxConnections}
      planName={planName}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Team</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Teammates get their own login and see only what you allow, per eBay account.</p>
        </div>
      }
    >
      {loading ? (
        <PageSkeleton rows={2} />
      ) : (
        <>
      <div className="max-w-3xl">
        {error && (
          <div className="notice notice-danger mb-4">
            <span className="flex-1">{error}</span>
          </div>
        )}

        {user.role === "owner" && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[13px] text-[var(--color-muted)]">
                <span className="font-medium text-[var(--color-ink)]">{members.length}</span> team member{members.length === 1 ? "" : "s"}
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

            {members.length === 0 ? (
              !adding && (
                <div className="card px-6 py-12 text-center">
                  <p className="text-sm font-medium text-[var(--color-ink)]">No team members yet</p>
                  <p className="mt-1 text-[13px] text-[var(--color-muted)]">Add a teammate and pick which accounts and areas they can work in.</p>
                  <button type="button" onClick={() => setAdding(true)} className="btn btn-primary btn-sm mt-4">
                    Add your first member
                  </button>
                </div>
              )
            ) : (
              <div className="space-y-4">
                {members.map((member) => (
                  <MemberCard
                    key={member.id}
                    member={member}
                    connections={connections}
                    knownFeatures={knownFeatures}
                    onChange={handlePermissionChange}
                    onRemove={setPendingRemoveId}
                    onResetPassword={setResetTarget}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <ResetPasswordDialog
        member={resetTarget}
        onClose={() => setResetTarget(null)}
        onDone={(email, password) => {
          setResetTarget(null);
          setRevealed({ email, password });
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />

      <ConfirmDialog
        open={pendingRemoveId !== null}
        title="Remove team member?"
        description="They'll immediately lose access to every connected account."
        confirmLabel="Remove"
        danger
        loading={removing}
        onConfirm={handleRemove}
        onCancel={() => setPendingRemoveId(null)}
      />
        </>
      )}
    </AppShell>
  );
}
