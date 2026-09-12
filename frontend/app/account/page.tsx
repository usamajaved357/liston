"use client";

import { useEffect, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, User } from "@/lib/api";
import { Field } from "@/components/Field";
import { PasswordField } from "@/components/PasswordField";
import { PasswordInput } from "@/components/PasswordInput";
import { Alert } from "@/components/Alert";
import { AppShell } from "@/components/AppShell";
import { AccountMenu } from "@/components/AccountMenu";
import { AvatarUploader } from "@/components/AvatarUploader";
import { ConfirmDialog } from "@/components/ConfirmDialog";

function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (email.trim().toLowerCase() === currentEmail.trim().toLowerCase()) {
      setError("New email must be different from your current email.");
      return;
    }

    setLoading(true);
    try {
      const { message } = await api.updateEmail(email, currentPassword);
      setSuccess(message);
      setEmail("");
      setCurrentPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update your email. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-[var(--color-muted)]">
        Current email: <span className="text-[var(--color-ink)] font-medium">{currentEmail}</span>
      </p>
      <Field label="New email" type="email" value={email} onChange={setEmail} autoComplete="email" />
      <div>
        <span className="block text-sm font-medium text-[var(--color-ink)] mb-1.5">Current password</span>
        <PasswordInput value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
      </div>
      {error && <Alert>{error}</Alert>}
      {success && <Alert variant="success">{success}</Alert>}
      <button
        type="submit"
        disabled={loading}
        className="rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-[15px] font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60 transition-colors"
      >
        {loading ? "Updating…" : "Update email"}
      </button>
    </form>
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
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <span className="block text-sm font-medium text-[var(--color-ink)] mb-1.5">Current password</span>
        <PasswordInput value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
      </div>
      <PasswordField
        label="New password"
        value={newPassword}
        onChange={setNewPassword}
        autoComplete="new-password"
        showCriteria
      />
      <PasswordField
        label="Confirm new password"
        value={confirmPassword}
        onChange={setConfirmPassword}
        autoComplete="new-password"
      />
      {error && <Alert>{error}</Alert>}
      {success && <Alert variant="success">{success}</Alert>}
      <button
        type="submit"
        disabled={loading}
        className="rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-[15px] font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60 transition-colors"
      >
        {loading ? "Updating…" : "Update password"}
      </button>
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
    <AppShell connectionsUsed={connectionsUsed} maxConnections={maxConnections} planName={planName}>
      <div className="flex items-center justify-between mb-7">
        <h1 className="text-xl font-extrabold text-[var(--color-ink)]">Account settings</h1>
        <AccountMenu
          email={user.email}
          planName={planName}
          avatarUrl={user.avatar_url}
          onLogout={() => setConfirmAction("logout")}
          onDeleteAccount={() => setConfirmAction("delete")}
        />
      </div>

      {actionError && (
        <div className="mb-4 max-w-xl">
          <Alert>{actionError}</Alert>
        </div>
      )}

      <div className="max-w-xl space-y-5">
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
          <h2 className="text-base font-bold text-[var(--color-ink)] mb-1">Profile photo</h2>
          <p className="text-sm text-[var(--color-muted)] mb-5">
            Shown in the sidebar and account menu across Liston.
          </p>
          <AvatarUploader
            avatarUrl={user.avatar_url}
            onChange={(avatarUrl) => setUser((u) => (u ? { ...u, avatar_url: avatarUrl } : u))}
          />
        </div>

        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
          <h2 className="text-base font-bold text-[var(--color-ink)] mb-1">Change email</h2>
          <p className="text-sm text-[var(--color-muted)] mb-5">
            You will need to verify the new address before it is fully active.
          </p>
          <ChangeEmailForm currentEmail={user.email} />
        </div>

        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
          <h2 className="text-base font-bold text-[var(--color-ink)] mb-1">Change password</h2>
          <p className="text-sm text-[var(--color-muted)] mb-5">
            Choose a strong password you are not using anywhere else.
          </p>
          <ChangePasswordForm />
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
        title="Delete your account?"
        description="This permanently deletes your account, connections, and listing data. This action cannot be undone."
        confirmLabel="Delete account"
        danger
        loading={actionLoading}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleDeleteAccount}
      />
    </AppShell>
  );
}
