"use client";

import { useState, FormEvent } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Field } from "@/components/Field";
import { AuthLayout } from "@/components/AuthLayout";
import { Alert } from "@/components/Alert";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="Liston"
      title="Reset your password"
      subtitle="We'll send a reset link to your email."
      footer={
        <Link href="/login" className="text-[var(--color-accent)] font-medium hover:underline">
          Back to log in
        </Link>
      }
    >
      {sent ? (
        <p className="text-[15px] text-[var(--color-ink)]">
          If an account exists for <span className="font-medium">{email}</span>, a reset link is on
          its way. Check your inbox (and spam folder) for an email from Liston.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
          {error && <Alert>{error}</Alert>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-[15px] font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60 transition-colors"
          >
            {loading ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
