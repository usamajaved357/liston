"use client";

import { useEffect, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, User } from "@/lib/api";
import { Field } from "@/components/Field";
import { PasswordField } from "@/components/PasswordField";
import { Alert } from "@/components/Alert";

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
        <input
          type="password"
          value={currentPassword}
          autoComplete="current-password"
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] px-3.5 py-2.5 text-[15px] text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/20 transition-colors"
        />
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
        <input
          type="password"
          value={currentPassword}
          autoComplete="current-password"
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] px-3.5 py-2.5 text-[15px] text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/20 transition-colors"
        />
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

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <main className="min-h-screen">
      <header className="border-b border-[var(--color-line)] bg-[var(--color-panel)]">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--color-primary)] text-white text-sm font-semibold">
              L
            </div>
            <span className="font-semibold text-[var(--color-ink)]">Liston</span>
          </div>
          <Link
            href="/dashboard"
            className="text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)] transition-colors"
          >
            Back to dashboard
          </Link>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">
        <h1 className="text-2xl font-semibold text-[var(--color-ink)]">Account settings</h1>

        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
          <h2 className="text-base font-semibold text-[var(--color-ink)] mb-1">Change email</h2>
          <p className="text-sm text-[var(--color-muted)] mb-5">
            You will need to verify the new address before it is fully active.
          </p>
          <ChangeEmailForm currentEmail={user.email} />
        </div>

        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
          <h2 className="text-base font-semibold text-[var(--color-ink)] mb-1">Change password</h2>
          <p className="text-sm text-[var(--color-muted)] mb-5">
            Choose a strong password you are not using anywhere else.
          </p>
          <ChangePasswordForm />
        </div>
      </div>
    </main>
  );
}
