"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, Connection, MemberActivityItem, MemberOverview, PermissionUpdate, TeamMember, TeamMetricKey, TeamRange, User } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { PageSkeleton } from "@/components/PageSkeleton";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { dayRangeLabel } from "@/components/charts/chart-format";
import { cacheUser, useCachedUser } from "@/lib/session";
import { formatMoney, formatShortDate } from "@/lib/format";
import { downloadCsv, toCsv } from "@/lib/csv";
import { AccessGrid, LoginDetails, MemberAvatar, ResetPasswordDialog, Switch, timeAgo } from "@/components/team/team-shared";
import { MemberPerformance } from "@/components/team/MemberPerformance";

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
  { key: "order.supplier_updated", label: "Supplier order updates" },
  { key: "order.note", label: "Notes" },
  { key: "order.archived", label: "Archived orders" },
  { key: "listing.checked", label: "Deeper checks" },
  { key: "listing.draft_deleted", label: "Deleted drafts" },
  { key: "account.store_category_added", label: "Shop categories added" },
  { key: "account.source_account_saved", label: "Supplier accounts saved" },
  { key: "hunt.resubmitted", label: "Hunted products resubmitted" },
  { key: "hunt.updated", label: "Hunted products changed" },
  { key: "hunt.withdrawn", label: "Hunted products withdrawn" },
  { key: "hunt.removed", label: "Hunted products removed" },
  { key: "session.login", label: "Logins" },
];

function Tabs({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  const tabs: { key: Tab; label: string }[] = [
    { key: "performance", label: "Performance" },
    { key: "activity", label: "Activity" },
    { key: "access", label: "Access" },
  ];
  return (
    <div role="tablist" className="flex w-full gap-1 border-b border-[var(--color-line)] sm:w-auto">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={`-mb-px flex-1 border-b-2 px-3.5 py-2.5 text-[14px] font-medium transition-colors sm:flex-none sm:py-2 sm:text-[13px] ${
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
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
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
          className="flex w-full items-center gap-1.5 sm:w-auto"
          onSubmit={(e) => {
            e.preventDefault();
            if (from && to) onChange("custom", { from, to });
          }}
        >
          <input type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} className="input input-sm min-w-0 flex-1 sm:w-auto sm:flex-none" aria-label="From" />
          <span className="text-[12px] text-[var(--color-muted)]">to</span>
          <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className="input input-sm min-w-0 flex-1 sm:w-auto sm:flex-none" aria-label="To" />
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

// A moment in the owner's time zone — the same days the figures and charts
// count in, whatever the viewer's own clock says.
function inZone(iso: string, timeZone: string | undefined) {
  const d = new Date(iso);
  const tz = timeZone ? { timeZone } : {};
  return {
    label: `${d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...tz })}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", ...tz })}`,
    date: d.toLocaleDateString("en-CA", tz),
    time: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...tz }),
  };
}

// What kind of work an entry is, for its icon: orders, listings, hunting, logins, account.
function kindStyle(kind: string): { tile: string; icon: React.ReactNode } {
  const area = kind.split(".")[0];
  if (area === "order")
    return { tile: "bg-sky-50 text-sky-600 ring-sky-200", icon: <path d="M3.5 7L10 3.5 16.5 7v6.5L10 17l-6.5-3.5V7zM3.5 7L10 10.5 16.5 7M10 10.5V17" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /> };
  if (area === "listing")
    return { tile: "bg-violet-50 text-violet-600 ring-violet-200", icon: <path d="M4 9.5V5a1 1 0 011-1h4.5l6.5 6.5-5.5 5.5L4 9.5zM7.3 7.3h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> };
  if (area === "hunt")
    return { tile: "bg-amber-50 text-amber-600 ring-amber-200", icon: <><circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.6" /><circle cx="10" cy="10" r="2.3" stroke="currentColor" strokeWidth="1.6" /></> };
  if (area === "session")
    return { tile: "bg-slate-50 text-slate-500 ring-slate-200", icon: <path d="M8 4H5.5A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16H8M12 6.5L15.5 10 12 13.5M15.5 10H8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> };
  return { tile: "bg-teal-50 text-teal-600 ring-teal-200", icon: <path d="M3.5 8l1.5-4h10l1.5 4M3.5 8v8h13V8M3.5 8h13M8 16v-4h4v4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /> };
}

// The log in days (the owner's), newest first: Today, Yesterday, then dates.
function groupByDay(items: MemberActivityItem[], timeZone: string | undefined) {
  const today = inZone(new Date().toISOString(), timeZone).date;
  const yesterday = inZone(new Date(Date.now() - 86400000).toISOString(), timeZone).date;
  const groups: { date: string; label: string; items: MemberActivityItem[] }[] = [];
  for (const i of items) {
    const date = inZone(i.at, timeZone).date;
    let g = groups[groups.length - 1];
    if (!g || g.date !== date) {
      const label =
        date === today
          ? "Today"
          : date === yesterday
            ? "Yesterday"
            : new Date(i.at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(timeZone ? { timeZone } : {}) });
      g = { date, label, items: [] };
      groups.push(g);
    }
    g.items.push(i);
  }
  return groups;
}

function subjectLink(item: MemberActivityItem): string | null {
  if (!item.connectionId) return null;
  if (item.subjectType === "order") return `/accounts/${item.connectionId}/orders/${encodeURIComponent(item.subjectId)}`;
  if (item.subjectType === "listing") return `/accounts/${item.connectionId}/listings?q=${encodeURIComponent(item.subjectId)}`;
  if (item.subjectType === "hunt" && item.kind !== "hunt.withdrawn" && item.kind !== "hunt.removed") return `/accounts/${item.connectionId}/hunting?open=${encodeURIComponent(item.subjectId)}`;
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
  const [more, setMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);
  const params = useMemo(() => ({ range, ...(range === "custom" ? custom : {}), kind: kind || undefined, connectionId: connectionId || undefined }), [range, custom, kind, connectionId]);
  // Loading until the request for these filters has answered.
  const requestKey = JSON.stringify([memberId, params]);
  const [answered, setAnswered] = useState<string | null>(null);
  const loading = answered !== requestKey;

  useEffect(() => {
    let cancelled = false;
    api
      .getMemberActivity(memberId, params)
      .then((d) => {
        if (cancelled) return;
        setItems(d.items);
        setNext(d.next);
        setTimeZone(d.range.timeZone);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn't load the activity."))
      .finally(() => !cancelled && setAnswered(requestKey));
    return () => {
      cancelled = true;
    };
  }, [memberId, params, requestKey]);

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
        const at = inZone(i.at, d.range.timeZone);
        return [
          at.date,
          at.time,
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
      downloadCsv(`${slug}-activity-${d.range.from}-to-${d.range.to}.csv`, toCsv([`Date (${d.range.timeZone})`, "Time", "eBay account", "Action", "Order", "Order line", "Item number", "Title", "Amount", "Currency"], rows));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <select value={kind} onChange={(e) => onKind(e.target.value)} className="input input-sm min-w-0 flex-1 sm:w-auto sm:flex-none" aria-label="What">
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
          <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className="input input-sm min-w-0 flex-1 sm:w-auto sm:flex-none" aria-label="eBay account">
            <option value="">All accounts</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        <button type="button" onClick={exportCsv} disabled={exporting || items.length === 0} className="btn btn-secondary btn-sm flex-shrink-0 sm:ml-auto">
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
        <div className="border-t border-[var(--color-line)]">
          {groupByDay(items, timeZone).map((g) => (
            <div key={g.date}>
              <p className="sticky top-0 z-[1] border-b border-[var(--color-line)] bg-[var(--color-paper)]/95 px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)] backdrop-blur">
                {g.label}
                <span className="ml-1.5 font-medium normal-case tracking-normal">· {g.items.length} action{g.items.length === 1 ? "" : "s"}</span>
              </p>
              <ul className="divide-y divide-[var(--color-line)]">
                {g.items.map((i) => {
                  const href = subjectLink(i);
                  const subject = i.subjectType === "order" ? `Order ${i.subjectId}` : i.subjectType === "listing" ? `#${i.subjectId}` : i.subjectType === "draft" ? "Draft" : null;
                  const k = kindStyle(i.kind);
                  const at = inZone(i.at, timeZone);
                  return (
                    <li key={i.id} className="flex items-start gap-3 px-4 py-2.5">
                      <span className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${k.tile}`} aria-hidden>
                        <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5">
                          {k.icon}
                        </svg>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] text-[var(--color-ink)]">
                          <span className="font-medium">{i.label}</span>
                          {subject && <span className="text-[var(--color-muted)]"> · </span>}
                          {!subject ? null : href ? (
                            <Link href={href} className="font-mono text-[11.5px] text-[var(--color-primary)] hover:underline">
                              {subject}
                            </Link>
                          ) : (
                            <span className="font-mono text-[11.5px] text-[var(--color-muted)]">{subject}</span>
                          )}
                        </p>
                        {(i.title || (i.kind === "order.note" && typeof i.detail.text === "string")) && (
                          <p className="mt-0.5 truncate text-[11.5px] text-[var(--color-muted)]">{i.kind === "order.note" && typeof i.detail.text === "string" ? `\u201c${i.detail.text}\u201d` : i.title}</p>
                        )}
                        <p className="mt-0.5 text-[11px] text-[var(--color-muted)] sm:hidden">
                          {[i.connectionLabel, i.amount != null ? formatMoney({ amount: i.amount, currency: i.currency || undefined }) : null].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <p className="text-[11.5px] tabular-nums text-[var(--color-muted)]" title={timeZone ? `${timeZone} time` : undefined}>
                          {at.time}
                        </p>
                        {i.amount != null && <p className="hidden text-[12px] font-medium tabular-nums text-[var(--color-ink)] sm:block">{formatMoney({ amount: i.amount, currency: i.currency || undefined })}</p>}
                        <p className="hidden max-w-[140px] truncate text-[11px] text-[var(--color-muted)] sm:block">{i.connectionLabel}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
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
  // Loading until the figures for this member and range have answered.
  const figuresKey = JSON.stringify([memberId, range, custom]);
  const [answered, setAnswered] = useState<string | null>(null);
  const loading = answered !== figuresKey;
  const [resetOpen, setResetOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ email: string; password: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (range === "custom" && (!custom.from || !custom.to)) return;
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
      setAnswered(figuresKey);
    }
  }, [memberId, range, custom, router, figuresKey]);

  useEffect(() => {
    if (!localStorage.getItem("token")) {
      router.replace("/login");
      return;
    }
    // After this render: loading shows from the figures' key, not from state set here.
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
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
      <main className="min-h-screen bg-[var(--color-paper)] p-4 sm:p-10">
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
          <Link
            href="/team"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-[var(--color-line)] text-[var(--color-muted)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
            aria-label="Back to Team"
            title="Back to Team"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          {member && <MemberAvatar member={member} size={46} />}
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 truncate text-lg font-semibold text-[var(--color-ink)]">
              {name || "Team member"}
              {removed && <span className="chip text-[11px] font-medium text-[var(--color-muted)]">Removed {formatShortDate(member!.deactivated_at!)}</span>}
            </h1>
            {member && (
              <p className="line-clamp-2 text-[12.5px] text-[var(--color-muted)] sm:line-clamp-none sm:truncate">
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
              <div className="flex items-center gap-1.5 max-sm:ml-auto">
                {!removed && (
                  <button type="button" onClick={() => setResetOpen(true)} className="btn btn-secondary btn-sm !h-8 gap-1.5 !px-3 !text-[12.5px]">
                    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                      <circle cx="7" cy="12.5" r="3.2" stroke="currentColor" strokeWidth="1.6" />
                      <path d="M9.3 10.2L16 3.5M13.5 6l1.8 1.8M11.8 7.7l1.4 1.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                    Change password
                  </button>
                )}
                {removed ? (
                  <button type="button" onClick={() => setRemoved(false)} disabled={busy} className="btn btn-primary btn-sm !h-8 !px-3 !text-[12.5px]">
                    {busy ? "Restoring…" : "Restore access"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(true)}
                    aria-label="Remove access"
                    title="Remove access"
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-muted)] transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
                      <path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.2a1 1 0 001 .8h4.6a1 1 0 001-.8L14 6M8.5 9v4.5M11.5 9v4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            {tab !== "access" && (
              <div className={`mb-4 flex flex-wrap items-center justify-between gap-2 ${loading ? "opacity-60" : ""}`}>
                <RangePicker
                  key={`${custom.from}:${custom.to}`}
                  range={range}
                  custom={custom}
                  onChange={(r, c) => setQuery({ range: r === "7d" ? null : r, from: c?.from || null, to: c?.to || null })}
                />
                <span className="text-[12px] text-[var(--color-muted)]">{dayRangeLabel(data.range.from, data.range.to)}</span>
              </div>
            )}

            {tab === "performance" && (
              <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
                <MemberPerformance key={`${data.range.from}:${data.range.to}`} data={data} onOpenLog={(k) => setQuery({ tab: "activity", kind: k })} />
              </div>
            )}
            {tab === "activity" && (
              <ActivityLog recordingSince={data.recordingSince} memberId={memberId} name={name} range={range} custom={custom} connections={data.connections} metrics={data.metrics} kind={kind} onKind={(k) => setQuery({ kind: k || null })} />
            )}
            {tab === "access" && memberForGrid && (
              <div className="card overflow-hidden">
                <div className="px-5 py-4">
                  <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">What {member!.name || "they"} can use</h2>
                  <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">
                    {removed
                      ? "Kept as it was, and back in force if you restore them."
                      : "Switch an area on for every account, then tap an account to set it apart. Changes save straight away and apply from their next click."}
                  </p>
                </div>
                <div className="border-t border-[var(--color-line)]">
                  <AccessGrid member={memberForGrid} connections={connections.filter((c) => c.platform_key === "ebay")} knownFeatures={data.knownFeatures} onChange={changeAccess} />
                </div>
                {/* Team chat is everyone's; running its channels is the owner's unless given. */}
                <ChatManageRow permissions={memberForGrid.permissions || []} name={member!.name || "they"} disabled={removed} onChange={changeAccess} />
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

function ChatManageRow({ permissions, name, disabled, onChange }: { permissions: { connection_id: string | null; feature: string; allowed: boolean }[]; name: string; disabled: boolean; onChange: (updates: PermissionUpdate[]) => Promise<void> }) {
  const on = permissions.some((p) => p.feature === "chat_manage" && p.connection_id === null && p.allowed);
  const [busy, setBusy] = useState(false);
  async function flip() {
    setBusy(true);
    try {
      await onChange([{ connectionId: null, feature: "chat_manage", allowed: !on }]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex items-center gap-3 border-t border-[var(--color-line)] px-5 py-3">
      <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[15px] font-bold ring-1 ring-inset ${on ? "bg-emerald-50 text-emerald-600 ring-emerald-200" : "bg-[var(--color-paper)] text-[var(--color-muted)] ring-[var(--color-line)]"}`} aria-hidden>
        #
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-[var(--color-ink)]">Manage team chat channels</p>
        <p className="text-[11.5px] text-[var(--color-muted)]">Everyone has team chat. With this, {name} can also make, rename, archive and delete channels and choose who&apos;s in them.</p>
      </div>
      <span className={`hidden text-[11.5px] font-medium sm:inline ${on ? "text-emerald-700" : "text-[var(--color-muted)]"}`}>{on ? "On" : "Off"}</span>
      <Switch on={on} disabled={disabled || busy} onChange={flip} label="Manage team chat channels" />
    </div>
  );
}
