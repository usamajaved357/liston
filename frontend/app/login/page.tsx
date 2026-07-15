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
      const { token } = await api.login(email, password);
      localStorage.setItem("token", token);
      router.push("/dashboard");
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
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
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
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        </div>
        {error && <Alert>{error}</Alert>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-[15px] font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60 transition-colors"
        >
          {loading ? "Logging in…" : "Log in"}
        </button>
      </form>
    </AuthLayout>
  );
}
