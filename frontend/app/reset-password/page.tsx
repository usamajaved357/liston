"use client";

import { Suspense, useState, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { PasswordField } from "@/components/PasswordField";
import { AuthLayout } from "@/components/AuthLayout";
import { Alert } from "@/components/Alert";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
      setTimeout(() => router.push("/login"), 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset your password. Try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <Alert>
        This link is missing a reset token. Request a new one from the{" "}
        <Link href="/forgot-password" className="underline">
          forgot password
        </Link>{" "}
        page.
      </Alert>
    );
  }

  if (done) {
    return (
      <Alert variant="success">Password reset. Redirecting you to log in.</Alert>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PasswordField
        label="New password"
        value={password}
        onChange={setPassword}
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
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-[15px] font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60 transition-colors"
      >
        {loading ? "Resetting…" : "Reset password"}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthLayout
      eyebrow="Liston"
      title="Set a new password"
      subtitle="Choose a new password for your account."
      footer={
        <Link href="/login" className="text-[var(--color-accent)] font-medium hover:underline">
          Back to log in
        </Link>
      }
    >
      <Suspense fallback={<p className="text-sm text-[var(--color-muted)]">Loading…</p>}>
        <ResetPasswordForm />
      </Suspense>
    </AuthLayout>
  );
}
