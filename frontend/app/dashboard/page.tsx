"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, Overview, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { AccountMenu } from "@/components/AccountMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatPrice } from "@/lib/format";
import { cacheUser, useCachedUser } from "@/lib/session";

// The overview: what's happening across every connected account, summed.
// Plan/usage rings are gone until billing exists — the numbers that matter
// day to day are listings live, money in, and what's waiting in drafts.

const RANGES: { key: string; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "this_month", label: "This month" },
  { key: "90d", label: "90 days" },
];

function Stat({
  label,
  value,
  hint,
  icon,
  tone = "default",
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  tone?: "default" | "primary" | "accent";
  href?: string;
}) {
  const iconBg = { default: "bg-[var(--color-paper)] text-[var(--color-muted)]", primary: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]", accent: "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" }[tone];
  const body = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-[var(--color-muted)]">{label}</span>
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${iconBg}`}>{icon}</span>
      </div>
      <p className="mt-3 text-[28px] font-semibold leading-none tracking-tight text-[var(--color-ink)]">{value}</p>
      {hint && <p className="mt-2 text-[12px] text-[var(--color-muted)]">{hint}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="card block p-5 transition-colors hover:border-[var(--color-line-strong)]">
      {body}
    </Link>
  ) : (
    <div className="card p-5">{body}</div>
  );
}

function ConnectionBanner() {
  const searchParams = useSearchParams();
  const connected = searchParams.get("connected");
  const ebayError = searchParams.get("ebayError");

  if (connected === "ebay") {
    return (
      <div className="notice notice-success mb-4">
        <span className="flex-1">Your eBay account is connected.</span>
      </div>
    );
  }
  if (ebayError) {
    return (
      <div className="notice notice-danger mb-4">
        <span className="flex-1">Couldn&apos;t connect your eBay account ({ebayError}). Try again from Connections.</span>
      </div>
    );
  }
  return null;
}

export default function DashboardPage() {
  const router = useRouter();
  // Seeded from the local cache so the shell paints immediately; the API
  // copy replaces it a moment later.
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [range, setRange] = useState("7d");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");
  const [confirmAction, setConfirmAction] = useState<"logout" | "delete" | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const loadOverview = useCallback(async (r: string) => {
    setRefreshing(true);
    try {
      setOverview(await api.overview(r));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        localStorage.removeItem("token");
        router.replace("/login");
        return;
      }
      setError("Couldn't load your overview. Try refreshing.");
    } finally {
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/login");
      return;
    }
    api
      .me()
      .then(({ user }) => {
        // A member has no overview of their own — send them to their account(s).
        if (user.role === "member") {
          router.replace("/connections");
          return;
        }
        setUser(user);
        cacheUser(user);
        return loadOverview("7d");
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          localStorage.removeItem("token");
          router.replace("/login");
          return;
        }
        setError("Couldn't load your overview. Try refreshing.");
      });
  }, [router, loadOverview]);

  function changeRange(r: string) {
    setRange(r);
    loadOverview(r);
  }

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
      setError(err instanceof ApiError ? err.message : "Couldn't delete your account. Try again.");
      setConfirmAction(null);
      setActionLoading(false);
    }
  }

  async function handleResendVerification() {
    setResendState("sending");
    try {
      await api.resendVerification();
      setResendState("sent");
    } catch {
      setResendState("idle");
    }
  }

  // No cached user on a cold start: a bare shell for the few hundred ms
  // until /me answers, never a blank page.
  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-10">
        <div className="mx-auto max-w-5xl space-y-4">
          <div className="h-6 w-40 animate-pulse rounded-full bg-[var(--color-line)]" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="card h-28 animate-pulse" />
            ))}
          </div>
        </div>
      </main>
    );
  }

  const planName = user.plan_name ?? "Unassigned";
  const o = overview;
  const money = (n: number) => formatPrice(n, o?.earnings.currency || "GBP");
  const rangeLabel = RANGES.find((r) => r.key === range)?.label.toLowerCase() || range;
  const failed = o?.perAccount.filter((a) => !a.ok) || [];

  return (
    <AppShell
      connectionsUsed={o?.accounts.total ?? 0}
      maxConnections={user.max_connections ?? 0}
      planName={planName}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-ink)]">Overview</h1>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Across all your connected accounts.</p>
          </div>
          <AccountMenu
            email={user.email}
            subtitle={`${planName} plan`}
            avatarUrl={user.avatar_url}
            onLogout={() => setConfirmAction("logout")}
            onDeleteAccount={() => setConfirmAction("delete")}
          />
        </div>
      }
    >
      {error && (
        <div className="notice notice-danger mb-4">
          <span className="flex-1">{error}</span>
        </div>
      )}

      <Suspense fallback={null}>
        <ConnectionBanner />
      </Suspense>

      {!user.email_verified_at && (
        <div className="notice notice-warning mb-4">
          <span className="flex-1">
            Verify your email to secure your account.
            {resendState === "sent" && " Check your inbox for the new link."}
          </span>
          <button onClick={handleResendVerification} disabled={resendState !== "idle"} className="btn btn-secondary btn-sm">
            {resendState === "sending" ? "Sending…" : resendState === "sent" ? "Sent" : "Resend"}
          </button>
        </div>
      )}

      {failed.map((a) => (
        <div key={a.id} className="notice notice-warning mb-4">
          <span className="flex-1">
            <strong>{a.label}</strong> couldn&apos;t be read, so its numbers are left out of the totals. {a.error}
          </span>
          <Link href="/connections" className="btn btn-secondary btn-sm">
            Connections
          </Link>
        </div>
      ))}

      {!o ? (
        <>
          <div className="mb-3 flex items-center justify-between">
            <div className="h-4 w-56 animate-pulse rounded-full bg-[var(--color-line)]" />
            <div className="h-7 w-72 animate-pulse rounded-full bg-[var(--color-line)]" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="card p-5">
                <div className="flex items-center justify-between">
                  <div className="h-3.5 w-24 animate-pulse rounded-full bg-[var(--color-line)]" />
                  <div className="h-8 w-8 animate-pulse rounded-lg bg-[var(--color-paper)]" />
                </div>
                <div className="mt-4 h-7 w-20 animate-pulse rounded-md bg-[var(--color-line)]" />
                <div className="mt-2.5 h-3 w-32 animate-pulse rounded-full bg-[var(--color-paper)]" />
              </div>
            ))}
          </div>
        </>
      ) : o.accounts.total === 0 ? (
        <div className="card px-6 py-12 text-center">
          <p className="text-sm font-medium text-[var(--color-ink)]">No accounts connected yet</p>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">Connect your eBay store to see listings, orders and earnings here.</p>
          <Link href="/connections" className="btn btn-primary btn-sm mt-4">
            Connect an account
          </Link>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-[var(--color-muted)]">
              Sales figures for the last <span className="font-medium text-[var(--color-ink)]">{rangeLabel}</span>
              {refreshing && <span className="ml-2 text-[var(--color-muted)]">· updating…</span>}
            </p>
            <div className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => changeRange(r.key)}
                  className={`h-7 rounded-full px-3 text-[12px] font-medium transition-colors ${
                    range === r.key ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Stat
              label="Earnings"
              value={o ? money(o.earnings.amount) : "—"}
              hint={o ? `${o.orders} order${o.orders === 1 ? "" : "s"} in the last ${rangeLabel}` : undefined}
              tone="accent"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M4 17l5-5 4 4 7-8M15 8h5v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              }
            />
            <Stat
              label="Active listings"
              value={o ? String(o.activeListings) : "—"}
              hint="Live on eBay right now"
              tone="primary"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <rect x="3.5" y="4" width="17" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
                  <rect x="3.5" y="10.5" width="17" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
                  <rect x="3.5" y="17" width="17" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              }
            />
            <Stat
              label="Connected accounts"
              value={o ? String(o.accounts.total) : "—"}
              hint={o && o.accounts.needsAttention ? `${o.accounts.needsAttention} need${o.accounts.needsAttention === 1 ? "s" : ""} attention` : "All connections healthy"}
              href="/connections"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              }
            />
            <Stat
              label="Drafts waiting"
              value={o ? String(o.drafts) : "—"}
              hint="Drafted in Liston, not yet published"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M4 20h4l10-10-4-4L4 16v4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M13 7l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              }
            />
            <Stat
              label="Published with Liston"
              value={o ? String(o.publishedViaListon) : "—"}
              hint="Listings that went live from here"
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              }
            />
            <Stat
              label="Orders"
              value={o ? String(o.orders) : "—"}
              hint={`In the last ${rangeLabel}`}
              icon={
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                  <path d="M6 3h12l1 5H5l1-5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M5 8h14v11a2 2 0 01-2 2H7a2 2 0 01-2-2V8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                </svg>
              }
            />
          </div>

          {o && o.perAccount.length > 1 && (
            <div className="card mt-6 overflow-hidden">
              <div className="border-b border-[var(--color-line)] px-5 py-3">
                <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">By account</h2>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-[var(--color-paper)] text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                  <tr>
                    <th className="px-5 py-2">Account</th>
                    <th className="px-5 py-2 text-right">Active listings</th>
                    <th className="px-5 py-2 text-right">Orders</th>
                    <th className="px-5 py-2 text-right">Earnings</th>
                  </tr>
                </thead>
                <tbody>
                  {o.perAccount.map((a) => (
                    <tr key={a.id} className="border-t border-[var(--color-line)]">
                      <td className="px-5 py-2.5 font-medium text-[var(--color-ink)]">
                        <Link href={`/accounts/${a.id}`} className="hover:text-[var(--color-primary)] hover:underline">
                          {a.label}
                        </Link>
                        {!a.ok && <span className="ml-2 text-xs text-[var(--color-danger)]">unavailable</span>}
                      </td>
                      <td className="px-5 py-2.5 text-right text-[var(--color-ink)]">{a.activeListings}</td>
                      <td className="px-5 py-2.5 text-right text-[var(--color-ink)]">{a.orders}</td>
                      <td className="px-5 py-2.5 text-right font-medium text-[var(--color-ink)]">{a.earnings ? formatPrice(a.earnings.amount, a.earnings.currency) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

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
