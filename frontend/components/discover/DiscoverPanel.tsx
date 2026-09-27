"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, DiscoverExplore, DiscoverOwnKeywords as OwnKeywords, DiscoverStart, DiscoverSubjectRef, DiscoverWatchList } from "@/lib/api";
import { Alert } from "@/components/Alert";
import { DiscoverStartView } from "./DiscoverStartView";
import { DiscoverSubjectView } from "./DiscoverSubjectView";
import { DiscoverWatchlist } from "./DiscoverWatchlist";
import { DiscoverOwnKeywords } from "./DiscoverOwnKeywords";

// The Hunting page's Discover tab: Explore (a category or keyword, from
// where to start down to what's selling and its keywords), the Watchlist,
// and Your keywords (from the account's own traffic, for whoever sees its
// analytics). The category or keyword open is in the address (?dc= or
// ?dq=), so Back and a shared link land on it.

type Section = "explore" | "watchlist" | "keywords";
const RANK_POLL_MS = 2500;
const READS_STEP = 25;

const subjectKey = (s: DiscoverSubjectRef | null) => (s?.categoryId ? `c:${s.categoryId}` : s?.q ? `q:${s.q.toLowerCase()}` : "");

function Loading({ first }: { first: boolean }) {
  return (
    <div className="card px-6 py-10 text-center" aria-live="polite">
      <span className="mx-auto block h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-primary)]/25 border-t-[var(--color-primary)]" aria-hidden />
      <p className="mt-3 text-[13px] font-medium text-[var(--color-ink)]">{first ? "Reading the leading listings and how many each has sold" : "Loading"}</p>
      {first && <p className="mx-auto mt-1 max-w-sm text-[12px] text-[var(--color-muted)]">The first look at a category or keyword takes a few seconds. After that it opens at once for the rest of the day.</p>}
    </div>
  );
}

export function DiscoverPanel({ connectionId, canSeeTraffic, onHunt }: { connectionId: string; canSeeTraffic: boolean; onHunt: (url: string) => void }) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const subject: DiscoverSubjectRef | null = search.get("dc") ? { categoryId: search.get("dc")! } : search.get("dq") ? { q: search.get("dq")! } : null;
  const key = subjectKey(subject);
  const [section, setSection] = useState<Section>("explore");

  const [start, setStart] = useState<{ data?: DiscoverStart; error?: string } | null>(null);
  const [startTick, setStartTick] = useState(0);
  // The open subject's answer; kept on screen while it's asked again (a ranking's progress, more reads).
  const [reads, setReads] = useState<{ key: string; n: number }>({ key: "", n: READS_STEP });
  const readsWanted = reads.key === key ? reads.n : READS_STEP;
  const [poll, setPoll] = useState(0);
  const requestKey = `${key}|${readsWanted}|${poll}`;
  const [result, setResult] = useState<{ requestKey: string; key: string; data?: DiscoverExplore; error?: string } | null>(null);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchlist, setWatchlist] = useState<{ data?: DiscoverWatchList; error?: string } | null>(null);
  const [watchTick, setWatchTick] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  const [range, setRange] = useState<"7d" | "30d" | "90d">("30d");
  const [own, setOwn] = useState<{ range: string; data?: OwnKeywords; error?: string } | null>(null);

  const open = useCallback(
    (next: DiscoverSubjectRef | null) => {
      const qs = new URLSearchParams(search.toString());
      qs.delete("dc");
      qs.delete("dq");
      if (next?.categoryId) qs.set("dc", next.categoryId);
      else if (next?.q) qs.set("dq", next.q);
      setSection("explore");
      router.push(`${pathname}?${qs.toString()}`, { scroll: false });
    },
    [pathname, router, search]
  );

  // Where to start.
  useEffect(() => {
    if (key || section !== "explore") return;
    let cancelled = false;
    api
      .discoverStart(connectionId)
      .then((data) => !cancelled && setStart({ data }))
      .catch((err) => !cancelled && setStart({ error: err instanceof ApiError ? err.message : "Couldn't load Discover." }));
    return () => {
      cancelled = true;
    };
  }, [connectionId, key, section, startTick]);

  // The open category or keyword.
  useEffect(() => {
    if (!subject) return;
    let cancelled = false;
    api
      .discoverExplore(connectionId, subject, readsWanted)
      .then((data) => !cancelled && setResult({ requestKey, key, data }))
      .catch((err) => !cancelled && setResult({ requestKey, key, error: err instanceof ApiError ? err.message : "Couldn't read that from eBay. Try again." }));
    return () => {
      cancelled = true;
    };
    // `subject` is rebuilt each render from the address; its key stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, requestKey]);

  const shown = result && result.key === key ? result : null;
  const answered = result?.requestKey === requestKey;

  // A ranking under way: ask again until it's done.
  const ranking = shown?.data?.ranking;
  useEffect(() => {
    if (!ranking || !answered) return;
    const timer = setTimeout(() => setPoll((n) => n + 1), RANK_POLL_MS);
    return () => clearTimeout(timer);
  }, [ranking, answered]);

  // The watchlist and your keywords, when shown.
  useEffect(() => {
    if (section !== "watchlist") return;
    let cancelled = false;
    api
      .discoverWatches(connectionId)
      .then((data) => !cancelled && setWatchlist({ data }))
      .catch((err) => !cancelled && setWatchlist({ error: err instanceof ApiError ? err.message : "Couldn't load the watchlist." }));
    return () => {
      cancelled = true;
    };
  }, [connectionId, section, watchTick]);
  useEffect(() => {
    if (section !== "keywords") return;
    let cancelled = false;
    api
      .discoverOwnKeywords(connectionId, range)
      .then((data) => !cancelled && setOwn({ range, data }))
      .catch((err) => !cancelled && setOwn({ range, error: err instanceof ApiError ? err.message : "Couldn't load your keywords." }));
    return () => {
      cancelled = true;
    };
  }, [connectionId, section, range]);

  async function rank() {
    if (!subject?.categoryId) return;
    try {
      await api.discoverRank(connectionId, subject.categoryId);
      setPoll((n) => n + 1);
    } catch (err) {
      setResult((r) => (r ? { ...r, error: err instanceof ApiError ? err.message : "Couldn't start the ranking." } : r));
    }
  }

  async function toggleWatch() {
    const data = shown?.data;
    if (!data || !subject) return;
    setWatchBusy(true);
    try {
      if (data.watch) await api.discoverUnwatch(connectionId, data.watch.id);
      else await api.discoverWatch(connectionId, subject);
      setPoll((n) => n + 1);
      setStartTick((n) => n + 1);
    } catch (err) {
      setResult((r) => (r ? { ...r, error: err instanceof ApiError ? err.message : "That didn't save. Try again." } : r));
    } finally {
      setWatchBusy(false);
    }
  }

  async function removeWatch(id: string) {
    setRemoving(id);
    try {
      await api.discoverUnwatch(connectionId, id);
      setWatchTick((n) => n + 1);
    } finally {
      setRemoving(null);
    }
  }

  const watchCount = start?.data?.watches ?? watchlist?.data?.items.length ?? null;
  const tabs: { key: Section; label: string }[] = [
    { key: "explore", label: "Explore" },
    { key: "watchlist", label: watchCount ? `Watchlist · ${watchCount}` : "Watchlist" },
    ...(canSeeTraffic ? [{ key: "keywords" as Section, label: "Your keywords" }] : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Discover" className="inline-flex max-w-full rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={section === t.key}
              onClick={() => setSection(t.key)}
              className={`h-7 rounded-full px-3 text-[12px] font-medium transition-colors ${section === t.key ? "bg-[var(--color-primary)] text-white shadow-sm" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {section === "keywords" && (
          <div role="radiogroup" aria-label="Dates" className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
            {(["7d", "30d", "90d"] as const).map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={range === r}
                onClick={() => setRange(r)}
                className={`h-7 rounded-full px-3 text-[12px] font-medium transition-colors ${range === r ? "bg-[var(--color-primary)] text-white shadow-sm" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"}`}
              >
                {r === "7d" ? "7 days" : r === "30d" ? "30 days" : "90 days"}
              </button>
            ))}
          </div>
        )}
      </div>

      {section === "explore" &&
        (subject ? (
          shown?.error && !shown.data ? (
            <div className="space-y-3">
              <Alert>{shown.error}</Alert>
              <button type="button" onClick={() => open(null)} className="text-[12.5px] font-medium text-[var(--color-primary)] hover:underline">
                Back to Discover
              </button>
            </div>
          ) : shown?.data ? (
            <>
              {shown.error && <Alert>{shown.error}</Alert>}
              <DiscoverSubjectView
                data={shown.data}
                onOpen={open}
                onBack={() => open(null)}
                onHunt={onHunt}
                onReadMore={() => setReads({ key, n: readsWanted + READS_STEP })}
                readingMore={!answered && readsWanted > (shown.data.reads.asked || 0)}
                onRank={rank}
                onToggleWatch={toggleWatch}
                watchBusy={watchBusy}
              />
            </>
          ) : (
            <Loading first />
          )
        ) : start?.error ? (
          <Alert>{start.error}</Alert>
        ) : start?.data ? (
          <DiscoverStartView data={start.data} onOpen={open} />
        ) : (
          <Loading first={false} />
        ))}

      {section === "watchlist" &&
        (watchlist?.error ? (
          <Alert>{watchlist.error}</Alert>
        ) : watchlist?.data ? (
          <DiscoverWatchlist data={watchlist.data} onOpen={open} onRemove={removeWatch} removing={removing} />
        ) : (
          <Loading first={false} />
        ))}

      {section === "keywords" &&
        canSeeTraffic &&
        (own?.error ? <Alert>{own.error}</Alert> : own?.data && own.range === range ? <DiscoverOwnKeywords data={own.data} onOpen={open} /> : <Loading first={false} />)}
    </div>
  );
}
