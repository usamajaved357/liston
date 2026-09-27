"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, DiscoverExplore, DiscoverOwnKeywords as OwnKeywords, DiscoverStart, DiscoverSubjectRef, DiscoverWatchList, DiscoverWinners, DiscoverWinnersFilters } from "@/lib/api";
import { Alert } from "@/components/Alert";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { DiscoverSearch } from "./DiscoverSearch";
import { DiscoverStartView } from "./DiscoverStartView";
import { DiscoverSubjectView } from "./DiscoverSubjectView";
import { DiscoverWatchlist } from "./DiscoverWatchlist";
import { DiscoverWinnersView } from "./DiscoverWinners";
import { DiscoverOwnKeywords } from "./DiscoverOwnKeywords";

// The Hunting page's Discover tab: Explore (a category or keyword, from
// where to start down to what's selling and its keywords), the Watchlist,
// and Your keywords (from the account's own traffic, for whoever sees its
// analytics). The category or keyword open is in the address (?dc= or
// ?dq=), so Back and a shared link land on it.

type Section = "explore" | "winners" | "watchlist" | "keywords";
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
  // The AI's brand/VeRO reading, asked for once a subject is on screen without today's.
  const [review, setReview] = useState<{ key: string; compliance?: DiscoverExplore["compliance"]; checked?: boolean; failed?: boolean; hidden?: number } | null>(null);
  const [own, setOwn] = useState<{ range: string; data?: OwnKeywords; error?: string } | null>(null);
  const [winnersFilters, setWinnersFilters] = useState<DiscoverWinnersFilters>({ sort: "score" });
  const [winners, setWinners] = useState<{ key: string; data?: DiscoverWinners; error?: string } | null>(null);
  const winnersKey = JSON.stringify(winnersFilters);

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
  // The AI's reading is for a keyword or a subcategory ("Before you hunt" isn't shown on a top-level category).
  const needsReview = Boolean(shown?.data && !shown.data.compliance.ai && (shown.data.subject.kind === "keyword" || shown.data.subject.path.length > 1));
  const reviewed = review?.key === key ? review : null;

  const runReview = useCallback(() => {
    if (!subject) return;
    const forKey = key;
    api
      .discoverReview(connectionId, subject)
      .then((d) => {
        setReview({ key: forKey, compliance: d.compliance, checked: d.checked, failed: !d.checked, hidden: d.hidden });
        // The AI named brands that hide more listings: open the subject again (no eBay call) so
        // the figures, keywords and Selling now leave them out too.
        setResult((r) => {
          if (r && r.key === forKey && r.data && r.data.compliance.hidden.count !== d.hidden) setPoll((n) => n + 1);
          return r;
        });
      })
      .catch(() => setReview({ key: forKey, failed: true }));
    // `subject` is rebuilt each render from the address; its key stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, key]);
  useEffect(() => {
    if (!needsReview || review?.key === key) return;
    const timer = setTimeout(runReview, 0);
    return () => clearTimeout(timer);
  }, [needsReview, review?.key, key, runReview]);

  // A ranking under way: ask again until it's done.
  const ranking = shown?.data?.ranking;
  useEffect(() => {
    if (!ranking || !answered) return;
    const timer = setTimeout(() => setPoll((n) => n + 1), RANK_POLL_MS);
    return () => clearTimeout(timer);
  }, [ranking, answered]);

  // Winners, when shown: asked again as the filters change (typing waits a moment).
  useEffect(() => {
    if (section !== "winners") return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        api
          .discoverWinners(connectionId, winnersFilters)
          .then((data) => !cancelled && setWinners({ key: winnersKey, data }))
          .catch((err) => !cancelled && setWinners({ key: winnersKey, error: err instanceof ApiError ? err.message : "Couldn't load the winning products." }));
      },
      winners ? 250 : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `winnersFilters` is what `winnersKey` stands for; `winners` only decides the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, section, winnersKey]);

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
  const sections: { key: Section; label: string }[] = [
    { key: "explore", label: "Explore" },
    { key: "winners", label: "Winners" },
    { key: "watchlist", label: watchCount ? `Watchlist · ${watchCount}` : "Watchlist" },
    ...(canSeeTraffic ? [{ key: "keywords" as Section, label: "Your keywords" }] : []),
  ];
  // Back goes up one level: a category to the one above it, anything else to Discover's start.
  const path = shown?.data?.subject.kind === "category" ? shown.data.subject.path : [];
  const parent = path.length > 1 ? path[path.length - 2] : null;

  return (
    <div className="space-y-4">
      {/* On every Discover screen: the search box and the sections. */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <DiscoverSearch key={key} connectionId={connectionId} onOpen={open} initial={subject?.q || ""} />
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label="Discover"
            value={section}
            onChange={(next) => {
              // Explore again from inside a category or keyword: back to the start.
              if (next === "explore" && section === "explore" && subject) open(null);
              setSection(next);
            }}
            options={sections}
          />
          {section === "keywords" && (
            <SegmentedControl
              label="Dates"
              value={range}
              onChange={setRange}
              options={[
                { key: "7d", label: "7 days" },
                { key: "30d", label: "30 days" },
                { key: "90d", label: "90 days" },
              ]}
            />
          )}
        </div>
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
                data={reviewed?.compliance ? { ...shown.data, compliance: reviewed.compliance } : shown.data}
                checking={needsReview && !reviewed}
                onCheck={runReview}
                aiUnavailable={Boolean(reviewed?.failed)}
                onOpen={open}
                onBack={() => open(parent ? { categoryId: parent.id } : null)}
                backLabel={parent ? parent.name : "Discover"}
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
          <DiscoverStartView data={start.data} onOpen={open} onWatchlist={() => setSection("watchlist")} onWinners={() => setSection("winners")} />
        ) : (
          <Loading first={false} />
        ))}

      {section === "winners" &&
        (winners?.error && !winners.data ? (
          <Alert>{winners.error}</Alert>
        ) : (
          <DiscoverWinnersView data={winners?.data || null} filters={winnersFilters} onFilters={setWinnersFilters} loading={Boolean(winners) && winners?.key !== winnersKey} onHunt={onHunt} onOpen={open} />
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
