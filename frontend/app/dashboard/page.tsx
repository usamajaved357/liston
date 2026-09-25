"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, Overview, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { AccountMenu } from "@/components/AccountMenu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ListingCards, MetricCards, MetricTabs, Metric, formatAmount } from "@/components/overview/OverviewMoney";
import { cacheUser, useCachedUser } from "@/lib/session";
import { currencySymbol } from "@/lib/format";
import { ebayConnectError } from "@/lib/connect-errors";

// The business Overview: the money across every connected account for a
// range, one eBay market at a time (each has its own currency). A tab per
// figure — sales, fees, earnings, source cost, profit — and four cards
// breaking the chosen one down. Per-account figures live on each account's
// own Overview; here an account only appears when it needs attention.

const RANGES: { key: string; label: string; phrase: string }[] = [
  { key: "today", label: "Today", phrase: "today" },
  { key: "7d", label: "7 days", phrase: "in the last 7 days" },
  { key: "30d", label: "30 days", phrase: "in the last 30 days" },
  { key: "this_month", label: "This month", phrase: "this month" },
  { key: "90d", label: "90 days", phrase: "in the last 90 days" },
];

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
        <span className="flex-1">{ebayConnectError(ebayError, "Try again from Connections.")}</span>
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
  const [range, setRange] = useState("today");
  // "all", or one eBay site (EBAY_GB…): the busiest one until the viewer picks.
  const [market, setMarket] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("sales");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");
  const [confirmLogout, setConfirmLogout] = useState(false);

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
        return loadOverview("today");
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

  // Fees and earnings are read from eBay in the background; while some are
  // still coming, ask again a few times.
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    if (!overview?.financesPending || polls >= 6) return;
    const timer = setTimeout(() => {
      setPolls((n) => n + 1);
      api.overview(range).then(setOverview).catch(() => {});
    }, 8000);
    return () => clearTimeout(timer);
  }, [overview, polls, range]);

  function changeRange(r: string) {
    setRange(r);
    loadOverview(r);
  }

  function handleLogout() {
    localStorage.removeItem("token");
    router.push("/login");
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
  const rangeLabel = RANGES.find((r) => r.key === range)?.label.toLowerCase() || range;
  const rangePhrase = RANGES.find((r) => r.key === range)?.phrase || `in the last ${rangeLabel}`;

  // The market in view: the one picked, else the busiest (markets come busiest first).
  const markets = o?.markets ?? [];
  const current = market ?? (markets.length > 1 ? markets[0].id : "all");
  const inView = current === "all" ? markets : markets.filter((m) => m.id === current);
  const accounts = (o?.perAccount ?? []).filter((a) => current === "all" || (a.marketplace?.id ?? "EBAY_GB") === current);
  // Only the money tabs lean on eBay's finances.
  const needReconnect = metric === "listings" ? [] : accounts.filter((a) => a.ok && !a.financesAccess);
  const failedHere = accounts.filter((a) => !a.ok);
  // Money in view: one market's own figures, or every market as one figure
  // converted into the main currency (each currency apart if no rate).
  const combined = current === "all" && markets.length > 1 ? o?.combined ?? null : null;
  const moneyInView = combined ? [combined.money] : inView.map((m) => m.money);
  const others = markets.filter((m) => combined && m.currency !== combined.money.currency).map((m) => m.label);
  const listed = others.length > 1 ? `${others.slice(0, -1).join(", ")} and ${others[others.length - 1]}` : others[0];
  const converted = combined
    ? `${listed} figures converted to ${currencySymbol(combined.money.currency)} at the European Central Bank rate${
        combined.ratesDate ? ` of ${new Date(combined.ratesDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""
      }: ${Object.entries(combined.rates)
        .map(([code, rate]) => `${formatAmount(1, combined.money.currency).replace(/\.00$/, "")} = ${formatAmount(rate, code)}`)
        .join(" · ")}. Pick a market for its exact figures.`
    : null;

  // The markets in view's listing work, added up (counts, not money).
  const listingWork = inView.length
    ? inView.reduce(
        (sum, m) => ({ live: sum.live + m.listings.live, waiting: sum.waiting + m.listings.waiting, drafted: sum.drafted + m.listings.drafted, published: sum.published + m.listings.published }),
        { live: 0, waiting: 0, drafted: 0, published: 0 }
      )
    : null;
  // One name per account, its markets after it ("Minsu LTD (UK, AU)") when
  // every market is in view: one reconnect covers all of them.
  const names = (list: typeof accounts) => {
    const byLabel = new Map<string, string[]>();
    for (const a of list) byLabel.set(a.label, [...(byLabel.get(a.label) ?? []), a.marketplace?.label ?? ""]);
    return [...byLabel].map(([label, sites]) => (current === "all" ? `${label} (${sites.filter(Boolean).join(", ")})` : label)).join(", ");
  };
  const accountCount = (list: typeof accounts) => new Set(list.map((a) => a.label)).size;

  return (
    <AppShell
      connectionsUsed={o?.accounts.total ?? 0}
      maxConnections={user.max_connections ?? 0}
      planName={planName}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-ink)]">Overview</h1>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Across all your connected accounts.</p>
          </div>
          <div className="page-header-controls">
            <AccountMenu
              email={user.email}
              subtitle={`${planName} plan`}
              avatarUrl={user.avatar_url}
              onLogout={() => setConfirmLogout(true)}
            />
          </div>
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


      {!o ? (
        <>
          <div className="mb-4 flex items-center justify-between">
            <div className="h-8 w-72 animate-pulse rounded-full bg-[var(--color-line)]" />
            <div className="h-8 w-80 animate-pulse rounded-full bg-[var(--color-line)]" />
          </div>
          <MetricTabs metric={metric} onMetric={setMetric} />
          <div className="mt-5">
            {metric === "listings" ? <ListingCards work={null} loading /> : <MetricCards metric={metric} summaries={[]} loading />}
          </div>
        </>
      ) : o.accounts.total === 0 ? (
        <div className="card px-6 py-12 text-center">
          <p className="text-sm font-medium text-[var(--color-ink)]">No accounts connected yet</p>
          <p className="mt-1 text-[13px] text-[var(--color-muted)]">Connect your eBay store to see sales, fees, earnings and profit here.</p>
          <Link href="/connections" className="btn btn-primary btn-sm mt-4">
            Connect an account
          </Link>
        </div>
      ) : (
        <>
          {/* Which market and which dates. */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            {markets.length > 1 ? (
              <div role="radiogroup" aria-label="Market" className="inline-flex flex-wrap rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
                {[{ id: "all", flag: "", label: "All markets", accounts: o.perAccount.length }, ...markets].map((m) => {
                  const on = current === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setMarket(m.id)}
                      className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors ${
                        on ? "bg-[var(--color-primary)] text-white shadow-sm" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                      }`}
                    >
                      {m.flag && <span aria-hidden>{m.flag}</span>}
                      {m.label}
                      <span className={on ? "text-white/70" : "opacity-60"}>{m.accounts}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-[13px] text-[var(--color-muted)]">
                Sales figures for <span className="font-medium text-[var(--color-ink)]">{rangePhrase.replace(/^in /, "")}</span>
              </p>
            )}
            <div className="flex items-center gap-3">
              {refreshing && <span className="text-[12px] text-[var(--color-muted)]">Updating…</span>}
              <div role="radiogroup" aria-label="Dates" className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
                {RANGES.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    role="radio"
                    aria-checked={range === r.key}
                    onClick={() => changeRange(r.key)}
                    className={`h-7 rounded-full px-3 text-[12px] font-medium transition-colors ${
                      range === r.key ? "bg-[var(--color-primary)] text-white shadow-sm" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <MetricTabs metric={metric} onMetric={setMetric} />
          <div className="mt-5">
            {metric === "listings" ? <ListingCards work={listingWork} /> : <MetricCards metric={metric} summaries={moneyInView} />}
          </div>
          {converted && metric !== "listings" && (
            <p className="mt-3 text-[12px] text-[var(--color-muted)]">{converted}</p>
          )}

          {/* The one thing to know about what the figures leave out. */}
          {(needReconnect.length > 0 || failedHere.length > 0 || (o.financesPending && metric !== "listings")) && (
            <div className="mt-5 rounded-xl border border-[#fde68a] bg-[var(--color-warning-soft)] px-4 py-3 text-[13px] text-[#92400e]">
              {o.financesPending && metric !== "listings" && <p>Reading fees and earnings from eBay. The figures update by themselves.</p>}
              {needReconnect.length > 0 && (
                <p>
                  {accountCount(needReconnect) === 1
                    ? `${names(needReconnect)} needs reconnecting before its fees, earnings and profit count here (its sales already do). `
                    : `${accountCount(needReconnect)} accounts need reconnecting before their fees, earnings and profit count here (their sales already do): ${names(needReconnect)}. `}
                  <Link href="/connections" className="font-medium underline">
                    Reconnect in Connections
                  </Link>
                </p>
              )}
              {failedHere.length > 0 && (
                <p>
                  {`${names(failedHere)} couldn't be read from eBay just now, so ${failedHere.length === 1 ? "it's" : "they're"} left out. `}
                  <Link href="/connections" className="font-medium underline">
                    Check in Connections
                  </Link>
                </p>
              )}
            </div>
          )}

        </>
      )}

      <ConfirmDialog
        open={confirmLogout}
        title="Log out?"
        description="You'll need to log in again to access your dashboard."
        confirmLabel="Log out"
        onCancel={() => setConfirmLogout(false)}
        onConfirm={handleLogout}
      />
    </AppShell>
  );
}
