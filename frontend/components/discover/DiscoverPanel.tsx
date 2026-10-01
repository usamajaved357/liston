"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, DiscoverExplore, DiscoverOwnKeywords as OwnKeywords, DiscoverSiteKeywords as SiteKeywords, DiscoverStart, DiscoverSubjectRef, DiscoverWatchList } from "@/lib/api";
import { Alert } from "@/components/Alert";
import { SegmentedControl } from "@/components/charts/SegmentedControl";
import { PillTabs } from "@/components/PillTabs";
import { count } from "@/components/research/format";
import { DiscoverSearch } from "./DiscoverSearch";
import { DiscoverCategoriesTab, DiscoverHero, DiscoverRecent } from "./DiscoverStartView";
import { SearchBox } from "./discover-ui";
import { DiscoverSiteKeywords, SiteKeywordsQuery } from "./DiscoverSiteKeywords";
import { DiscoverSubjectView } from "./DiscoverSubjectView";
import { DiscoverWatchlist } from "./DiscoverWatchlist";
import { DiscoverOwnKeywords } from "./DiscoverOwnKeywords";

// The Hunting page's Discover tab: judging categories and keywords, at
// every level. Its start is tabs, so nothing pushes anything else down the
// page: Categories (eBay's to browse, everything explored ranked, the
// account's own), Keywords (the keywords that sell across everything
// explored, and the account's own searches for whoever sees its analytics)
// and Watchlist (watched, and what the team explored lately). Opening a
// category or keyword (?dc= or ?dq=) shows its figures and its own tabs:
// subcategories, keywords and market. It lists no products: it says where
// to hunt. The start tab is ?dt=, so Back and a shared link land on it.

type HomeTab = "categories" | "keywords" | "saved";
const HOME_TABS: HomeTab[] = ["categories", "keywords", "saved"];
const RANK_POLL_MS = 2500;
const READ_POLL_MS = 1500; // while sold counts are read in the background
const PAGE = 60; // keywords a page, on the start's Keywords tab

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

export function DiscoverPanel({ connectionId, canSeeTraffic }: { connectionId: string; canSeeTraffic: boolean }) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const subject: DiscoverSubjectRef | null = search.get("dc") ? { categoryId: search.get("dc")! } : search.get("dq") ? { q: search.get("dq")! } : null;
  const key = subjectKey(subject);
  const homeTab: HomeTab = HOME_TABS.includes(search.get("dt") as HomeTab) ? (search.get("dt") as HomeTab) : "categories";
  const home = !subject;
  // Keywords: across eBay (everything explored), or the account's own searches.
  const [keywordSource, setKeywordSource] = useState<"ebay" | "yours">("ebay");

  const [start, setStart] = useState<{ data?: DiscoverStart; error?: string } | null>(null);
  const [startTick, setStartTick] = useState(0);
  // The open subject's answer; kept on screen while it's asked again (a ranking's progress, sold counts still being read).
  const [poll, setPoll] = useState(0);
  const requestKey = `${key}|${poll}`;
  const [result, setResult] = useState<{ requestKey: string; key: string; data?: DiscoverExplore; error?: string } | null>(null);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchlist, setWatchlist] = useState<{ data?: DiscoverWatchList; error?: string } | null>(null);
  const [watchTick, setWatchTick] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  const [range, setRange] = useState<"7d" | "30d" | "90d">("30d");
  // The AI's brand/VeRO reading, asked for once a subject is on screen without today's.
  const [review, setReview] = useState<{ key: string; compliance?: DiscoverExplore["compliance"]; checked?: boolean; failed?: boolean; hidden?: number } | null>(null);
  const [own, setOwn] = useState<{ range: string; data?: OwnKeywords; error?: string } | null>(null);
  const [kwQuery, setKwQueryState] = useState<SiteKeywordsQuery>({ q: "", sort: "sales", searchedOnly: false });
  const [kwLimit, setKwLimit] = useState(PAGE);
  const setKwQuery = (next: SiteKeywordsQuery) => {
    setKwQueryState(next);
    setKwLimit(PAGE);
  };
  const [siteKeywords, setSiteKeywords] = useState<{ key: string; data?: SiteKeywords; error?: string } | null>(null);
  const kwKey = JSON.stringify([kwQuery, kwLimit]);

  const open = useCallback(
    (next: DiscoverSubjectRef | null) => {
      const qs = new URLSearchParams(search.toString());
      qs.delete("dc");
      qs.delete("dq");
      if (next?.categoryId) qs.set("dc", next.categoryId);
      else if (next?.q) qs.set("dq", next.q);
      router.push(`${pathname}?${qs.toString()}`, { scroll: false });
    },
    [pathname, router, search]
  );
  const changeHomeTab = useCallback(
    (next: HomeTab) => {
      const qs = new URLSearchParams(search.toString());
      if (next === "categories") qs.delete("dt");
      else qs.set("dt", next);
      router.replace(`${pathname}?${qs.toString()}`, { scroll: false });
    },
    [pathname, router, search]
  );

  // Where to start.
  useEffect(() => {
    if (key) return;
    let cancelled = false;
    api
      .discoverStart(connectionId)
      .then((data) => !cancelled && setStart({ data }))
      .catch((err) => !cancelled && setStart({ error: err instanceof ApiError ? err.message : "Couldn't load Discover." }));
    return () => {
      cancelled = true;
    };
  }, [connectionId, key, startTick]);

  // Your categories being scored in the background: asked again until they're all in.
  const scoringYours = Boolean(start?.data?.yourScoring);
  useEffect(() => {
    if (!scoringYours || key) return;
    const timer = setTimeout(() => setStartTick((n) => n + 1), RANK_POLL_MS);
    return () => clearTimeout(timer);
  }, [scoringYours, key, start]);

  // The open category or keyword.
  useEffect(() => {
    if (!subject) return;
    let cancelled = false;
    api
      .discoverExplore(connectionId, subject)
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
        setReview({ key: forKey, compliance: d.compliance, checked: d.checked, failed: !d.checked });
        // The AI named brands that hide or mark more of the leading listings: open the subject again
        // (no eBay call) so its figures leave them out too.
        setResult((r) => {
          if (r && r.key === forKey && r.data && (r.data.compliance.hidden.count !== d.hidden || (r.data.compliance.vero?.count ?? 0) !== (d.marked ?? 0))) setPoll((n) => n + 1);
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

  // A ranking under way, or sold counts still being read: ask again until done (the figures fill in).
  const ranking = shown?.data?.ranking;
  const readingOn = Boolean(shown?.data?.reads.reading);
  useEffect(() => {
    if ((!ranking && !readingOn) || !answered) return;
    const timer = setTimeout(() => setPoll((n) => n + 1), readingOn && !ranking ? READ_POLL_MS : RANK_POLL_MS);
    return () => clearTimeout(timer);
  }, [ranking, readingOn, answered, poll]);

  // The keywords across everything explored, when shown.
  const showSiteKeywords = home && homeTab === "keywords" && keywordSource === "ebay";
  useEffect(() => {
    if (!showSiteKeywords) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        api
          .discoverKeywords(connectionId, { ...kwQuery, limit: kwLimit })
          .then((data) => !cancelled && setSiteKeywords({ key: kwKey, data }))
          .catch((err) => !cancelled && setSiteKeywords({ key: kwKey, error: err instanceof ApiError ? err.message : "Couldn't load the keywords." }));
      },
      siteKeywords ? 250 : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `kwQuery` and `kwLimit` are what `kwKey` stands for; `siteKeywords` only decides the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, showSiteKeywords, kwKey]);

  // The watchlist and your keywords, when shown.
  const showSaved = home && homeTab === "saved";
  useEffect(() => {
    if (!showSaved) return;
    let cancelled = false;
    api
      .discoverWatches(connectionId)
      .then((data) => !cancelled && setWatchlist({ data }))
      .catch((err) => !cancelled && setWatchlist({ error: err instanceof ApiError ? err.message : "Couldn't load the watchlist." }));
    return () => {
      cancelled = true;
    };
  }, [connectionId, showSaved, watchTick]);
  const showOwn = home && homeTab === "keywords" && keywordSource === "yours" && canSeeTraffic;
  useEffect(() => {
    if (!showOwn) return;
    let cancelled = false;
    api
      .discoverOwnKeywords(connectionId, range)
      .then((data) => !cancelled && setOwn({ range, data }))
      .catch((err) => !cancelled && setOwn({ range, error: err instanceof ApiError ? err.message : "Couldn't load your keywords." }));
    return () => {
      cancelled = true;
    };
  }, [connectionId, showOwn, range]);

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
  const pool = start?.data?.pool;
  const homeTabs = [
    { key: "categories" as HomeTab, label: "Categories", count: start?.data ? count(start.data.topCategories.length + start.data.yourCategories.length) : undefined },
    { key: "keywords" as HomeTab, label: "Keywords", count: pool ? count(pool.keywords) : undefined },
    { key: "saved" as HomeTab, label: "Watchlist and recent", count: watchCount || undefined },
  ];
  // Back goes up one level: a category to the one above it, anything else to Discover's start.
  const path = shown?.data?.subject.kind === "category" ? shown.data.subject.path : [];
  const parent = path.length > 1 ? path[path.length - 2] : null;

  return (
    <div className="space-y-4">
      {/* On every Discover screen: the search box. */}
      <DiscoverSearch key={key} connectionId={connectionId} onOpen={open} initial={subject?.q || ""} />

      {subject ? (
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
              key={key}
              data={reviewed?.compliance ? { ...shown.data, compliance: reviewed.compliance } : shown.data}
              checking={needsReview && !reviewed}
              onCheck={runReview}
              aiUnavailable={Boolean(reviewed?.failed)}
              onOpen={open}
              onBack={() => open(parent ? { categoryId: parent.id } : null)}
              backLabel={parent ? parent.name : "Discover"}
              onRank={rank}
              onToggleWatch={toggleWatch}
              watchBusy={watchBusy}
            />
          </>
        ) : (
          <Loading first />
        )
      ) : (
        <>
          {start?.error ? <Alert>{start.error}</Alert> : start?.data ? <DiscoverHero data={start.data} /> : null}

          {/* The search for eBay's keywords sits on the left of the tabs, so the filter bar below keeps to one line. */}
          <div className="flex flex-wrap items-center gap-2">
            {homeTab === "keywords" && !(keywordSource === "yours" && canSeeTraffic) && <SearchBox value={kwQuery.q} onChange={(q) => setKwQuery({ ...kwQuery, q })} placeholder="Words in the keyword" />}
            <PillTabs label="Discover" tabs={homeTabs} value={homeTab} onChange={changeHomeTab} />
            {homeTab === "keywords" && canSeeTraffic && (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <SegmentedControl
                  label="Keywords from"
                  value={keywordSource}
                  onChange={setKeywordSource}
                  options={[
                    { key: "ebay", label: "Selling on eBay", title: "The keywords of the titles that sell, across everything explored" },
                    { key: "yours", label: "Your searches", title: "The words buyers found your own listings by: impressions, clicks and sales" },
                  ]}
                />
                {keywordSource === "yours" && (
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
            )}
          </div>

          {homeTab === "categories" && (start?.data ? <DiscoverCategoriesTab data={start.data} onOpen={open} /> : !start?.error && <Loading first={false} />)}

          {homeTab === "keywords" &&
            (keywordSource === "yours" && canSeeTraffic ? (
              own?.error ? <Alert>{own.error}</Alert> : own?.data && own.range === range ? <DiscoverOwnKeywords data={own.data} onOpen={open} /> : <Loading first={false} />
            ) : siteKeywords?.error && !siteKeywords.data ? (
              <Alert>{siteKeywords.error}</Alert>
            ) : (
              <DiscoverSiteKeywords
                data={siteKeywords?.data || null}
                query={kwQuery}
                onQuery={setKwQuery}
                loading={Boolean(siteKeywords) && siteKeywords?.key !== kwKey}
                onOpen={open}
                onMore={() => setKwLimit((n) => n + PAGE)}
              />
            ))}

          {homeTab === "saved" && (
            <div className="space-y-4">
              {watchlist?.error ? <Alert>{watchlist.error}</Alert> : watchlist?.data ? <DiscoverWatchlist data={watchlist.data} onOpen={open} onRemove={removeWatch} removing={removing} /> : <Loading first={false} />}
              {start?.data && <DiscoverRecent data={start.data} onOpen={open} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
