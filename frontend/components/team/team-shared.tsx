"use client";

// The pieces the Team page and a member's page share: who a member is
// (avatar, name), their access switches, the one-time login details, and
// changing their password.

import { useState, FormEvent } from "react";
import { api, ApiError, Connection, TeamMember, PermissionUpdate } from "@/lib/api";

export const FEATURE_LABELS: Record<string, string> = {
  orders: "Orders",
  listings: "Listings",
  analytics: "Analytics",
  inbox: "Inbox",
  campaigns: "Campaigns",
};

export function featureLabel(feature: string) {
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
export function permissionsGrid(
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

export function initials(name: string | null, email: string) {
  const parts = (name || email).trim().split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}

export const TrashIcon = (
  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// A capsule switch. `inherited` draws it softer so a per-account cell that
// is only following the default reads differently from a deliberate choice.
export function Switch({ on, disabled, inherited, onChange, label }: { on: boolean; disabled?: boolean; inherited?: boolean; onChange: () => void; label: string }) {
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

export function CopyButton({ value }: { value: string }) {
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
export function LoginDetails({ email, password, onDismiss }: { email: string; password: string; onDismiss: () => void }) {
  const loginUrl = typeof window !== "undefined" ? `${window.location.origin}/login` : "/login";
  const all = `Liston login\n${loginUrl}\nEmail: ${email}\nPassword: ${password}`;
  return (
    <div className="card border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-[var(--color-ink)]">Login details, ready to share</p>
          <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">The password is shown only this once. If it&apos;s lost, set a new one from the member&apos;s page.</p>
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

export function ResetPasswordDialog({ member, onClose, onDone }: { member: TeamMember | null; onClose: () => void; onDone: (email: string, password: string) => void }) {
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
          Passwords are stored scrambled, so the current one can&apos;t be shown. Set a new one here. It replaces the old one straight away and you&apos;ll see it once, to pass on.
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


/** A member's initials in a circle; greyed once they've been removed. */
export function MemberAvatar({ member, size = 40 }: { member: Pick<TeamMember, "name" | "email" | "deactivated_at">; size?: number }) {
  return (
    <span
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      className={`flex flex-shrink-0 items-center justify-center rounded-full font-semibold ${
        member.deactivated_at ? "bg-[var(--color-paper)] text-[var(--color-muted)]" : "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
      }`}
    >
      {initials(member.name, member.email)}
    </span>
  );
}

/** "just now", "12 min ago", "3 h ago", "2 days ago", else the date. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} day${Math.floor(s / 86400) === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Which areas a member can use on which eBay accounts: a default for every
 * account, and per account either following it (soft switch) or its own
 * choice. Every change saves straight away.
 */
export function AccessGrid({
  member,
  connections,
  knownFeatures,
  onChange,
}: {
  member: TeamMember;
  connections: Connection[];
  knownFeatures: string[];
  onChange: (updates: PermissionUpdate[]) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const rows = permissionsGrid(member, connections, knownFeatures);
  const globalValues = rows[0].values;

  async function setValue(connectionId: string | null, feature: string, allowed: boolean | null) {
    setSaving(true);
    try {
      await onChange([{ connectionId, feature, allowed }]);
    } finally {
      setSaving(false);
    }
  }

  if (connections.length === 0) {
    return <p className="px-5 py-4 text-[13px] text-[var(--color-muted)]">Connect an eBay account first, then choose what this member can see.</p>;
  }

  // Tailwind can't see a class built at runtime, so the template is inline.
  const cols = "grid items-center gap-3 px-5";
  const colStyle = { gridTemplateColumns: `minmax(0,1fr) repeat(${knownFeatures.length}, 92px)` };

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
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
    </div>
  );
}

/** "Orders and Listings on all accounts" / "on 3 of 9 accounts" / "No access yet". */
export function accessSummary(member: TeamMember, connections: Connection[], knownFeatures: string[]): string {
  const rows = permissionsGrid(member, connections, knownFeatures);
  const global = rows[0].values;
  const perAccount = rows.slice(1);
  const areas = knownFeatures.filter((f) => global[f] || perAccount.some((r) => r.values[f] === true));
  if (!areas.length) return "No access yet";
  const reach = perAccount.filter((r) => areas.some((f) => (r.values[f] === undefined ? global[f] : r.values[f]))).length;
  const names = areas.map(featureLabel);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `${list} · ${reach === perAccount.length ? "all accounts" : `${reach} of ${perAccount.length} accounts`}`;
}
