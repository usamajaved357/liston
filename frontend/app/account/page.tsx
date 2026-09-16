"use client";

import { useEffect, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, User } from "@/lib/api";
import { PasswordField } from "@/components/PasswordField";
import { PasswordInput } from "@/components/PasswordInput";
import { AppShell } from "@/components/AppShell";
import { AccountMenu } from "@/components/AccountMenu";
import { AvatarUploader } from "@/components/AvatarUploader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatDate } from "@/lib/format";

// Two-column settings rows: what the setting is on the left, the control on
// the right. Email isn't editable here — it's the login identity and the
// address access approval was granted to.
function SettingRow({ title, description, children, last }: { title: string; description: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`grid gap-4 px-6 py-6 md:grid-cols-[260px_minmax(0,1fr)] ${last ? "" : "border-b border-[var(--color-line)]"}`}>
      <div>
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">{title}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-muted)]">{description}</p>
      </div>
      <div className="min-w-0 max-w-md">{children}</div>
    </div>
  );
}

function ChangePasswordForm() {
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
    <form onSubmit={handleSubmit} className="space-y-3.5">
      <div>
        <span className="mb-1 block text-[13px] font-medium text-[var(--color-ink)]">Current password</span>
        <PasswordInput value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
      </div>
      <PasswordField label="New password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" showCriteria />
      <PasswordField label="Confirm new password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />
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
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<"logout" | "delete" | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/login");
      return;
    }
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => {
        localStorage.removeItem("token");
        router.replace("/login");
      })
      .finally(() => setLoading(false));
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

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-[var(--color-muted)]">Loading…</p>
      </main>
    );
  }

  if (!user) {
    return null;
  }

  const connectionsUsed = Number(user.connections_used ?? 0);
  const maxConnections = user.max_connections ?? 0;
  const planName = user.plan_name ?? "Unassigned";
  const isOwner = user.role !== "member";

  return (
    <AppShell
      connectionsUsed={connectionsUsed}
      maxConnections={maxConnections}
      planName={planName}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-ink)]">Account</h1>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Your login and how you appear in Liston.</p>
          </div>
          <AccountMenu
            email={user.email}
            subtitle={`${planName} plan`}
            avatarUrl={user.avatar_url}
            onLogout={() => setConfirmAction("logout")}
            onDeleteAccount={() => setConfirmAction("delete")}
          />
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
          <SettingRow title="Profile" description="Your photo is shown in the sidebar and account menu.">
            <div className="flex flex-wrap items-center gap-5">
              <AvatarUploader avatarUrl={user.avatar_url} onChange={(avatarUrl) => setUser((u) => (u ? { ...u, avatar_url: avatarUrl } : u))} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[var(--color-ink)]">{user.name || user.email}</p>
                <p className="truncate text-[13px] text-[var(--color-muted)]">{user.email}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="chip chip-primary">{isOwner ? (user.is_admin ? "Admin" : "Owner") : "Team member"}</span>
                  {user.email_verified_at ? <span className="chip chip-accent">Email verified</span> : <span className="chip chip-warning">Email not verified</span>}
                  {user.created_at && <span className="chip">Since {formatDate(user.created_at)}</span>}
                </div>
              </div>
            </div>
          </SettingRow>

          <SettingRow title="Login email" description="The address you sign in with. It's fixed to the account — contact us if it needs to change." last>
            <div className="input flex items-center justify-between bg-[var(--color-paper)] text-[var(--color-muted)]">
              <span className="truncate">{user.email}</span>
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 flex-shrink-0">
                <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
                <path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </div>
          </SettingRow>
        </div>

        <div className="card">
          <SettingRow title="Password" description="Choose a strong password you're not using anywhere else. You'll stay logged in on this device." last>
            <ChangePasswordForm />
          </SettingRow>
        </div>

        <div className="card border-rose-200">
          <SettingRow
            title={isOwner ? "Delete account" : "Remove my login"}
            description={
              isOwner
                ? "Permanently deletes your account, every connected marketplace, team members and all listing data."
                : "Removes only your own login. The accounts and data you had access to are unaffected."
            }
            last
          >
            <div className="flex items-center justify-between gap-4">
              <p className="text-[13px] text-[var(--color-muted)]">This can&apos;t be undone.</p>
              <button type="button" onClick={() => setConfirmAction("delete")} className="btn btn-secondary btn-sm text-[var(--color-danger)]">
                {isOwner ? "Delete account" : "Remove login"}
              </button>
            </div>
          </SettingRow>
        </div>
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
        title={isOwner ? "Delete your account?" : "Remove your login?"}
        description={
          isOwner
            ? "This permanently deletes your account, connections, and listing data. This action cannot be undone."
            : "This removes your own team-member login. It doesn't affect the accounts or data owned by whoever gave you access."
        }
        confirmLabel={isOwner ? "Delete account" : "Remove login"}
        danger
        loading={actionLoading}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleDeleteAccount}
      />
    </AppShell>
  );
}
