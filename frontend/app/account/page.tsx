"use client";

import { useEffect, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, User } from "@/lib/api";
import { PasswordField } from "@/components/PasswordField";
import { PasswordInput } from "@/components/PasswordInput";
import { AppShell } from "@/components/AppShell";
import { NotificationSettingsCard } from "@/components/inbox/NotificationSettingsCard";
import { MemberSidebarFooter } from "@/components/MemberSidebarFooter";
import { NotificationBell } from "@/components/NotificationBell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cacheUser, useCachedUser } from "@/lib/session";
import { AccountMenu } from "@/components/AccountMenu";
import { AvatarUploader } from "@/components/AvatarUploader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatDate } from "@/lib/format";

// Two-column settings rows: what the setting is on the left, the control on
// the right. Email isn't editable here — it's the login identity and the
// address access approval was granted to.
function SettingRow({ title, description, children, last }: { title: string; description: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`grid grid-cols-1 gap-3 px-5 py-4 md:grid-cols-[220px_minmax(0,1fr)] md:gap-6 ${last ? "" : "border-b border-[var(--color-line)]"}`}>
      <div>
        <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{title}</h2>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-muted)]">{description}</p>
      </div>
      <div className="min-w-0 max-w-md">{children}</div>
    </div>
  );
}

// Your name: what your team sees on approvals, notifications, product
// histories and the Team pages. Owners and members alike (the owner can
// also set a member's, in Team).
function NameForm({ name, onSaved }: { name: string | null; onSaved: (name: string) => void }) {
  const [value, setValue] = useState(name || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = value.trim() !== (name || "") && value.trim().length > 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!changed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateName(value.trim());
      onSaved(res.name);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save your name. Try again.");
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
          placeholder="Your name"
          maxLength={60}
          autoComplete="name"
          aria-label="Your name"
        />
        <button type="submit" disabled={!changed || busy} className="btn btn-primary flex-shrink-0">
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {error ? (
        <p className="mt-1.5 text-[12.5px] text-[var(--color-danger)]">{error}</p>
      ) : saved ? (
        <p className="mt-1.5 text-[12.5px] font-medium text-emerald-700">Saved. Your team now sees this name.</p>
      ) : (
        !name && <p className="mt-1.5 text-[12.5px] text-amber-700">Until you add it, your team sees the first part of your email instead.</p>
      )}
    </form>
  );
}

// A fact about the account at a glance: an icon, a word, a quiet tint.
const BADGE = {
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
  slate: "bg-slate-50 text-slate-600 ring-slate-200",
} as const;
const BADGE_ICON = {
  shield: <path d="M10 2.8l5.8 2.2v4.6c0 3.6-2.5 6.3-5.8 7.6-3.3-1.3-5.8-4-5.8-7.6V5L10 2.8z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  check: <path d="M10 2.5l1.9 1.4 2.3-.2.8 2.2 1.9 1.4-.7 2.2.7 2.2-1.9 1.4-.8 2.2-2.3-.2L10 17.5l-1.9-1.4-2.3.2-.8-2.2-1.9-1.4.7-2.2-.7-2.2L5 5.9l.8-2.2 2.3.2L10 2.5zM7.3 10.2l1.8 1.8 3.6-3.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  alert: <path d="M10 3l7.5 13h-15L10 3zM10 8.5v3.2M10 14.2v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  calendar: <path d="M4 6.5A1.5 1.5 0 015.5 5h9A1.5 1.5 0 0116 6.5v8a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 014 14.5v-8zM4 8.5h12M7.5 3.5v3M12.5 3.5v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  spark: <path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6L10 3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
} as const;

function Badge({ tone, icon, children }: { tone: keyof typeof BADGE; icon: keyof typeof BADGE_ICON; children: React.ReactNode }) {
  return (
    <span className={`inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-semibold ring-1 ring-inset ${BADGE[tone]}`}>
      <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
        {BADGE_ICON[icon]}
      </svg>
      {children}
    </span>
  );
}

function ChangePasswordForm({ email }: { email: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("New password must be different from your current password.");
      return;
    }

    setLoading(true);
    try {
      const { message } = await api.updatePassword(currentPassword, newPassword);
      setSuccess(message);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update your password. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} method="post" action="/account" className="space-y-3.5">
      {/* Read-only, visually hidden username so the browser's password
          manager updates the saved login for this email instead of asking
          to save a second one. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
      <div>
        <span className="mb-1 block text-[13px] font-medium text-[var(--color-ink)]">Current password</span>
        <PasswordInput name="current-password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" required />
      </div>
      <PasswordField label="New password" name="new-password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" showCriteria required />
      <PasswordField label="Confirm new password" name="confirm-password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" required />
      {error && (
        <div className="notice notice-danger">
          <span className="flex-1">{error}</span>
        </div>
      )}
      {success && (
        <div className="notice notice-success">
          <span className="flex-1">{success}</span>
        </div>
      )}
      <div className="pt-1">
        <button type="submit" disabled={loading || !currentPassword || !newPassword || !confirmPassword} className="btn btn-primary btn-sm">
          {loading ? "Updating…" : "Update password"}
        </button>
      </div>
    </form>
  );
}

export default function AccountPage() {
  const router = useRouter();
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;
  const [confirmAction, setConfirmAction] = useState<"logout" | "delete" | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/login");
      return;
    }
    // Only a refused sign-in logs out; a dropped connection or a server
    // restarting is tried again (the saved copy of the account shows meanwhile).
    let live = true;
    const load = (attempt: number) =>
      api
        .me()
        .then(({ user }) => {
          if (!live) return;
          setUser(user);
          cacheUser(user);
          setActionError(null);
        })
        .catch((err) => {
          if (!live) return;
          if (err instanceof ApiError && err.status === 401) {
            localStorage.removeItem("token");
            router.replace("/login");
            return;
          }
          if (attempt < 3) setTimeout(() => load(attempt + 1), 1500 * attempt);
          else setActionError("Couldn't reach Liston just now. Reload the page to try again.");
        });
    load(1);
    return () => {
      live = false;
    };
  }, [router]);

  function handleLogout() {
    localStorage.removeItem("token");
    router.push("/login");
  }

  async function handleDeleteAccount() {
    setActionLoading(true);
    try {
      await api.deleteAccount();
      localStorage.removeItem("token");
      router.push("/signup");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't delete your account. Try again.");
      setConfirmAction(null);
      setActionLoading(false);
    }
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
        <PageSkeleton />
      </main>
    );
  }

  const connectionsUsed = Number(user.connections_used ?? 0);
  const maxConnections = user.max_connections ?? 0;
  const planName = user.plan_name ?? "Unassigned";
  const isOwner = user.role !== "member";
  // A team where they have owner access (its owner alone removes their login).
  const coOwnerOf = user.teams?.find((t) => t.role === "owner_access") || null;

  return (
    <AppShell
      connectionsUsed={connectionsUsed}
      maxConnections={maxConnections}
      planName={planName}
      role={user.role}
      isAdmin={user.is_admin}
      // A member's Log out is at the sidebar's foot, as on their Dashboard.
      sidebarFooter={isOwner ? undefined : <MemberSidebarFooter user={user} onLogout={() => setConfirmAction("logout")} />}
      header={
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-ink)]">{isOwner ? "Account" : "Profile"}</h1>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Your login and how you appear in Liston.</p>
          </div>
          <div className="page-header-controls">
            {isOwner ? (
              <AccountMenu email={user.email} subtitle={`${planName} plan`} avatarUrl={user.avatar_url} onLogout={() => setConfirmAction("logout")} />
            ) : (
              <NotificationBell />
            )}
          </div>
        </div>
      }
    >
      {actionError && (
        <div className="notice notice-danger mb-4 max-w-3xl">
          <span className="flex-1">{actionError}</span>
        </div>
      )}

      <div className="max-w-3xl space-y-6">
        <div className="card">
          {/* Who you are here, at a glance. */}
          <div className="flex flex-col gap-4 rounded-t-[var(--radius-card)] border-b border-[var(--color-line)] bg-[radial-gradient(120%_140%_at_0%_0%,var(--color-primary-soft)_0%,transparent_55%)] px-5 py-5 sm:flex-row sm:items-center">
            <AvatarUploader avatarUrl={user.avatar_url} onChange={(avatarUrl) => setUser((u) => (u ? { ...u, avatar_url: avatarUrl } : u))} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[17px] font-semibold tracking-tight text-[var(--color-ink)]">{user.name || user.email.split("@")[0]}</p>
              <p className="truncate text-[12.5px] text-[var(--color-muted)]">{user.email}</p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <Badge tone="indigo" icon="shield">
                  {user.owner_access ? "Owner access" : isOwner ? (user.is_admin ? "Admin" : "Owner") : "Team member"}
                </Badge>
                {user.email_verified_at ? (
                  <Badge tone="emerald" icon="check">
                    Email verified
                  </Badge>
                ) : (
                  <Badge tone="amber" icon="alert">
                    Email not verified
                  </Badge>
                )}
                {isOwner && user.plan_name && (
                  <Badge tone="violet" icon="spark">
                    {user.plan_name.charAt(0).toUpperCase() + user.plan_name.slice(1)} plan
                  </Badge>
                )}
                {user.created_at && (
                  <Badge tone="slate" icon="calendar">
                    Since {formatDate(user.created_at)}
                  </Badge>
                )}
              </div>
            </div>
          </div>

          <SettingRow
            title="Your name"
            description={isOwner ? "What your team sees on approvals, rejections, notifications and product histories." : "What your team sees on your work, notifications and product histories."}
          >
            <NameForm
              name={user.name ?? null}
              onSaved={(name) => {
                const next = { ...user, name };
                setUser(next);
                cacheUser(next);
              }}
            />
          </SettingRow>

          <SettingRow title="Login email" description="The address you sign in with. It's fixed to the account. Contact us if it needs to change." last>
            <div className="input flex items-center justify-between bg-[var(--color-paper)] text-[var(--color-muted)]">
              <span className="truncate">{user.email}</span>
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 flex-shrink-0">
                <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
                <path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </div>
          </SettingRow>
        </div>

        <NotificationSettingsCard />

        <div className="card">
          <SettingRow title="Password" description="Choose a strong password you're not using anywhere else. You'll stay logged in on this device." last>
            <ChangePasswordForm email={user.email} />
          </SettingRow>
        </div>

        {coOwnerOf ? (
          // A login with owner access in a team is that team owner's to remove (the API refuses it here too).
          <div className="card">
            <SettingRow
              title="Your login"
              description={`${coOwnerOf.ownerName} gave you owner access in ${coOwnerOf.name}, so only they can remove this login, from their Team page.`}
              last
            >
              <p className="text-[13px] text-[var(--color-muted)]">{`Ask ${coOwnerOf.ownerName} if it needs to go.`}</p>
            </SettingRow>
          </div>
        ) : (
        <div className="card border-rose-200">
          <SettingRow
            title="Delete account"
            description={
              user.owns_team
                ? "Permanently deletes your account and your team: every connected marketplace, all listing data, and the logins of members in no other team."
                : "Permanently deletes your login: you leave every team you're in and can't log in again. The eBay accounts you worked on stay with their teams."
            }
            last
          >
            <div className="flex items-center justify-between gap-4">
              <p className="text-[13px] text-[var(--color-muted)]">This can&apos;t be undone.</p>
              <button type="button" onClick={() => setConfirmAction("delete")} className="btn btn-secondary btn-sm text-[var(--color-danger)]">
                Delete account
              </button>
            </div>
          </SettingRow>
        </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmAction === "logout"}
        title="Log out?"
        description="You'll need to log in again to access your dashboard."
        confirmLabel="Log out"
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleLogout}
      />
      <ConfirmDialog
        open={confirmAction === "delete"}
        title="Delete your account?"
        description={
          user.owns_team
            ? "This permanently deletes your account and your team: connections, listing data, and members' logins that are in no other team. This action cannot be undone."
            : "This permanently deletes your login: you leave every team you're in and won't be able to log in again. This action cannot be undone."
        }
        confirmLabel="Delete account"
        danger
        loading={actionLoading}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleDeleteAccount}
      />
    </AppShell>
  );
}
