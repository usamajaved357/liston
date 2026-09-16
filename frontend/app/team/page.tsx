"use client";

import { useEffect, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, User, Connection, TeamMember, PermissionUpdate } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { Field } from "@/components/Field";
import { Alert } from "@/components/Alert";
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

function MemberCard({
  member,
  connections,
  knownFeatures,
  onChange,
  onRemove,
}: {
  member: TeamMember;
  connections: Connection[];
  knownFeatures: string[];
  onChange: (memberId: string, updates: PermissionUpdate[]) => Promise<void>;
  onRemove: (memberId: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const rows = permissionsGrid(member, connections, knownFeatures);

  async function setValue(connectionId: string | null, feature: string, allowed: boolean | null) {
    setSaving(true);
    try {
      await onChange(member.id, [{ connectionId, feature, allowed }]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm font-bold text-[var(--color-ink)]">{member.name || member.email}</p>
          {member.name && <p className="text-xs text-[var(--color-muted)]">{member.email}</p>}
        </div>
        <button
          type="button"
          onClick={() => onRemove(member.id)}
          className="text-xs font-medium text-[var(--color-danger)] hover:underline"
        >
          Remove
        </button>
      </div>

      {connections.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          Connect an eBay account first to grant this member access to it.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <p className="text-xs text-[var(--color-muted)] mb-2">
            Per-account checkboxes follow the default above until you tick one differently — click the{" "}
            <strong>↺</strong> next to a changed box to go back to following the default.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                <th className="pb-2 pr-4">Account</th>
                {knownFeatures.map((f) => (
                  <th key={f} className="pb-2 px-3 text-center">
                    {featureLabel(f)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const globalValues = rows[0].values;
                return (
                  <tr key={row.connectionId ?? "global"} className="border-t border-[var(--color-line)]">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-ink)]">{row.rowLabel}</td>
                    {knownFeatures.map((f) => {
                      if (row.connectionId === null) {
                        return (
                          <td key={f} className="py-2.5 px-3 text-center">
                            <input
                              type="checkbox"
                              checked={row.values[f] ?? false}
                              disabled={saving}
                              onChange={() => setValue(null, f, !row.values[f])}
                              className="h-4 w-4 accent-[var(--color-accent)]"
                            />
                          </td>
                        );
                      }
                      // Undefined = following the default: the box shows and
                      // updates with whatever the default row is set to.
                      // Ticking it here creates an explicit override for
                      // just this account — the ↺ clears that override.
                      const override = row.values[f];
                      const effective = override === undefined ? globalValues[f] ?? false : override;
                      return (
                        <td key={f} className="py-2.5 px-3">
                          <div className="flex items-center justify-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={effective}
                              disabled={saving}
                              onChange={() => setValue(row.connectionId, f, !effective)}
                              className="h-4 w-4 accent-[var(--color-accent)]"
                            />
                            {override !== undefined && (
                              <button
                                type="button"
                                title="Go back to following the default"
                                disabled={saving}
                                onClick={() => setValue(row.connectionId, f, null)}
                                className="text-xs text-[var(--color-muted)] hover:text-[var(--color-ink)] disabled:opacity-60"
                              >
                                ↺
                              </button>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddMemberForm({ onAdd }: { onAdd: () => void }) {
  const [open, setOpen] = useState(false);
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
      setEmail("");
      setName("");
      setPassword("");
      setOpen(false);
      onAdd();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this team member. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors"
      >
        Add team member
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5 p-5">
      <h3 className="text-sm font-semibold text-[var(--color-ink)] mb-3">Add a team member</h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Field label="Name (optional)" type="text" value={name} onChange={setName} autoComplete="off" />
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="off" />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" />
        <p className="text-xs text-[var(--color-muted)]">
          Share this password with them directly — they&apos;ll log in at the normal login page.
        </p>
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={submitting || !email || password.length < 8}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60 transition-colors"
          >
            {submitting ? "Adding…" : "Add member"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md px-4 py-2 text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)] transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

export default function TeamPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [knownFeatures, setKnownFeatures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  async function loadAll() {
    try {
      const [meData, connectionsData, teamData] = await Promise.all([
        api.me(),
        api.listConnections(),
        api.listTeamMembers(),
      ]);
      setUser(meData.user);
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

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--color-muted)] text-sm">Loading…</p>
      </main>
    );
  }

  if (!user) {
    return null;
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
          <h1 className="text-xl font-extrabold text-[var(--color-ink)]">Team</h1>
          <p className="text-sm text-[var(--color-muted)] mt-0.5">
            Give teammates their own login with only the access they need, per eBay account.
          </p>
        </div>
      }
    >
      <div className="space-y-6 max-w-3xl">
        {error && <Alert>{error}</Alert>}

        {user.role === "owner" && (
          <>
            <AddMemberForm onAdd={loadAll} />

            {members.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">No team members yet.</p>
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
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

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
    </AppShell>
  );
}
