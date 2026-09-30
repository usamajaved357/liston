"use client";

import { useEffect, useState } from "react";
import { api, ApiError, Connection, inboxApi, NotificationSettings } from "@/lib/api";
import { PillTabs } from "@/components/PillTabs";
import { clock } from "./inbox-format";

// What the Inbox pushes to this person's devices: team chat (everything,
// direct messages and @mentions, or nothing), eBay messages (every account
// they can see, chosen ones, or none), quiet hours in their own time zone,
// and whether a lock screen shows the message text. The bell keeps
// everything either way. A conversation can also be muted on its own.

const HOURS = Array.from({ length: 24 }, (_, h) => h * 60);

export function NotificationSettingsCard() {
  const [s, setS] = useState<NotificationSettings | null>(null);
  const [accounts, setAccounts] = useState<Connection[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    inboxApi.notificationSettings().then(setS).catch(() => setError("Couldn't load your notification settings."));
    api.listConnections().then((r) => setAccounts(r.connections || [])).catch(() => {});
  }, []);

  async function save(patch: Partial<NotificationSettings>) {
    if (!s) return;
    const next = { ...s, ...patch };
    setS(next);
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      setS(await inboxApi.saveNotificationSettings(patch));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  const quiet = s ? s.quietFrom !== null && s.quietTo !== null : false;
  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3 px-5 pt-4">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--color-ink)]">Inbox notifications</h2>
          <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">What reaches your phone and computer. The bell in Liston keeps everything either way.</p>
        </div>
        <span className="text-[11.5px] text-[var(--color-muted)]" aria-live="polite">{saving ? "Saving…" : saved ? "Saved" : ""}</span>
      </div>
      {!s ? (
        <div className="px-5 py-5 text-[12.5px] text-[var(--color-muted)]">{error || "Loading…"}</div>
      ) : (
        <div className="space-y-5 px-5 py-4">
          <div>
            <p className="mb-1.5 text-[12.5px] font-medium text-[var(--color-ink)]">Team chat</p>
            <PillTabs
              tabs={[
                { key: "all" as const, label: "Every message" },
                { key: "mentions" as const, label: "Direct messages and @mentions" },
                { key: "none" as const, label: "Nothing" },
              ]}
              value={s.chat}
              onChange={(chat) => save({ chat })}
              role="radiogroup"
              label="Team chat notifications"
            />
          </div>
          <div>
            <p className="mb-1.5 text-[12.5px] font-medium text-[var(--color-ink)]">eBay messages</p>
            <PillTabs
              tabs={[
                { key: "all" as const, label: "Every account I can see" },
                { key: "chosen" as const, label: "Chosen accounts" },
                { key: "none" as const, label: "Nothing" },
              ]}
              value={s.ebay}
              onChange={(ebay) => save({ ebay })}
              role="radiogroup"
              label="eBay message notifications"
            />
            {s.ebay === "chosen" && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {accounts.map((a) => {
                  const on = s.ebayAccounts.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => save({ ebayAccounts: on ? s.ebayAccounts.filter((x) => x !== a.id) : [...s.ebayAccounts, a.id] })}
                      className={`h-7 rounded-full px-3 text-[12px] font-medium ring-1 ring-inset ${on ? "bg-[var(--color-primary)] text-white ring-[var(--color-primary)]" : "bg-[var(--color-panel)] text-[var(--color-ink)] ring-[var(--color-line)] hover:ring-[var(--color-primary)]/40"}`}
                      aria-pressed={on}
                    >
                      {a.label}
                    </button>
                  );
                })}
                {accounts.length === 0 && <span className="text-[12px] text-[var(--color-muted)]">No accounts to choose.</span>}
              </div>
            )}
            <p className="mt-1.5 text-[11.5px] text-[var(--color-muted)]">A conversation assigned to you is always sent to you.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-[12.5px] font-medium text-[var(--color-ink)]">
              <input
                type="checkbox"
                checked={quiet}
                onChange={() =>
                  save(quiet ? { quietFrom: null, quietTo: null } : { quietFrom: 22 * 60, quietTo: 7 * 60, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" })
                }
                className="h-4 w-4 accent-[var(--color-primary)]"
              />
              Quiet hours
            </label>
            {quiet && (
              <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-muted)]">
                from
                <select value={s.quietFrom ?? 0} onChange={(e) => save({ quietFrom: Number(e.target.value), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" })} className="input input-sm !w-auto">
                  {HOURS.map((m) => (
                    <option key={m} value={m}>
                      {clock(m)}
                    </option>
                  ))}
                </select>
                to
                <select value={s.quietTo ?? 0} onChange={(e) => save({ quietTo: Number(e.target.value), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" })} className="input input-sm !w-auto">
                  {HOURS.map((m) => (
                    <option key={m} value={m}>
                      {clock(m)}
                    </option>
                  ))}
                </select>
                <span>({s.timeZone || "your time"})</span>
              </span>
            )}
          </div>
          <label className="flex cursor-pointer items-start gap-2 text-[12.5px]">
            <input type="checkbox" checked={s.hideText} onChange={() => save({ hideText: !s.hideText })} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
            <span>
              <span className="block font-medium text-[var(--color-ink)]">Hide message text on my lock screen</span>
              <span className="block text-[var(--color-muted)]">Shows only &ldquo;New message from Sara&rdquo;. Buyer messages can carry addresses and order details.</span>
            </span>
          </label>
          {error && <p className="notice notice-danger text-[12.5px]">{error}</p>}
        </div>
      )}
    </div>
  );
}
