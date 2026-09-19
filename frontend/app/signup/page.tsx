"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Field } from "@/components/Field";
import { PasswordField } from "@/components/PasswordField";
import { AuthLayout } from "@/components/AuthLayout";
import { Alert } from "@/components/Alert";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [accessNote, setAccessNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    try {
      const { token, user } = await api.signup(email, password, { name: name || undefined, accessNote: accessNote || undefined });
      localStorage.setItem("token", token);
      router.push(user.access_status === "pending" ? "/pending" : "/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create your account. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="Liston"
      title="Request access"
      subtitle="Liston is invite-only while we build. Tell us about your business and we'll approve your account by email."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="text-[var(--color-accent)] font-medium hover:underline">
            Log in
          </Link>
        </>
      }
    >
      {/* See login: name/autocomplete let password managers offer to save
          the new credentials once the account is created. */}
      <form onSubmit={handleSubmit} method="post" action="/signup" className="space-y-3.5">
        <Field label="Your name" type="text" name="name" value={name} onChange={setName} autoComplete="name" required />
        <Field label="Email" type="email" name="email" value={email} onChange={setEmail} autoComplete="username" required />
        <PasswordField
          label="Password"
          name="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          showCriteria
        />
        <div>
          <label className="block text-[13px] font-medium text-[var(--color-ink)]">About your business <span className="font-normal text-[var(--color-muted)]">(optional)</span></label>
          <textarea
            className="input mt-1 h-[4.5rem] resize-none text-[13.5px]"
            placeholder="e.g. UK eBay seller, two stores, mostly home & garden"
            value={accessNote}
            onChange={(e) => setAccessNote(e.target.value)}
            maxLength={500}
          />
        </div>
        {error && <Alert>{error}</Alert>}
        <button type="submit" disabled={loading} className="btn btn-primary w-full">
          {loading ? "Sending request…" : "Request access"}
        </button>
      </form>
    </AuthLayout>
  );
}
