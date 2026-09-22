"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnalyticsUsage, api, ApiError, EbayUsage, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cacheUser, useCachedUser } from "@/lib/session";
import { Alert } from "@/components/Alert";

// How much of eBay's shared daily allowance Liston has used today, and
// where it went. The allowance is per app, not per account, so this is
// the one place to see trouble coming before every account goes dark.

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card px-5 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{label}</p>
      <p className="mt-1 text-2xl font-bold text-[var(--color-ink)]">{value}</p>
      {sub && <p className="text-xs text-[var(--color-muted)]">{sub}</p>}
    </div>
  );
}

function UsageBar({ used, limit, marks, exhausted }: { used: number; limit: number; marks: { at: number; title: string }[]; exhausted: boolean }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const colour = exhausted || pct >= 92 ? "bg-[var(--color-danger)]" : pct >= 80 ? "bg-[var(--color-warning)]" : "bg-[var(--color-accent)]";
  return (
    <div className="relative mt-3 h-3 overflow-hidden rounded-full bg-[var(--color-line)]">
      <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      {marks.map((m) => (
        <div key={m.at} className="absolute inset-y-0 w-px bg-[var(--color-ink)]/30" style={{ left: `${m.at}%` }} title={m.title} />
      ))}
    </div>
  );
}

const ANALYTICS_STATUS: Record<AnalyticsUsage["byAccount"][number]["status"], { label: string; className: string }> = {
  ok: { label: "Up to date", className: "chip chip-accent" },
  reconnect: { label: "Needs reconnect", className: "chip chip-warning" },
  unsupported: { label: "Site not covered", className: "chip" },
  waiting: { label: "After the reset", className: "chip" },
  error: { label: "Stopped early", className: "chip chip-warning" },
};

// The traffic report's own allowance: far smaller than Trading's, so each
// account's traffic is read once a day and kept (see analytics-budget).
function AnalyticsUsageSection({ usage }: { usage: AnalyticsUsage }) {
  return (
    <section className="space-y-4">
      <div>
        <p className="text-[12.5px] text-[var(--color-muted)]">
          A separate allowance of {usage.limit.toLocaleString()}
          {" "}calls a day for impressions and views, shared by every account. Each night (02:00 in the account&apos;s time zone) an account&apos;s totals and
          every listing&apos;s figures for the day just ended are read and stored; filters add up stored days and never call eBay. Older days of listing
          history (92) fill only in the last two hours before the reset, from allowance that would otherwise expire. Resets {fmtTime(usage.resetAt)}.
        </p>
      </div>
      <div className="card px-5 py-4">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-semibold text-[var(--color-ink)]">
            {usage.used.toLocaleString()} of {usage.limit.toLocaleString()} traffic calls used today
          </p>
          <p className="text-xs text-[var(--color-muted)]">{usage.lastSyncedWithEbay ? `Confirmed with eBay ${fmtTime(usage.lastSyncedWithEbay)}` : "Counted by Liston"}</p>
        </div>
        <UsageBar
          used={usage.used}
          limit={usage.limit}
          exhausted={usage.exhausted}
          marks={[
            { at: 70, title: "The nightly update pauses here" },
            { at: 90, title: "Load all and single-listing reads pause here" },
            { at: 95, title: "Filling history stops here" },
          ]}
        />
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--color-muted)]">
          <span>70% · nightly update pauses{usage.paused.sync ? " (paused now)" : ""}</span>
          <span>90% · Load all and single-listing reads pause{usage.paused.view ? " (paused now)" : ""}</span>
          <span>Up to 95% · history fill, {usage.spareWindow.open ? "running now (leftover allowance)" : `only from ${fmtTime(usage.spareWindow.opensAt)}, from leftover allowance`}</span>
          <span>Last 10% · &quot;Refresh today&quot; ({usage.refreshesPerAccount} per account a day)</span>
        </div>
        {usage.exhausted && <p className="mt-3 text-sm font-semibold text-[var(--color-danger)]">eBay has refused further traffic calls today. Analytics pages keep showing their stored history.</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Remaining" value={usage.remaining.toLocaleString()} sub="traffic calls until reset" />
        <Tile label="Nightly update" value={usage.byKind.sync.toLocaleString()} sub="each account's day just ended" />
        <Tile label="History fill" value={(usage.byKind.history ?? 0).toLocaleString()} sub="leftover allowance, once per account" />
        <Tile label="On request · refresh" value={`${usage.byKind.view.toLocaleString()} · ${usage.byKind.refresh.toLocaleString()}`} sub="Load all, one listing · Refresh today" />
      </div>

      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-paper)] text-left text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
            <tr>
              <th className="px-5 py-2.5 font-semibold">Account</th>
              <th className="px-3 py-2.5 text-right font-semibold">Calls today</th>
              <th className="px-3 py-2.5 font-semibold">Listing history</th>
              <th className="px-3 py-2.5 font-semibold">Complete to</th>
              <th className="px-3 py-2.5 text-right font-semibold">Refreshes</th>
              <th className="px-5 py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {usage.byAccount.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-6 text-center text-[var(--color-muted)]">
                  No account has been read yet. The first read happens at the next daily update or when someone opens Analytics.
                </td>
              </tr>
            )}
            {usage.byAccount.map((a) => {
              const status = ANALYTICS_STATUS[a.status];
              return (
                <tr key={a.connectionId}>
                  <td className="px-5 py-2.5 text-[var(--color-ink)]">{a.label}</td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-[var(--color-ink)]">{a.calls.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-xs tabular-nums text-[var(--color-muted)]" title="Days of every listing's figures stored; ranges inside them cost no calls">
                    {a.history ? (a.history.complete ? `Complete · ${a.history.needed} days` : `${a.history.stored} of ${a.history.needed} days`) : "—"}
                    {a.timeZone && <span className="ml-2 text-[var(--color-line-strong)]">{a.timeZone.replace("_", " ")}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-[var(--color-muted)]">{a.finalThrough ? new Date(`${a.finalThrough}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" }) : "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-muted)]">
                    {a.refreshesToday}/{usage.refreshesPerAccount}
                  </td>
                  <td className="px-5 py-2.5">
                    <span className={status.className} title={a.lastError || undefined}>
                      {status.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </section>
  );
}

type UsageTab = "trading" | "traffic";
const USAGE_TABS: { key: UsageTab; label: string }[] = [
  { key: "trading", label: "Trading API" },
  { key: "traffic", label: "Traffic API" },
];

function EbayUsageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // One allowance per tab; the tab lives in the URL so a reload keeps it.
  const [tab, setTab] = useState<UsageTab>(searchParams.get("tab") === "traffic" ? "traffic" : "trading");
  function changeTab(next: UsageTab) {
    setTab(next);
    router.replace(`/admin/usage${next === "traffic" ? "?tab=traffic" : ""}`, {
      scroll: false,
    });
  }
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;
  const [usage, setUsage] = useState<EbayUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.me(), api.getEbayUsage()])
      .then(([me, data]) => {
        if (!me.user.is_admin) {
          router.replace("/dashboard");
          return;
        }
        setUser(me.user);
        cacheUser(me.user);
        setUsage(data);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
        else if (err instanceof ApiError && err.status === 403) router.replace("/dashboard");
        else setError("Couldn't load eBay usage.");
      })
      .finally(() => setLoading(false));
  }, [router]);

  async function syncNow() {
    setSyncing(true);
    try {
      setUsage(await api.getEbayUsage(true));
    } catch {
      setError("Couldn't read the figure from eBay.");
    } finally {
      setSyncing(false);
    }
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-10">
        <PageSkeleton />
      </main>
    );
  }

  const pct = usage ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  const barColour = usage?.exhausted || pct >= 92 ? "bg-[var(--color-danger)]" : pct >= 80 ? "bg-[var(--color-warning)]" : "bg-[var(--color-accent)]";

  return (
    <AppShell
      connectionsUsed={Number(user.connections_used ?? 0)}
      maxConnections={user.max_connections ?? 0}
      planName={user.plan_name ?? "Unassigned"}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-ink)]">eBay usage</h1>
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">eBay&apos;s daily call allowances, each shared by every account on Liston.</p>
          </div>
          <button type="button" onClick={syncNow} disabled={syncing} className="btn btn-secondary btn-sm">
            {syncing ? "Asking eBay…" : "Check with eBay"}
          </button>
        </div>
      }
      subheader={
        <div className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
          {USAGE_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => changeTab(t.key)}
              className={`flex h-7 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium transition-colors ${
                tab === t.key ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              }`}
            >
              {t.label}
              {usage && (
                <span className={tab === t.key ? "text-white/70" : "text-[var(--color-muted)]/70"}>
                  {t.key === "trading" ? `${Math.round((usage.used / usage.limit) * 100)}%` : usage.analytics ? `${Math.round((usage.analytics.used / usage.analytics.limit) * 100)}%` : ""}
                </span>
              )}
            </button>
          ))}
        </div>
      }
    >
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}

      {loading || !usage ? (
        <PageSkeleton rows={2} />
      ) : tab === "traffic" ? (
        usage.analytics ? (
          <AnalyticsUsageSection usage={usage.analytics} />
        ) : (
          <Alert>Traffic figures aren&apos;t available from this server yet.</Alert>
        )
      ) : (
        <div className="space-y-6">
          <div className="space-y-4">
            <p className="text-[12.5px] text-[var(--color-muted)]">Listings, orders and publishing, shared by every account. Resets {fmtTime(usage.resetAt)}.</p>
            <div className="card px-5 py-4">
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-semibold text-[var(--color-ink)]">
                  {usage.used.toLocaleString()} of {usage.limit.toLocaleString()} calls used today
                </p>
                <p className="text-xs text-[var(--color-muted)]">{usage.lastSyncedWithEbay ? `Confirmed with eBay ${fmtTime(usage.lastSyncedWithEbay)}` : "Not yet confirmed with eBay"}</p>
              </div>
              <div className="relative mt-3 h-3 overflow-hidden rounded-full bg-[var(--color-line)]">
                <div className={`h-full rounded-full ${barColour}`} style={{ width: `${pct}%` }} />
                <div className="absolute inset-y-0 w-px bg-[var(--color-ink)]/30" style={{ left: "80%" }} title="Background re-reads pause here" />
                <div className="absolute inset-y-0 w-px bg-[var(--color-ink)]/30" style={{ left: "92%" }} title="eBay-push re-reads pause here" />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--color-muted)]">
                <span>
                  80% · background re-reads pause
                  {usage.paused.background ? " (paused now)" : ""}
                </span>
                <span>
                  92% · push re-reads pause
                  {usage.paused.push ? " (paused now)" : ""}
                </span>
                <span>Last 8% · kept for publishing and manual refresh</span>
              </div>
              {usage.exhausted && (
                <p className="mt-3 text-sm font-semibold text-[var(--color-danger)]">eBay has refused further calls for today. Pages keep showing their last copy until the reset.</p>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Tile label="Remaining" value={usage.remaining.toLocaleString()} sub="calls until reset" />
            <Tile label="Held back" value={(usage.deferred.background + usage.deferred.push).toLocaleString()} sub="re-reads skipped to protect the allowance" />
            <Tile label="In flight" value={String(usage.inFlight)} sub={`${usage.waiting} waiting for a slot`} />
            <Tile
              label="Live eBay push"
              value={`${usage.orderPushLive} · ${usage.listingPushLive} / ${usage.accountsTotal}`}
              sub={usage.orderPushConfigured ? "orders · listings, accounts eBay pushed to (2 days)" : "not set up on this server"}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card px-5 py-4">
              <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">By account</h2>
              {usage.byAccount.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--color-muted)]">No account has needed eBay yet today.</p>
              ) : (
                <ul className="mt-2 divide-y divide-[var(--color-line)]">
                  {usage.byAccount.map((a) => (
                    <li key={a.connectionId} className="flex items-center justify-between py-2 text-sm">
                      <span className="text-[var(--color-ink)]">
                        {a.label}
                        {a.push && <span className="ml-2 chip chip-primary">live orders</span>}
                      </span>
                      <span className="font-semibold text-[var(--color-ink)]">{a.count.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card px-5 py-4">
              <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">By call</h2>
              <ul className="mt-2 divide-y divide-[var(--color-line)]">
                {usage.byCall.map((c) => (
                  <li key={c.name} className="flex items-center justify-between py-2 text-sm">
                    <span className="font-mono text-[12px] text-[var(--color-ink)]">{c.name}</span>
                    <span className="font-semibold text-[var(--color-ink)]">{c.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      )}
    </AppShell>
  );
}

// useSearchParams (the tab is in the URL) needs a Suspense boundary above it.
export default function EbayUsagePage() {
  return (
    <Suspense fallback={null}>
      <EbayUsageInner />
    </Suspense>
  );
}
