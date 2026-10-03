"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, ListingWork, Overview, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { HeaderAvatar } from "@/components/AccountMenu";
import { AmountsToggle, ListingCards, SalesCards, MetricTabs, Metric, formatAmount } from "@/components/overview/OverviewMoney";
import { BestSellersCard, SalesTrendCard } from "@/components/overview/OverviewSales";
import { AccountListingsCard, addListingTrends, ListingTrendCard, RecentListingsCard } from "@/components/overview/OverviewListings";
import { useAmounts } from "@/lib/useAmounts";
import { cacheUser, useCachedUser } from "@/lib/session";
import { currencySymbol } from "@/lib/format";
import { ebayConnectError } from "@/lib/connect-errors";
import { PillTabs } from "@/components/PillTabs";

// The business Overview: the money across every connected account for a
// range, one eBay market at a time (each has its own currency). A Sales tab
// with a card per money figure, then sales by day and the best sellers; a
// Listings tab with the listing pipeline. Amounts start hidden (the eye
// shows them). Per-account figures live on each account's own Overview;
// here an account only appears when it needs attention.

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
  const amounts = useAmounts();
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

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
      <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
        <div className="mx-auto max-w-5xl space-y-4">
          <div className="h-6 w-40 animate-pulse rounded-full bg-[var(--color-line)]" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
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

  // Sales by day and best sellers for what's in view: all markets as one
  // (in the main currency), or one market's own. Several currencies with no
  // exchange rate can't share one chart.
  const trendInView = combined ? combined.trend ?? null : inView.length === 1 ? inView[0].trend ?? null : null;
  const trendCurrency = combined ? combined.money.currency : inView[0]?.currency ?? "GBP";
  const trendNote =
    !combined && inView.length > 1 ? "Your markets sell in different currencies and no exchange rate could be had just now. Pick a market to see its sales by day." : null;
  const trendCaption = range === "today" ? "Today" : range === "this_month" ? "This month" : `Last ${rangeLabel}`;
  const bestInView = combined
    ? combined.bestSellers ?? []
    : inView
        .flatMap((m) => m.bestSellers ?? [])
        .sort((a, b) => b.units - a.units || b.sales - a.sales)
        .slice(0, 6);

  // The markets in view's listing work, added up (counts, not money): every figure each market has.
  const listingWork: ListingWork | null = inView.length
    ? inView.reduce((sum, m) => {
        const next = { ...sum } as Record<string, number>;
        for (const [key, value] of Object.entries(m.listings)) next[key] = (next[key] ?? 0) + (Number(value) || 0);
        return next as unknown as ListingWork;
      }, { live: 0, waiting: 0, drafted: 0, published: 0 } as ListingWork)
    : null;
  // The dates in words, for the By account table's heading.
  const datesLabel = range === "today" ? "Today" : range === "this_month" ? "This month" : range === "last_month" ? "Last month" : `Last ${rangeLabel}`;
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
            <HeaderAvatar email={user.email} avatarUrl={user.avatar_url} />
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
          <MetricTabs metric={metric} onMetric={setMetric} trailing={metric === "sales" ? <AmountsToggle hidden={amounts.hidden} onToggle={amounts.toggle} /> : undefined} />
          <div className="mt-5">
            {metric === "listings" ? <ListingCards work={null} loading /> : <SalesCards summaries={[]} loading hidden={amounts.hidden} />}
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
              <PillTabs
                role="radiogroup"
                label="Market"
                tabs={[{ id: "all", flag: "", label: "All markets", accounts: o.perAccount.length }, ...markets].map((m) => ({ key: m.id, label: m.label, icon: m.flag || undefined, count: m.accounts }))}
                value={current}
                onChange={setMarket}
              />
            ) : (
              <p className="text-[13px] text-[var(--color-muted)]">
                Sales figures for <span className="font-medium text-[var(--color-ink)]">{rangePhrase.replace(/^in /, "")}</span>
              </p>
            )}
            <div className="flex min-w-0 max-w-full items-center gap-3">
              {refreshing && <span className="text-[12px] text-[var(--color-muted)]">Updating…</span>}
              <PillTabs role="radiogroup" label="Dates" tabs={RANGES} value={range} onChange={changeRange} />
            </div>
          </div>

          <MetricTabs metric={metric} onMetric={setMetric} trailing={metric === "sales" ? <AmountsToggle hidden={amounts.hidden} onToggle={amounts.toggle} /> : undefined} />
          <div className="mt-5">
            {metric === "listings" ? <ListingCards work={listingWork} /> : <SalesCards summaries={moneyInView} hidden={amounts.hidden} />}
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

          {/* How listing work moved, and what went live. */}
          {metric === "listings" && (
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="min-w-0 lg:col-span-2">
                <ListingTrendCard points={addListingTrends(inView.map((m) => m.listingTrend))} caption={trendCaption} />
              </div>
              <RecentListingsCard
                items={inView
                  .flatMap((m) => m.recentListings ?? [])
                  .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
                  .slice(0, 5)}
                showMarket={current === "all" && markets.length > 1}
                flagOf={(id) => markets.find((m) => m.id === id)?.flag ?? ""}
                empty={range === "today" ? "Nothing published from Liston today yet." : undefined}
              />
            </div>
          )}
          {/* How much is on which account. */}
          {metric === "listings" && accounts.length > 1 && <AccountListingsCard accounts={accounts} datesLabel={datesLabel} showMarket={current === "all" && markets.length > 1} />}

          {/* How sales moved, and what sold most. */}
          {metric === "sales" && (
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="min-w-0 lg:col-span-2">
                <SalesTrendCard points={trendInView} currency={trendCurrency} hidden={amounts.hidden} caption={trendCaption} note={trendNote} />
              </div>
              <BestSellersCard items={bestInView} hidden={amounts.hidden} showMarket={current === "all" && markets.length > 1} flagOf={(id) => markets.find((m) => m.id === id)?.flag ?? ""} />
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
