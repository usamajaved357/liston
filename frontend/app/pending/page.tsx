"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, User } from "@/lib/api";
import { AuthLayout } from "@/components/AuthLayout";

// Where a signed-up owner waits. Nothing else in the app is reachable until
// an admin approves them (the API returns 403 everywhere and lib/api.ts
// routes those here). The page is a three-step status, so the person can
// see exactly where they are and what — if anything — is theirs to do.

type StepState = "done" | "current" | "todo" | "failed";

function Step({ n, state, title, children, last }: { n: number; state: StepState; title: string; children?: React.ReactNode; last?: boolean }) {
  const badge = {
    done: "bg-[var(--color-accent)] text-white",
    current: "bg-[var(--color-primary)] text-white ring-4 ring-[var(--color-primary-soft)]",
    todo: "border border-[var(--color-line-strong)] bg-[var(--color-panel)] text-[var(--color-muted)]",
    failed: "bg-[var(--color-danger)] text-white",
  }[state];
  return (
    <li className="relative flex gap-4">
      {!last && <span className={`absolute left-[15px] top-8 h-[calc(100%-8px)] w-px ${state === "done" ? "bg-[var(--color-accent)]" : "bg-[var(--color-line)]"}`} />}
      <span className={`relative z-10 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${badge}`}>
        {state === "done" ? (
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : state === "failed" ? (
          "×"
        ) : (
          n
        )}
      </span>
      <div className={`min-w-0 flex-1 ${last ? "" : "pb-6"}`}>
        <p className={`text-sm font-semibold ${state === "todo" ? "text-[var(--color-muted)]" : "text-[var(--color-ink)]"}`}>{title}</p>
        {children && <div className="mt-1 text-sm leading-relaxed text-[var(--color-muted)]">{children}</div>}
      </div>
    </li>
  );
}

export default function PendingPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState<"idle" | "sending" | "sent">("idle");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { user } = await api.me();
        if (cancelled) return;
        if (user.access_status === "active") {
          router.replace("/dashboard");
          return;
        }
        setUser(user);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
        else if (!cancelled) setError("Couldn't load your account. Refresh to try again.");
      }
    }
    load();
    // Poll gently: the moment an admin approves, the page moves on by itself.
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [router]);

  async function resend() {
    setResent("sending");
    try {
      await api.resendVerification();
      setResent("sent");
    } catch {
      setError("Couldn't resend the email. Try again in a minute.");
      setResent("idle");
    }
  }

  function logout() {
    localStorage.removeItem("token");
    router.push("/login");
  }

  const rejected = user?.access_status === "rejected";
  const verified = Boolean(user?.email_verified_at);

  return (
    <AuthLayout
      eyebrow="Liston"
      title={rejected ? "Access not available" : "Your request is under review"}
      subtitle={
        rejected
          ? "We're not able to open access for this account right now."
          : "It's with the Liston team now. We'll email you the moment it's approved — usually within a day."
      }
      footer={
        <span className="text-[var(--color-muted)]">
          {user?.email && (
            <>
              Signed in as <span className="font-medium text-[var(--color-ink)]">{user.email}</span> ·{" "}
            </>
          )}
          <button type="button" onClick={logout} className="font-medium text-[var(--color-accent)] hover:underline">
            Log out
          </button>
        </span>
      }
    >
      {!user ? (
        <div className="space-y-3">
          <div className="h-10 animate-pulse rounded-full bg-[var(--color-paper)]" />
          <div className="h-10 animate-pulse rounded-full bg-[var(--color-paper)]" />
          {error && <div className="notice notice-danger">{error}</div>}
        </div>
      ) : (
        <div className="space-y-5">
          {error && (
            <div className="notice notice-danger">
              <span className="flex-1">{error}</span>
            </div>
          )}

          <ol>
            <Step n={1} state="done" title="Account created" />
            <Step n={2} state={verified ? "done" : "current"} title={verified ? "Email verified" : "Verify your email"}>
              {!verified && (
                <>
                  <p>
                    We sent a link to <span className="font-medium text-[var(--color-ink)]">{user.email}</span>. If it hasn&apos;t arrived,
                    don&apos;t worry — your request is already with us.
                  </p>
                  <button type="button" onClick={resend} disabled={resent !== "idle"} className="btn btn-secondary btn-sm mt-3">
                    {resent === "sent" ? "Sent — check your inbox" : resent === "sending" ? "Sending…" : "Resend the email"}
                  </button>
                </>
              )}
            </Step>
            <Step n={3} state={rejected ? "failed" : "current"} title={rejected ? "Request declined" : "Reviewed by the Liston team"}>
              {rejected
                ? "If you think this is a mistake, reply to the email you received."
                : "Nothing more for you to do. This page updates itself when a decision is made."}
            </Step>
            <Step n={4} state="todo" title="Connect your eBay account and start drafting" last />
          </ol>
        </div>
      )}
    </AuthLayout>
  );
}
