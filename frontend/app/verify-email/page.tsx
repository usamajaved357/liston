"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { AuthLayout } from "@/components/AuthLayout";

function VerifyEmailStatus() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [status, setStatus] = useState<"pending" | "success" | "error">("pending");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("This link is missing a verification token.");
      return;
    }
    api
      .verifyEmail(token)
      .then(({ user }) => {
        setStatus("success");
        setMessage(`${user.email} is now verified.`);
      })
      .catch((err) => {
        setStatus("error");
        setMessage(err instanceof ApiError ? err.message : "Couldn't verify this email.");
      });
  }, [token]);

  if (status === "pending") {
    return <p className="text-[15px] text-[var(--color-muted)]">Verifying…</p>;
  }

  return (
    <div>
      <p className={`text-[15px] ${status === "error" ? "text-[var(--color-danger)]" : "text-[var(--color-ink)]"}`}>
        {message}
      </p>
      <Link
        href="/dashboard"
        className="mt-4 inline-block text-sm font-medium text-[var(--color-accent)] hover:underline"
      >
        Go to dashboard
      </Link>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <AuthLayout
      eyebrow="Liston"
      title="Verify your email"
      subtitle="Confirming your email address."
      footer={
        <Link href="/login" className="text-[var(--color-accent)] font-medium hover:underline">
          Back to log in
        </Link>
      }
    >
      <Suspense fallback={<p className="text-sm text-[var(--color-muted)]">Loading…</p>}>
        <VerifyEmailStatus />
      </Suspense>
    </AuthLayout>
  );
}
