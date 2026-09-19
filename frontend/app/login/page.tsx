"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Field } from "@/components/Field";
import { PasswordInput } from "@/components/PasswordInput";
import { AuthLayout } from "@/components/AuthLayout";
import { Alert } from "@/components/Alert";

export default function LoginPage() {
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
      const { user, token } = await api.login(email, password);
      localStorage.setItem("token", token);
      // A team member has no plan/billing of their own and can't manage
      // connections — send them straight to their accessible account(s)
      // instead of the owner-only overview dashboard.
      router.push(user.role === "member" ? "/connections" : "/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't log you in. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="Liston"
      title="Welcome back"
      subtitle="Log in to keep your listings running."
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="text-[var(--color-accent)] font-medium hover:underline">
            Sign up
          </Link>
        </>
      }
    >
      {/* method/action are never used (submit is intercepted) but, together
          with name/autocomplete on the inputs, they let Chrome and other
          password managers recognise this as a login form: offer to save the
          credentials the first time and fill them on later visits. */}
      <form onSubmit={handleSubmit} method="post" action="/login" className="space-y-3.5">
        <Field label="Email" type="email" name="email" value={email} onChange={setEmail} autoComplete="username" required />
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="block text-sm font-medium text-[var(--color-ink)]">Password</span>
            <Link
              href="/forgot-password"
              className="text-sm font-medium text-[var(--color-accent)] hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <PasswordInput name="password" value={password} onChange={setPassword} autoComplete="current-password" required />
        </div>
        {error && <Alert>{error}</Alert>}
        <button
          type="submit"
          disabled={loading}
          className="btn btn-primary w-full"
        >
          {loading ? "Logging in…" : "Log in"}
        </button>
      </form>
    </AuthLayout>
  );
}
