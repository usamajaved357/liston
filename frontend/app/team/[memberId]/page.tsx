"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, Connection, MemberActivityItem, MemberOverview, PermissionUpdate, TeamMember, TeamMetricKey, TeamRange, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { KpiTile } from "@/components/charts/KpiTile";
import { TrendChart } from "@/components/charts/TrendChart";
import { dayRangeLabel, fullNumber } from "@/components/charts/chart-format";
import { cacheUser, useCachedUser } from "@/lib/session";
import { formatDateTime, formatMoney, formatShortDate } from "@/lib/format";
import { downloadCsv, toCsv } from "@/lib/csv";
import { AccessGrid, LoginDetails, MemberAvatar, ResetPasswordDialog, timeAgo } from "@/components/team/team-shared";

// One team member's page: what they did (figures for any range against the
// period before, day by day and per eBay account), the full activity log
// with a CSV for pay, and their access. Everything counts in the owner's
// days; an order line or listing counts once per range.

type Tab = "performance" | "activity" | "access";

const RANGE_OPTIONS: { key: TeamRange; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "custom", label: "Custom" },
];

// The log's filter: every figure, then the smaller things people do.
const EXTRA_KINDS: { key: string; label: string }[] = [
  { key: "order.note", label: "Notes" },
  { key: "order.archived", label: "Archived orders" },
  { key: "listing.draft_deleted", label: "Deleted drafts" },
];

const change = (now: number, before: number) => (before > 0 ? (now - before) / before : null);

function Tabs({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  const tabs: { key: Tab; label: string }[] = [
    { key: "performance", label: "Performance" },
    { key: "activity", label: "Activity" },
    { key: "access", label: "Access" },
  ];
  return (
    <div role="tablist" className="flex gap-1 border-b border-[var(--color-line)]">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={`-mb-px border-b-2 px-3.5 py-2 text-[13px] font-medium transition-colors ${
            value === t.key ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// The range control: presets, or two dates for a custom range.
function RangePicker({ range, custom, onChange }: { range: TeamRange; custom: { from: string; to: string }; onChange: (range: TeamRange, custom?: { from: string; to: string }) => void }) {
  const [from, setFrom] = useState(custom.from);
  const [to, setTo] = useState(custom.to);
  const [open, setOpen] = useState(range === "custom");
  useEffect(() => {
    setFrom(custom.from);
    setTo(custom.to);
  }, [custom.from, custom.to]);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedControl
        label="Period"
        value={open ? "custom" : range}
        onChange={(key) => {
          if (key === "custom") setOpen(true);
          else {
            setOpen(false);
            onChange(key);
          }
        }}
        options={RANGE_OPTIONS}
      />
      {open && (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (from && to) onChange("custom", { from, to });
          }}
        >
          <input type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} className="input input-sm w-auto" aria-label="From" />
          <span className="text-[12px] text-[var(--color-muted)]">to</span>
          <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className="input input-sm w-auto" aria-label="To" />
          <button type="submit" disabled={!from || !to || from > to} className="btn btn-secondary btn-sm">
            Apply
          </button>
        </form>
      )}
    </div>
  );
}

// Why a period is empty: work only counts when done in Liston, and listing
// work only since Liston started noting who did it.
function NothingRecorded({ recordingSince, compact = false }: { recordingSince: string | null; compact?: boolean }) {
  const since = recordingSince ? new Date(recordingSince).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;
  return (
    <div className={compact ? "px-6 py-8 text-center" : "card px-6 py-12 text-center"}>
      <p className="text-sm font-medium text-[var(--color-ink)]">No recorded work in this period</p>
      <p className="mx-auto mt-1 max-w-xl text-[12.5px] leading-relaxed text-[var(--color-muted)]">
        Work counts when it&apos;s done in Liston: supplier orders saved and dispatches, refunds and cases handled from an order, and listings drafted, published, edited,
        relisted or ended. Work done straight on eBay or AliExpress can&apos;t be seen.
        {since && ` Liston notes who did each listing from ${since}; listings made before then aren't anyone's on record.`}
      </p>
    </div>
  );
}

function Performance({ data, onOpenLog }: { data: MemberOverview; onOpenLog: (kind: TeamMetricKey) => void }) {
  const [metric, setMetric] = useState<TeamMetricKey>(() => data.metrics.find((m) => data.totals[m.key] > 0)?.key || "supplier_orders");
  const compared = `vs ${dayRangeLabel(data.range.previous.from, data.range.previous.to)}`;
  const label = data.metrics.find((m) => m.key === metric)?.label || "";
  const points = data.series.map((p, i) => ({ day: p.day, value: p[metric], previous: data.previousSeries[i]?.[metric] ?? null, previousDay: data.previousSeries[i]?.day ?? null }));
  const shown = data.metrics.filter((m) => data.totals[m.key] > 0 || data.previous[m.key] > 0);
  const columns = shown.length ? shown : data.metrics.slice(0, 2);

  if (data.actions === 0 && Object.values(data.previous).every((v) => v === 0)) {
    return <NothingRecorded recordingSince={data.recordingSince} />;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data.metrics.map((m) => (
          <KpiTile
            key={m.key}
            label={m.label}
            value={fullNumber(data.totals[m.key])}
            change={change(data.totals[m.key], data.previous[m.key])}
            compared={compared}
            spark={data.series.length > 1 ? data.series.map((p) => p[m.key]) : undefined}
            selected={metric === m.key}
            onSelect={() => setMetric(m.key)}
          />
        ))}
      </div>

      {data.series.length > 1 && (
        <div className="card p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{label} per day</h2>
            <button type="button" onClick={() => onOpenLog(metric)} className="text-[12px] font-medium text-[var(--color-primary)] hover:underline">
              See each one in the log
            </button>
          </div>
          <TrendChart points={points} format={(v) => (v == null ? "—" : fullNumber(v))} label={label} variant="bars" currentLabel={dayRangeLabel(data.range.from, data.range.to)} previousLabel={dayRangeLabel(data.range.previous.from, data.range.previous.to)} />
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex items-baseline justify-between gap-2 px-4 py-3">
          <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">By eBay account</h2>
          <span className="text-[11.5px] text-[var(--color-muted)]">
            {fullNumber(data.actions)} action{data.actions === 1 ? "" : "s"} in all
          </span>
        </div>
        {data.accounts.length === 0 ? (
          <p className="border-t border-[var(--color-line)] px-4 py-4 text-[12.5px] text-[var(--color-muted)]">Nothing in this period.</p>
        ) : (
          <div className="overflow-x-auto border-t border-[var(--color-line)]">
            <table className="w-full min-w-[520px] text-[12.5px]">
              <thead>
                <tr className="bg-[var(--color-paper)] text-[10.5px] uppercase tracking-wide text-[var(--color-muted)]">
                  <th className="px-4 py-2 text-left font-semibold">Account</th>
                  {columns.map((m) => (
                    <th key={m.key} className="px-3 py-2 text-right font-semibold">
                      {m.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {data.accounts.map((a) => (
                  <tr key={a.connectionId || a.label}>
                    <td className="px-4 py-2.5 font-medium text-[var(--color-ink)]">
                      {a.label}
                      {!a.connectionId && <span className="ml-1.5 text-[11px] font-normal text-[var(--color-muted)]">(disconnected)</span>}
                    </td>
                    {columns.map((m) => (
                      <td key={m.key} className={`px-3 py-2.5 text-right tabular-nums ${a[m.key] ? "text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>
                        {fullNumber(a[m.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="text-[11.5px] leading-relaxed text-[var(--color-muted)]">
        Days run midnight to midnight in {data.range.timeZone.replace("_", " ")}. An order line or listing counts once per period however many times it was touched (re-saving a supplier
        order number isn&apos;t a second order); edits, drafts and cases count each time.
      </p>
    </div>
  );
}

function subjectLink(item: MemberActivityItem): string | null {
  if (!item.connectionId) return null;
  if (item.subjectType === "order") return `/accounts/${item.connectionId}/orders/${encodeURIComponent(item.subjectId)}`;
  if (item.subjectType === "listing") return `/accounts/${item.connectionId}/listings?q=${encodeURIComponent(item.subjectId)}`;
  return null;
}

function ActivityLog({ memberId, name, range, custom, connections, metrics, kind, onKind, recordingSince }: {
  memberId: string;
  recordingSince: string | null;
  name: string;
  range: TeamRange;
  custom: { from: string; to: string };
  connections: { id: string; label: string }[];
  metrics: { key: TeamMetricKey; label: string }[];
  kind: string;
  onKind: (k: string) => void;
}) {
  const [connectionId, setConnectionId] = useState("");
  const [items, setItems] = useState<MemberActivityItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const params = useMemo(() => ({ range, ...(range === "custom" ? custom : {}), kind: kind || undefined, connectionId: connectionId || undefined }), [range, custom, kind, connectionId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getMemberActivity(memberId, params)
      .then((d) => {
        if (cancelled) return;
        setItems(d.items);
        setNext(d.next);
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't load the activity."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [memberId, params]);

  async function loadMore() {
    if (!next) return;
    setMore(true);
    try {
      const d = await api.getMemberActivity(memberId, { ...params, before: next });
      setItems((prev) => [...prev, ...d.items]);
      setNext(d.next);
    } finally {
      setMore(false);
    }
  }

  // Everything in the range and filter (up to 5,000 rows), for pay or records.
  async function exportCsv() {
    setExporting(true);
    try {
      const d = await api.getMemberActivity(memberId, { ...params, limit: 5000 });
      const rows = d.items.map((i) => {
        const at = new Date(i.at);
        return [
          at.toLocaleDateString("en-CA"),
          at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
          i.connectionLabel,
          i.label,
          i.subjectType === "order" ? i.subjectId : null,
          i.subjectPart,
          i.subjectType === "listing" ? i.subjectId : null,
          i.title,
          i.amount,
          i.currency,
        ];
      });
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "member";
      downloadCsv(`${slug}-activity-${d.range.from}-to-${d.range.to}.csv`, toCsv(["Date", "Time", "eBay account", "Action", "Order", "Order line", "Item number", "Title", "Amount", "Currency"], rows));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <select value={kind} onChange={(e) => onKind(e.target.value)} className="input input-sm w-auto" aria-label="What">
          <option value="">All work</option>
          {metrics.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
          {EXTRA_KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
        {connections.length > 1 && (
          <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className="input input-sm w-auto" aria-label="eBay account">
            <option value="">All accounts</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        <button type="button" onClick={exportCsv} disabled={exporting || items.length === 0} className="btn btn-secondary btn-sm ml-auto">
          <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden>
            <path d="M12 4v11M7 10l5 5 5-5M5 20h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {exporting ? "Preparing…" : "CSV"}
        </button>
      </div>

      {error && <p className="border-t border-[var(--color-line)] px-4 py-3 text-[12.5px] text-[var(--color-danger)]">{error}</p>}
      {loading ? (
        <p className="border-t border-[var(--color-line)] px-4 py-6 text-[12.5px] text-[var(--color-muted)]">Loading…</p>
      ) : items.length === 0 ? (
        kind || connectionId ? (
          <p className="border-t border-[var(--color-line)] px-4 py-8 text-center text-[12.5px] text-[var(--color-muted)]">Nothing recorded for this period and filter.</p>
        ) : (
          <div className="border-t border-[var(--color-line)]">
            <NothingRecorded recordingSince={recordingSince} compact />
          </div>
        )
      ) : (
        <ul className="divide-y divide-[var(--color-line)] border-t border-[var(--color-line)]">
          {items.map((i) => {
            const href = subjectLink(i);
            const subject = i.subjectType === "order" ? `Order ${i.subjectId}` : i.subjectType === "listing" ? `#${i.subjectId}` : "Draft";
            return (
              <li key={i.id} className="flex items-start gap-3 px-4 py-2.5">
                <span className="w-24 flex-shrink-0 pt-px text-[11.5px] tabular-nums text-[var(--color-muted)]">{formatDateTime(i.at)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] text-[var(--color-ink)]">
                    <span className="font-medium">{i.label}</span>
                    <span className="text-[var(--color-muted)]"> · </span>
                    {href ? (
                      <Link href={href} className="font-mono text-[11.5px] text-[var(--color-primary)] hover:underline">
                        {subject}
                      </Link>
                    ) : (
                      <span className="font-mono text-[11.5px] text-[var(--color-muted)]">{subject}</span>
                    )}
                  </p>
                  {(i.title || (i.kind === "order.note" && typeof i.detail.text === "string")) && (
                    <p className="mt-0.5 truncate text-[11.5px] text-[var(--color-muted)]">{i.kind === "order.note" && typeof i.detail.text === "string" ? `“${i.detail.text}”` : i.title}</p>
                  )}
                </div>
                <div className="flex-shrink-0 text-right">
                  {i.amount != null && <p className="text-[12px] tabular-nums text-[var(--color-ink)]">{formatMoney({ amount: i.amount, currency: i.currency || undefined })}</p>}
                  <p className="text-[11px] text-[var(--color-muted)]">{i.connectionLabel}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <div className="border-t border-[var(--color-line)] px-4 py-2.5 text-center">
          <button type="button" onClick={loadMore} disabled={more} className="text-[12.5px] font-medium text-[var(--color-primary)] hover:underline">
            {more ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function MemberPageBody() {
  const router = useRouter();
  const { memberId } = useParams<{ memberId: string }>();
  const searchParams = useSearchParams();
  const cachedUser = useCachedUser();
  const [liveUser, setUser] = useState<User | null>(null);
  const user = liveUser ?? cachedUser;

  // Tab, range and log filter live in the URL: shareable, and kept on Back.
  const tab = (["performance", "activity", "access"].includes(searchParams.get("tab") || "") ? searchParams.get("tab") : "performance") as Tab;
  const range = (RANGE_OPTIONS.some((r) => r.key === searchParams.get("range")) ? searchParams.get("range") : "7d") as TeamRange;
  const custom = useMemo(() => ({ from: searchParams.get("from") || "", to: searchParams.get("to") || "" }), [searchParams]);
  const kind = searchParams.get("kind") || "";

  const setQuery = useCallback(
    (patch: Record<string, string | null>) => {
      const q = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) q.set(k, v);
        else q.delete(k);
      }
      router.replace(`/team/${memberId}?${q.toString()}`, { scroll: false });
    },
    [router, memberId, searchParams]
  );

  const [data, setData] = useState<MemberOverview | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetOpen, setResetOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ email: string; password: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (range === "custom" && (!custom.from || !custom.to)) return;
    setLoading(true);
    try {
      const [me, conns, overview] = await Promise.all([api.me(), api.listConnections(), api.getMemberOverview(memberId, range, custom)]);
      setUser(me.user);
      cacheUser(me.user);
      setConnections(conns.connections);
      setData(overview);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        localStorage.removeItem("token");
        router.replace("/login");
        return;
      }
      setError(err instanceof ApiError ? (err.status === 404 ? "This team member doesn't exist, or isn't on your team." : err.message) : "Couldn't load this team member.");
    } finally {
      setLoading(false);
    }
  }, [memberId, range, custom, router]);

  useEffect(() => {
    if (!localStorage.getItem("token")) {
      router.replace("/login");
      return;
    }
    load();
  }, [load, router]);

  async function changeAccess(updates: PermissionUpdate[]) {
    const { permissions } = await api.updateMemberPermissions(memberId, updates);
    setData((d) => (d ? { ...d, permissions, member: { ...d.member, permissions } } : d));
  }

  async function setRemoved(removed: boolean) {
    setBusy(true);
    try {
      if (removed) await api.removeTeamMember(memberId);
      else await api.restoreTeamMember(memberId);
      setConfirmRemove(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-10">
        <PageSkeleton />
      </main>
    );
  }

  const member = data?.member;
  const removed = Boolean(member?.deactivated_at);
  const name = member ? member.name || member.email : "";
  const memberForGrid: TeamMember | null = member && data ? { ...member, permissions: data.permissions } : null;

  return (
    <AppShell
      connectionsUsed={Number(user.connections_used ?? 0)}
      maxConnections={user.max_connections ?? 0}
      planName={user.plan_name ?? "Unassigned"}
      role={user.role}
      isAdmin={user.is_admin}
      header={
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/team" className="btn btn-ghost btn-icon flex-shrink-0" aria-label="Back to Team" title="Back to Team">
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          {member && <MemberAvatar member={member} size={36} />}
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 truncate text-lg font-semibold text-[var(--color-ink)]">
              {name || "Team member"}
              {removed && <span className="chip text-[11px] font-medium text-[var(--color-muted)]">Removed {formatShortDate(member!.deactivated_at!)}</span>}
            </h1>
            {member && (
              <p className="truncate text-[12.5px] text-[var(--color-muted)]">
                {member.name ? `${member.email} · ` : ""}added {formatShortDate(member.created_at)} · last login {timeAgo(member.last_login_at)} · last active {timeAgo(member.lastActiveAt)}
              </p>
            )}
          </div>
        </div>
      }
    >
      <div className="max-w-6xl">
        {error && (
          <div className="notice notice-danger mb-4">
            <span className="flex-1">{error}</span>
          </div>
        )}
        {revealed && (
          <div className="mb-4">
            <LoginDetails email={revealed.email} password={revealed.password} onDismiss={() => setRevealed(null)} />
          </div>
        )}

        {!data && loading ? (
          <PageSkeleton rows={2} />
        ) : !data ? null : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <Tabs value={tab} onChange={(t) => setQuery({ tab: t === "performance" ? null : t })} />
              <div className="flex items-center gap-2">
                {!removed && (
                  <button type="button" onClick={() => setResetOpen(true)} className="btn btn-secondary btn-sm">
                    Change password
                  </button>
                )}
                {removed ? (
                  <button type="button" onClick={() => setRemoved(false)} disabled={busy} className="btn btn-primary btn-sm">
                    {busy ? "Restoring…" : "Restore access"}
                  </button>
                ) : (
                  <button type="button" onClick={() => setConfirmRemove(true)} className="btn btn-danger-ghost btn-sm">
                    Remove access
                  </button>
                )}
              </div>
            </div>

            {tab !== "access" && (
              <div className={`mb-4 flex flex-wrap items-center justify-between gap-2 ${loading ? "opacity-60" : ""}`}>
                <RangePicker
                  range={range}
                  custom={custom}
                  onChange={(r, c) => setQuery({ range: r === "7d" ? null : r, from: c?.from || null, to: c?.to || null })}
                />
                <span className="text-[12px] text-[var(--color-muted)]">{dayRangeLabel(data.range.from, data.range.to)}</span>
              </div>
            )}

            {tab === "performance" && (
              <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
                <Performance key={`${data.range.from}:${data.range.to}`} data={data} onOpenLog={(k) => setQuery({ tab: "activity", kind: k })} />
              </div>
            )}
            {tab === "activity" && (
              <ActivityLog recordingSince={data.recordingSince} memberId={memberId} name={name} range={range} custom={custom} connections={data.connections} metrics={data.metrics} kind={kind} onKind={(k) => setQuery({ kind: k || null })} />
            )}
            {tab === "access" && memberForGrid && (
              <div className="card overflow-hidden">
                <div className="px-5 py-4">
                  <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">What {member!.name || "they"} can use</h2>
                  <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">
                    {removed ? "Kept as it was, and back in force if you restore them." : "Changes save straight away and apply from their next click."}
                  </p>
                </div>
                <div className="border-t border-[var(--color-line)]">
                  <AccessGrid member={memberForGrid} connections={connections.filter((c) => c.platform_key === "ebay")} knownFeatures={data.knownFeatures} onChange={changeAccess} />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <ResetPasswordDialog
        member={resetOpen && member ? member : null}
        onClose={() => setResetOpen(false)}
        onDone={(email, password) => {
          setResetOpen(false);
          setRevealed({ email, password });
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />
      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${name}'s access?`}
        description="They're signed out and can't log in from now on. Their work stays on record here, and you can restore them any time."
        confirmLabel="Remove access"
        danger
        loading={busy}
        onConfirm={() => setRemoved(true)}
        onCancel={() => setConfirmRemove(false)}
      />
    </AppShell>
  );
}

export default function MemberPage() {
  return (
    <Suspense fallback={null}>
      <MemberPageBody />
    </Suspense>
  );
}
