"use client";

import { ClipboardEvent, useState } from "react";
import { api, ApiError, HuntExactSales } from "@/lib/api";
import { TrendChart } from "@/components/charts/TrendChart";
import { count, money } from "@/components/research/format";
import { useAccountTimeZone } from "@/lib/timezone";
import { ExternalIcon } from "./HuntBits";

// A competitor listing's dated sales, from eBay's purchase history page.
// eBay shows when each sale happened only on that page (its dated sales API
// isn't granted to Liston), and Liston never loads eBay pages itself: a
// team member opens it in their own browser, selects everything, copies and
// pastes it here. Liston reads the sales out of the text and keeps them, so
// every hunt of the listing uses them and pasting again adds the new ones.

const WINDOWS: { key: keyof NonNullable<HuntExactSales["figures"]>["windows"]; label: string }[] = [
  { key: "day", label: "Last 24 hours" },
  { key: "d3", label: "Last 3 days" },
  { key: "d7", label: "Last 7 days" },
  { key: "d15", label: "Last 15 days" },
  { key: "d30", label: "Last 30 days" },
  { key: "d90", label: "Last 90 days" },
];

// In the account's own time zone (the eBay site's), as eBay's page shows them.
const whenIn = (timeZone: string | undefined) => (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
const TREND = { up: { text: "Rising", ink: "text-emerald-700" }, flat: { text: "Steady", ink: "text-[var(--color-ink)]" }, down: { text: "Slowing", ink: "text-rose-700" } };

function Figure({ label, value, note, ink = "text-[var(--color-ink)]" }: { label: string; value: string; note?: string; ink?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2.5">
      <p className="truncate text-[10.5px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{label}</p>
      <p className={`mt-0.5 truncate text-[17px] font-semibold tabular-nums ${ink}`}>{value}</p>
      {note && <p className="truncate text-[11px] text-[var(--color-muted)]">{note}</p>}
    </div>
  );
}

function PasteBox({ exact, busy, error, onPaste, compact }: { exact: HuntExactSales; busy: boolean; error: string | null; onPaste: (text: string) => void; compact?: boolean }) {
  const [text, setText] = useState("");
  const paste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (pasted.trim().length > 20) {
      e.preventDefault();
      setText("");
      onPaste(pasted);
    }
  };
  return (
    <div className={compact ? "" : "rounded-xl border border-dashed border-indigo-300 bg-indigo-50/40 p-4"}>
      {!compact && (
        <ol className="mb-3 grid gap-2 text-[12.5px] text-[var(--color-ink)] sm:grid-cols-3">
          <li className="flex gap-2">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-[11px] font-semibold text-white">1</span>
            <span>
              <a href={exact.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-[var(--color-primary)] hover:underline">
                Open its sold history on eBay <ExternalIcon />
              </a>
            </span>
          </li>
          <li className="flex gap-2">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-[11px] font-semibold text-white">2</span>
            <span>
              Select everything (<kbd className="rounded bg-white px-1 text-[11px] ring-1 ring-[var(--color-line)]">Cmd/Ctrl</kbd>+<kbd className="rounded bg-white px-1 text-[11px] ring-1 ring-[var(--color-line)]">A</kbd>) and copy it
            </span>
          </li>
          <li className="flex gap-2">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-[11px] font-semibold text-white">3</span>
            <span>Paste it in the box below</span>
          </li>
        </ol>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={paste}
        disabled={busy}
        rows={compact ? 2 : 3}
        placeholder={busy ? "Reading the sales…" : "Paste eBay's sold history page here"}
        className="input min-h-0 w-full resize-none py-2 text-[12.5px]"
      />
      {text.trim().length > 20 && !busy && (
        <button type="button" onClick={() => onPaste(text)} className="btn btn-primary btn-sm mt-2">
          Read the sales
        </button>
      )}
      {error && <p className="mt-2 text-[12px] font-medium text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}

export function SoldHistory({ exact: initial, connectionId, itemId, competitorUrl, currency, onImported }: { exact: HuntExactSales; connectionId?: string; itemId: string | null; competitorUrl: string | null; currency: string; onImported?: () => void }) {
  const when = whenIn(useAccountTimeZone());
  const [exact, setExact] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [allRecent, setAllRecent] = useState(false);
  const f = exact.figures;
  const canPaste = Boolean(connectionId && itemId);

  async function read(text: string) {
    if (!connectionId || !itemId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.huntSoldHistory(connectionId, { itemId, competitorUrl, text });
      setExact(res.exact);
      setNotice(`Read ${res.read} sale${res.read === 1 ? "" : "s"}${res.added < res.read ? `, ${res.added} new` : ""}.`);
      setShowPaste(false);
      onImported?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't read that. Try copying the page again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-[var(--color-line)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[12px] font-semibold text-[var(--color-ink)]">Sold history from eBay</p>
          <p className="text-[11.5px] text-[var(--color-muted)]">
            {f
              ? `Every sale eBay shows for the last 90 days${exact.importedAt ? ` · updated ${when(exact.importedAt)}` : ""}`
              : "When each sale happened, per variation, straight from the listing's sold history page."}
          </p>
        </div>
        {f && (
          <div className="flex items-center gap-2">
            <a href={exact.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm inline-flex items-center gap-1 text-[var(--color-primary)]">
              Open on eBay <ExternalIcon />
            </a>
            {canPaste && (
              <button type="button" onClick={() => setShowPaste((v) => !v)} className="btn btn-secondary btn-sm">
                {showPaste ? "Cancel" : "Paste newer sales"}
              </button>
            )}
          </div>
        )}
      </div>
      {notice && <p className="mt-2 text-[12px] font-medium text-emerald-700">{notice}</p>}

      {!f && (
        <div className="mt-3">
          {canPaste ? (
            <PasteBox exact={exact} busy={busy} error={error} onPaste={read} />
          ) : (
            <p className="text-[12.5px] text-[var(--color-muted)]">
              Add a competitor to read its sold history.{" "}
              <a href={exact.url} target="_blank" rel="noreferrer" className="font-semibold text-[var(--color-primary)] hover:underline">
                Open it on eBay
              </a>
            </p>
          )}
        </div>
      )}
      {f && showPaste && (
        <div className="mt-3">
          <PasteBox exact={exact} busy={busy} error={error} onPaste={read} compact />
        </div>
      )}

      {f && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {WINDOWS.map((w) => (
              <Figure key={w.key} label={w.label} value={`${count(f.windows[w.key].units)} sold`} note={`${count(f.windows[w.key].orders)} order${f.windows[w.key].orders === 1 ? "" : "s"}`} />
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Figure
              label="Since last sale"
              value={f.daysSinceLast === 0 ? "Today" : `${f.daysSinceLast} day${f.daysSinceLast === 1 ? "" : "s"}`}
              ink={f.daysSinceLast <= 3 ? "text-emerald-700" : f.daysSinceLast <= 10 ? "text-amber-700" : "text-rose-700"}
              note={when(f.lastSoldAt)}
            />
            <Figure label="A day" value={String(f.perDay)} note="last 30 days' pace" />
            <Figure label="A week" value={String(f.perWeek)} />
            <Figure label="A month" value={String(f.perMonth)} />
            <Figure label="Price" value={f.price ? money(f.price.average, f.currency || currency) : "—"} note={f.price ? (f.price.low === f.price.high ? "never changed" : `${money(f.price.low, f.currency || currency)} – ${money(f.price.high, f.currency || currency)}`) : undefined} />
            <Figure label="Trend" value={f.trend ? TREND[f.trend].text : "Too early"} ink={f.trend ? TREND[f.trend].ink : "text-[var(--color-muted)]"} note={f.trend ? "last 15 days vs 15 before" : "needs 20 days of sales"} />
          </div>

          <div className="mt-3">
            <TrendChart points={f.daily.map((d) => ({ day: d.day, value: d.units }))} format={(v) => (v === null ? "—" : `${count(v)} sold`)} label="Sold" currentLabel="Sold a day" variant="bars" showPrevious={false} legend={false} height={170} />
          </div>

          {f.byVariation.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded-xl border border-[var(--color-line)]">
              <table className="w-full min-w-[520px] text-[12.5px]">
                <thead>
                  <tr className="bg-[var(--color-paper)] text-[10.5px] uppercase tracking-wide text-[var(--color-muted)]">
                    <th className="px-3 py-2 text-left font-semibold">Variation</th>
                    <th className="px-2 py-2 text-center font-semibold">Last 7 days</th>
                    <th className="px-2 py-2 text-center font-semibold">Last 30 days</th>
                    <th className="px-2 py-2 text-center font-semibold">In all</th>
                    <th className="px-2 py-2 text-center font-semibold">Share</th>
                    <th className="px-3 py-2 text-center font-semibold">Last sold</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-line)]">
                  {f.byVariation.map((v) => (
                    <tr key={v.variation || "listing"}>
                      <td className="px-3 py-2 font-medium text-[var(--color-ink)]">{v.variation || "The listing"}</td>
                      <td className={`px-2 py-2 text-center tabular-nums ${v.d7 ? "font-semibold text-[var(--color-ink)]" : "text-[var(--color-muted)]"}`}>{count(v.d7)}</td>
                      <td className="px-2 py-2 text-center tabular-nums text-[var(--color-ink)]">{count(v.d30)}</td>
                      <td className="px-2 py-2 text-center tabular-nums text-[var(--color-ink)]">{count(v.units)}</td>
                      <td className="px-2 py-2 text-center tabular-nums text-[var(--color-muted)]">{v.share === null ? "—" : `${v.share}%`}</td>
                      <td className="px-3 py-2 text-center text-[var(--color-muted)]">{v.lastSoldAt ? when(v.lastSoldAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-3">
            <p className="text-[12px] font-semibold text-[var(--color-ink)]">Recent purchases</p>
            <ul className="mt-1.5 divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)]">
              {(allRecent ? f.recent : f.recent.slice(0, 8)).map((r, i) => (
                <li key={`${r.soldAt}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2 text-[12.5px] sm:grid-cols-[170px_minmax(0,1fr)_80px_50px]">
                  <span className="text-[var(--color-muted)] max-sm:col-span-3">{when(r.soldAt)}</span>
                  <span className="truncate font-medium text-[var(--color-ink)]">{r.variation || "The listing"}</span>
                  <span className="text-right tabular-nums text-[var(--color-ink)]">{r.price === null ? "—" : money(r.price, f.currency || currency)}</span>
                  <span className="text-right tabular-nums text-[var(--color-muted)]">× {r.quantity}</span>
                </li>
              ))}
            </ul>
            {f.recent.length > 8 && (
              <button type="button" onClick={() => setAllRecent((v) => !v)} className="mt-1.5 text-[12px] font-semibold text-[var(--color-primary)] hover:underline">
                {allRecent ? "Show fewer" : `Show all ${f.recent.length}`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
