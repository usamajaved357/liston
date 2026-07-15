"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Field } from "@/components/Field";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { token } = await api.signup(email, password);
      localStorage.setItem("token", token);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create your account. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-[var(--color-primary)] text-white text-sm font-semibold mb-4">
            L
          </div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)] mb-1">Liston</p>
          <h1 className="text-2xl font-semibold text-[var(--color-ink)]">Create your account</h1>
          <p className="mt-1.5 text-[15px] text-[var(--color-muted)]">
            Start tracking competitor listings and publishing with AI.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 bg-[var(--color-panel)] p-6 rounded-lg border border-[var(--color-line)]">
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />
          {error && (
            <p role="alert" className="text-sm text-[var(--color-danger)]">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-[15px] font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60 transition-colors"
          >
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-[var(--color-muted)]">
          Already have an account?{" "}
          <Link href="/login" className="text-[var(--color-accent)] font-medium hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </main>
  );
}
