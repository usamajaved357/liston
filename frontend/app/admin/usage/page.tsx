"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
  error: { label: "Stopped early", className: "chip chip-warning" },
};

// The traffic report's own allowance: far smaller than Trading's, so each
// account's traffic is read once a day and kept (see analytics-budget).
function AnalyticsUsageSection({ usage }: { usage: AnalyticsUsage }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">eBay traffic data (Analytics API)</h2>
        <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">
          A separate allowance of {usage.limit.toLocaleString()} calls a day for impressions and views, shared by every account. Each account is read once a day, next at{" "}
          {fmtTime(usage.nextSyncAt)}; resets {fmtTime(usage.resetAt)}.
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
            { at: 60, title: "Filling in older days pauses here" },
            { at: 90, title: "The daily update pauses here" },
          ]}
        />
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--color-muted)]">
          <span>60% · filling in older days pauses{usage.paused.backfill ? " (paused now)" : ""}</span>
          <span>90% · daily update pauses{usage.paused.sync ? " (paused now)" : ""}</span>
          <span>Last 10% · kept for &quot;Refresh today&quot; ({usage.refreshesPerAccount} per account a day)</span>
        </div>
        {usage.exhausted && <p className="mt-3 text-sm font-semibold text-[var(--color-danger)]">eBay has refused further traffic calls today. Analytics pages keep showing their stored history.</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Remaining" value={usage.remaining.toLocaleString()} sub="traffic calls until reset" />
        <Tile label="Daily updates" value={usage.byKind.sync.toLocaleString()} sub="yesterday's figures per account" />
        <Tile label="Filling in history" value={usage.byKind.backfill.toLocaleString()} sub="older days, from spare allowance" />
        <Tile label="Refresh today" value={usage.byKind.refresh.toLocaleString()} sub="pressed by sellers" />
      </div>

      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-paper)] text-left text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
            <tr>
              <th className="px-5 py-2.5 font-semibold">Account</th>
              <th className="px-3 py-2.5 text-right font-semibold">Calls today</th>
              <th className="px-3 py-2.5 font-semibold">Per-listing history</th>
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
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--color-line)]">
                        <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${Math.min(100, (a.listingDays / a.listingDaysTotal) * 100)}%` }} />
                      </div>
                      <span className="text-xs tabular-nums text-[var(--color-muted)]">
                        {a.listingDays}/{a.listingDaysTotal} days
                      </span>
                    </div>
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

export default function EbayUsagePage() {
  const router = useRouter();
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
            <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
              One daily allowance shared by every account on Liston. Resets {usage ? fmtTime(usage.resetAt) : "…"}.
            </p>
          </div>
          <button type="button" onClick={syncNow} disabled={syncing} className="btn btn-secondary btn-sm">
            {syncing ? "Asking eBay…" : "Check with eBay"}
          </button>
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
      ) : (
        <div className="space-y-6">
          <h2 className="-mb-2 text-[15px] font-semibold text-[var(--color-ink)]">Trading API</h2>
          <div className="card px-5 py-4">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-semibold text-[var(--color-ink)]">
                {usage.used.toLocaleString()} of {usage.limit.toLocaleString()} calls used today
              </p>
              <p className="text-xs text-[var(--color-muted)]">
                {usage.lastSyncedWithEbay ? `Confirmed with eBay ${fmtTime(usage.lastSyncedWithEbay)}` : "Not yet confirmed with eBay"}
              </p>
            </div>
            <div className="relative mt-3 h-3 overflow-hidden rounded-full bg-[var(--color-line)]">
              <div className={`h-full rounded-full ${barColour}`} style={{ width: `${pct}%` }} />
              <div className="absolute inset-y-0 w-px bg-[var(--color-ink)]/30" style={{ left: "80%" }} title="Background re-reads pause here" />
              <div className="absolute inset-y-0 w-px bg-[var(--color-ink)]/30" style={{ left: "92%" }} title="eBay-push re-reads pause here" />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--color-muted)]">
              <span>80% · background re-reads pause{usage.paused.background ? " (paused now)" : ""}</span>
              <span>92% · push re-reads pause{usage.paused.push ? " (paused now)" : ""}</span>
              <span>Last 8% · kept for publishing and manual refresh</span>
            </div>
            {usage.exhausted && (
              <p className="mt-3 text-sm font-semibold text-[var(--color-danger)]">
                eBay has refused further calls for today. Pages keep showing their last copy until the reset.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Tile label="Remaining" value={usage.remaining.toLocaleString()} sub="calls until reset" />
            <Tile label="Held back" value={(usage.deferred.background + usage.deferred.push).toLocaleString()} sub="re-reads skipped to protect the allowance" />
            <Tile label="In flight" value={String(usage.inFlight)} sub={`${usage.waiting} waiting for a slot`} />
            <Tile
              label="Push notifications"
              value={`${usage.byAccount.filter((a) => a.push).length + 0} / ${usage.accountsTotal}`}
              sub={usage.notificationsUrl ? "accounts subscribed" : "not configured on this server"}
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
                        {a.push && <span className="ml-2 chip chip-primary">push</span>}
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

          {usage.analytics && <AnalyticsUsageSection usage={usage.analytics} />}
        </div>
      )}
    </AppShell>
  );
}
