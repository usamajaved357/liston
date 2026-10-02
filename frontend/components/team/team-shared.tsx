"use client";

// The pieces the Team page and a member's page share: who a member is
// (avatar, name), their access switches, the one-time login details, and
// changing their password.

import { useState, FormEvent } from "react";
import { api, ApiError, Connection, TeamMember, PermissionUpdate } from "@/lib/api";
import { formatShortDate } from "@/lib/format";

export const FEATURE_LABELS: Record<string, string> = {
  orders: "Orders",
  listings: "Listings",
  listings_publish: "Publish listings",
  analytics: "Analytics",
  inbox: "Inbox",
  campaigns: "Campaigns",
  hunting: "Hunting",
  hunting_review: "Review hunts",
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
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="card w-full max-w-md p-5 sm:p-6 max-h-[calc(100dvh-2rem)] overflow-y-auto">
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


// ---- owner access ------------------------------------------------------------------

// A key: owner access, everything the owner has.
const KEY_ICON = (
  <>
    <circle cx="7" cy="7.5" r="3.6" stroke="currentColor" strokeWidth="1.6" />
    <path d="M9.6 10.1L16.5 17M13.6 14.1l1.7-1.7M15.2 15.7l1.4-1.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </>
);

/** "Owner access" beside a member's name. */
export function OwnerAccessBadge({ size = "sm" }: { size?: "sm" | "md" }) {
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-[var(--color-primary-soft)] font-semibold text-[var(--color-primary)] ring-1 ring-inset ring-[var(--color-primary)]/20 ${
        size === "md" ? "h-6 px-2.5 text-[11.5px]" : "h-5 px-2 text-[10.5px]"
      }`}
      title="Everything the owner can see and do"
    >
      <svg viewBox="0 0 20 20" fill="none" className={size === "md" ? "h-3.5 w-3.5" : "h-3 w-3"} aria-hidden>
        {KEY_ICON}
      </svg>
      Owner access
    </span>
  );
}

/** "You" beside your own name in the team. */
export function YouBadge() {
  return <span className="inline-flex h-5 flex-shrink-0 items-center rounded-full bg-[var(--color-paper)] px-2 text-[10.5px] font-semibold text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)]">You</span>;
}

/**
 * Whether the viewer may change this member's login and access: the owner
 * anyone; someone with owner access the rest of the team, never their own
 * login or another with owner access (the owner's alone). The API says the
 * same.
 */
export function canManageMember(viewer: { id: string; owner_access?: boolean }, member: Pick<TeamMember, "id" | "owner_access_at">) {
  if (!viewer.owner_access) return true;
  return member.id !== viewer.id && !member.owner_access_at;
}

const OWNER_ACCESS_GIVES = ["Every eBay account and every area in it", "Connecting and removing eBay accounts, and every account's settings", "Adding team members and changing their access"];

/**
 * The top of a member's Access tab: owner access, everything the owner has.
 * The owner switches it on (after saying what it gives) or off; anyone else
 * sees whether they have it.
 */
export function OwnerAccessCard({ member, canChange, ownerName, onChange }: { member: TeamMember; canChange: boolean; ownerName: string; onChange: (on: boolean) => Promise<void> }) {
  const [asking, setAsking] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = Boolean(member.owner_access_at);
  const removed = Boolean(member.deactivated_at);
  const name = member.name || member.email;
  const first = member.name ? member.name.split(/\s+/)[0] : "they";

  async function apply(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
      setAsking(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`card mb-4 overflow-hidden ${on ? "border-[var(--color-primary)]/30" : ""}`}>
      <div className={`flex items-start gap-3 px-5 py-4 ${on ? "bg-[radial-gradient(120%_160%_at_0%_0%,var(--color-primary-soft)_0%,transparent_60%)]" : ""}`}>
        <span
          className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${
            on ? "bg-[var(--color-primary)] text-white ring-[var(--color-primary)]" : "bg-[var(--color-paper)] text-[var(--color-muted)] ring-[var(--color-line)]"
          }`}
          aria-hidden
        >
          <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]">
            {KEY_ICON}
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Owner access</h2>
            {on && <span className="text-[11.5px] font-medium text-[var(--color-primary)]">On since {formatShortDate(member.owner_access_at!)}</span>}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
            {canChange
              ? on
                ? `${name} sees and does everything you can, and runs the rest of the team. They can't change your login, their own, or anyone else's with owner access. Only you can take it away.`
                : `Gives ${name} everything you can see and do, and the rest of the team to run. Only you can give it or take it away, and only you manage a login that has it.`
              : on
                ? `Everything ${ownerName} can see and do, and the rest of the team to run. Only ${ownerName} can change this login or take owner access away.`
                : `Only ${ownerName} can give owner access.`}
          </p>
          {canChange && removed && !on && <p className="mt-1 text-[12px] text-[var(--color-muted)]">{`Restore ${first === "they" ? "them" : first} first to give owner access.`}</p>}
        </div>
        {canChange && (
          <span className="flex flex-shrink-0 items-center gap-2 pt-1.5">
            <span className={`hidden text-[11.5px] font-medium sm:inline ${on ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`}>{on ? "On" : "Off"}</span>
            <Switch on={on} disabled={busy || (!on && removed)} onChange={() => setAsking(!on)} label="Owner access" />
          </span>
        )}
      </div>
      {error && asking === null && <p className="border-t border-[var(--color-line)] px-5 py-2.5 text-[12.5px] text-[var(--color-danger)]">{error}</p>}

      {asking !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => !busy && setAsking(null)}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="owner-access-title" className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl bg-[var(--color-panel)] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 id="owner-access-title" className="text-lg font-semibold text-[var(--color-ink)]">
              {asking ? `Give ${name} owner access?` : `Take away ${name}'s owner access?`}
            </h2>
            {asking ? (
              <>
                <p className="mt-2 text-sm text-[var(--color-muted)]">{`From their next click, ${first} can see and do everything you can:`}</p>
                <ul className="mt-3 space-y-1.5">
                  {OWNER_ACCESS_GIVES.map((line) => (
                    <li key={line} className="flex items-start gap-2 text-[13px] text-[var(--color-ink)]">
                      <svg viewBox="0 0 20 20" fill="none" className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--color-accent)]" aria-hidden>
                        <path d="M5 10.5l3.2 3.2L15 6.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {line}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 rounded-lg bg-[var(--color-paper)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
                  They can&apos;t change your login, their own, or anyone else&apos;s with owner access, and can&apos;t give owner access to anyone. You can take it away at any time.
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-[var(--color-muted)]">{`From their next click, ${first} is back to the access set for them on this tab. They're told in Liston.`}</p>
            )}
            {error && <p className="mt-3 text-[12.5px] text-[var(--color-danger)]">{error}</p>}
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setAsking(null)} disabled={busy} className="btn btn-ghost">
                Cancel
              </button>
              <button type="button" onClick={() => apply(asking)} disabled={busy} className={`btn ${asking ? "btn-primary" : "btn-danger"}`}>
                {busy ? (asking ? "Giving…" : "Taking away…") : asking ? "Give owner access" : "Take away owner access"}
              </button>
            </div>
          </div>
        </div>
      )}
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
const FEATURE_NOTES: Record<string, string> = {
  orders: "Orders: sourcing, dispatch, refunds and cases",
  listings: "Drafting and editing listings, and changes to live ones",
  listings_publish: "Putting drafts live on eBay (with Listings)",
  analytics: "Traffic, listing health and figures",
  inbox: "Buyer messages",
  campaigns: "Promoted Listings",
  hunting: "Adding products to hunt, for review",
  hunting_review: "Approving, rejecting or sending back hunted products",
};

const FEATURE_ICON: Record<string, React.ReactNode> = {
  orders: <path d="M3.5 7L10 3.5 16.5 7v6.5L10 17l-6.5-3.5V7zM3.5 7L10 10.5 16.5 7M10 10.5V17" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  listings: <path d="M4 9.5V5a1 1 0 011-1h4.5l6.5 6.5-5.5 5.5L4 9.5zM7.3 7.3h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  listings_publish: <path d="M10 13.5V4M6.5 7.5L10 4l3.5 3.5M4 12.5v2a1.5 1.5 0 001.5 1.5h9a1.5 1.5 0 001.5-1.5v-2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  analytics: <path d="M4 16V9M8.5 16V4M13 16v-5M17 16H3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  inbox: <path d="M3.5 6A1.5 1.5 0 015 4.5h10A1.5 1.5 0 0116.5 6v8a1.5 1.5 0 01-1.5 1.5H5A1.5 1.5 0 013.5 14V6zM4 6l6 4.5L16 6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  campaigns: <path d="M4 8.5v3a1 1 0 001 1h1.5l4.5 3V4.5l-4.5 3H5a1 1 0 00-1 1zM14 7.5a3.5 3.5 0 010 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  hunting: (
    <>
      <circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="10" cy="10" r="2.3" stroke="currentColor" strokeWidth="1.6" />
    </>
  ),
  hunting_review: <path d="M10 2.8l5.8 2.2v4.6c0 3.6-2.5 6.3-5.8 7.6-3.3-1.3-5.8-4-5.8-7.6V5L10 2.8zM7.3 10.1l1.9 1.9 3.6-3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
};

/**
 * A member's access, one row per area: a switch for every account (the
 * default), and under it one pill per eBay account to switch that account
 * on or off apart from the default. A pill that differs from the default
 * carries a dot; Reset puts the area back to the default everywhere.
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
  const accounts = rows.slice(1);

  async function save(updates: PermissionUpdate[]) {
    setSaving(true);
    try {
      await onChange(updates);
    } finally {
      setSaving(false);
    }
  }

  if (connections.length === 0) {
    return <p className="px-5 py-4 text-[13px] text-[var(--color-muted)]">Connect an eBay account first, then choose what this member can see.</p>;
  }

  return (
    <div className="divide-y divide-[var(--color-line)]">
      {knownFeatures.map((f) => {
        const byDefault = Boolean(globalValues[f]);
        const perAccount = accounts.map((a) => {
          const override = a.values[f];
          return { id: a.connectionId as string, label: a.rowLabel, on: override === undefined ? byDefault : override, differs: override !== undefined && override !== byDefault };
        });
        const onCount = perAccount.filter((a) => a.on).length;
        const differing = perAccount.filter((a) => a.differs);
        const summary = onCount === 0 ? "Off" : onCount === perAccount.length ? (perAccount.length === 1 ? "On" : "Every account") : `${onCount} of ${perAccount.length} accounts`;
        return (
          <div key={f} className="px-5 py-3">
            <div className="flex items-center gap-3">
              <span
                className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${
                  onCount ? "bg-emerald-50 text-emerald-600 ring-emerald-200" : "bg-[var(--color-paper)] text-[var(--color-muted)] ring-[var(--color-line)]"
                }`}
                aria-hidden
              >
                <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
                  {FEATURE_ICON[f]}
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-[var(--color-ink)]">{featureLabel(f)}</p>
                <p className="truncate text-[11.5px] text-[var(--color-muted)]">{FEATURE_NOTES[f] || ""}</p>
              </div>
              <span className={`hidden text-[11.5px] font-medium sm:inline ${onCount ? "text-emerald-700" : "text-[var(--color-muted)]"}`}>{summary}</span>
              <Switch
                on={byDefault}
                disabled={saving}
                // The default; an account set apart keeps its own setting (and its dot).
                onChange={() => save([{ connectionId: null, feature: f, allowed: !byDefault }])}
                label={`${featureLabel(f)} on every account`}
              />
            </div>
            {perAccount.length > 1 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-11">
                {perAccount.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    disabled={saving}
                    // Flipping back to the default clears the account's own setting.
                    onClick={() => save([{ connectionId: a.id, feature: f, allowed: !a.on === byDefault ? null : !a.on }])}
                    title={a.differs ? `${a.label}: ${a.on ? "on" : "off"}, unlike the default` : `${a.label}: ${a.on ? "on" : "off"}, as the default`}
                    aria-pressed={a.on}
                    className={`inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium ring-1 ring-inset transition-colors disabled:opacity-60 ${
                      a.on ? "bg-emerald-50 text-emerald-800 ring-emerald-200 hover:bg-emerald-100" : "bg-white text-[var(--color-muted)] ring-[var(--color-line)] hover:text-[var(--color-ink)]"
                    }`}
                  >
                    <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" aria-hidden>
                      {a.on ? <path d="M5 10.5l3.2 3.2L15 6.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M6 10h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
                    </svg>
                    {a.label}
                    {a.differs && <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="differs from the default" />}
                  </button>
                ))}
                {differing.length > 0 && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => save(differing.map((a) => ({ connectionId: a.id, feature: f, allowed: null })))}
                    className="ml-1 text-[11.5px] font-semibold text-[var(--color-primary)] hover:underline disabled:opacity-60"
                  >
                    Reset
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** "Orders and Listings on all accounts" / "on 3 of 9 accounts" / "No access yet". */
export function accessSummary(member: TeamMember, connections: Connection[], knownFeatures: string[]): string {
  if (member.owner_access_at) return "Everything the owner can see and do · all accounts";
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
