"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, NotificationList } from "@/lib/api";
import { disablePush, enablePush, pushState, PushState, refreshPush } from "@/lib/push";
import { ago } from "@/components/hunting/HuntBits";

// The bell in the page header: what Liston has told this person (a reviewer
// approved, rejected, sent back or removed one of their hunted products),
// newest first, and the switch for browser notifications, which reach them
// even when Liston isn't open. While Liston is open and in view, a new one
// also pops up as a card with a chime, whatever the computer's own
// notification settings (the system notification is for when it isn't).

type Toast = { id: string; kind: string | null; title: string; body: string | null; url: string | null };

const KIND: Record<string, { ring: string; icon: React.ReactNode }> = {
  "hunt.approved": { ring: "bg-emerald-50 text-emerald-600 ring-emerald-200", icon: <path d="M5 10.5l3.2 3.2L15 6.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /> },
  "hunt.rejected": { ring: "bg-rose-50 text-rose-600 ring-rose-200", icon: <path d="M6.5 6.5l7 7M13.5 6.5l-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /> },
  "hunt.sent_back": { ring: "bg-amber-50 text-amber-600 ring-amber-200", icon: <path d="M8 6L4.5 9.5 8 13M5 9.5h7a3.5 3.5 0 010 7h-1" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /> },
  "hunt.removed": { ring: "bg-slate-100 text-slate-500 ring-slate-200", icon: <path d="M5 6.5h10M8.5 6.5V5h3v1.5M6.5 6.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /> },
};
const OTHER = { ring: "bg-indigo-50 text-indigo-600 ring-indigo-200", icon: <path d="M6.5 13.5V9.5a3.5 3.5 0 117 0v4l1 1.3h-9l1-1.3zM8.8 16.3a1.3 1.3 0 002.4 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> };

function BellIcon({ off = false, className = "h-[18px] w-[18px]" }: { off?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M6 16.5V11a6 6 0 1112 0v5.5l1.5 2h-15l1.5-2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M10 20.5a2.2 2.2 0 004 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      {off && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />}
    </svg>
  );
}

// A short two-note chime, made in the browser (no sound file). Browsers only
// play sound once the person has clicked or typed on the page; before that
// it's skipped quietly.
let audio: AudioContext | null = null;
function chime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio = audio || new Ctx();
    if (audio.state === "suspended") audio.resume().catch(() => {});
    const now = audio.currentTime;
    [
      [880, 0],
      [1318.5, 0.14],
    ].forEach(([freq, at]) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.45);
      osc.connect(gain).connect(audio!.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.5);
    });
  } catch {
    // No sound; the card still shows.
  }
}

function PushControl({ state, busy, testing, onEnable, onDisable, onTest }: { state: PushState | null; busy: boolean; testing: boolean; onEnable: () => void; onDisable: () => void; onTest: () => void }) {
  if (!state) return null;
  const test = (
    <button type="button" onClick={onTest} disabled={testing} className="flex-shrink-0 text-[12px] font-semibold text-[var(--color-primary)] hover:underline disabled:opacity-50">
      {testing ? "Sending…" : "Send a test"}
    </button>
  );
  return (
    <div className="border-t border-[var(--color-line)] bg-[var(--color-paper)]/70 px-4 py-3">
      {state === "on" ? (
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
            <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
            Browser notifications are on
          </span>
          <span className="flex items-center gap-3">
            {test}
            <button type="button" onClick={onDisable} disabled={busy} className="font-semibold text-[var(--color-muted)] hover:text-[var(--color-ink)] disabled:opacity-50">
              Turn off
            </button>
          </span>
        </div>
      ) : state === "off" ? (
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-[12px] leading-snug text-[var(--color-muted)]">Get these on your computer or phone, even when Liston isn&apos;t open.</p>
          <button type="button" onClick={onEnable} disabled={busy} className="btn btn-primary btn-sm flex-shrink-0">
            {busy ? "Turning on…" : "Turn on"}
          </button>
        </div>
      ) : state === "blocked" ? (
        <p className="text-[12px] leading-snug text-amber-800">Notifications are blocked for Liston in this browser. Allow them in the site settings (the icon left of the address), then turn them on here.</p>
      ) : state === "unsupported" ? (
        <p className="text-[12px] leading-snug text-[var(--color-muted)]">This browser can&apos;t show notifications. They&apos;ll still be here.</p>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] leading-snug text-[var(--color-muted)]">Browser notifications aren&apos;t set up on this server yet.</p>
          {test}
        </div>
      )}
      {(state === "off" || state === "blocked" || state === "unsupported") && (
        <p className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-[var(--color-muted)]">
          <span>See how one looks while Liston is open.</span>
          {test}
        </p>
      )}
      {state === "on" && (
        <p className="mt-1.5 text-[11px] leading-snug text-[var(--color-muted)]">
          No pop-up when Liston is in the background? Allow notifications for your browser in your computer&apos;s settings (on a Mac: System Settings, Notifications).
        </p>
      )}
    </div>
  );
}

function ToastCard({ toast, onOpen, onClose }: { toast: Toast; onOpen: () => void; onClose: () => void }) {
  const k = (toast.kind && KIND[toast.kind]) || OTHER;
  return (
    <div role="status" aria-live="polite" className="fixed right-4 top-[68px] z-[70] w-[min(380px,calc(100vw-32px))] animate-[fadeIn_200ms_ease-out] overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[0_22px_56px_-14px_rgba(15,23,42,0.35)]">
      <div className="flex gap-3 p-4">
        <span className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${k.ring}`}>
          <svg viewBox="0 0 20 20" fill="none" className="h-[18px] w-[18px]" aria-hidden>
            {k.icon}
          </svg>
        </span>
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Liston</span>
          <span className="mt-0.5 block text-[13.5px] font-semibold leading-snug text-[var(--color-ink)]">{toast.title}</span>
          {toast.body && <span className="mt-0.5 line-clamp-3 block text-[12.5px] leading-snug text-[var(--color-muted)]">{toast.body}</span>}
        </button>
        <button type="button" onClick={onClose} aria-label="Dismiss" className="-mr-1 -mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
            <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {toast.url && (
        <button type="button" onClick={onOpen} className="w-full border-t border-[var(--color-line)] py-2 text-[12.5px] font-semibold text-[var(--color-primary)] hover:bg-[var(--color-paper)]">
          Open the product
        </button>
      )}
    </div>
  );
}

export function NotificationBell() {
  const router = useRouter();
  const [data, setData] = useState<NotificationList | null>(null);
  const [open, setOpen] = useState(false);
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // The notifications this tab has already seen: a new unread one pops up.
  const seen = useRef<Set<string> | null>(null);

  // The last one popped up, so a push and a poll never show the same one twice.
  const shown = useRef<string | null>(null);
  const show = useCallback((t: Toast) => {
    seen.current?.add(t.id);
    if (document.visibilityState !== "visible" || shown.current === t.id) return;
    shown.current = t.id;
    setToast(t);
    chime();
  }, []);

  // announce: pop up what's new (a push arriving, a poll while in view); coming
  // back to the tab only updates the bell, since the system already showed it.
  const load = useCallback(async (announce = true) => {
    try {
      const next = await api.notifications();
      const before = seen.current;
      seen.current = new Set(next.items.map((n) => n.id));
      if (before && announce) {
        const fresh = next.items.find((n) => !n.readAt && !before.has(n.id));
        if (fresh) show({ id: fresh.id, kind: fresh.kind, title: fresh.title, body: fresh.body, url: fresh.url });
      }
      setData(next);
      setPush(await pushState(next.push.available));
    } catch {
      // The bell stays as it was; the next poll tries again.
    }
  }, [show]);

  useEffect(() => {
    const first = setTimeout(() => load(false), 0);
    refreshPush();
    // Every 30 seconds while the tab is seen, and at once when it comes back or a push arrives.
    const timer = setInterval(() => document.visibilityState === "visible" && load(), 30_000);
    const onFocus = () => load(false);
    // A push arrived: its card comes straight from it, then the bell catches up.
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== "liston:notification") return;
      if (e.data.id) show({ id: e.data.id, kind: e.data.kind || null, title: e.data.title, body: e.data.body || null, url: e.data.url || null });
      load(false);
    };
    window.addEventListener("focus", onFocus);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [load, show]);

  // The card goes by itself after a while.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  // Closed by a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function openOne(id: string, url: string | null, read: boolean) {
    setOpen(false);
    setToast(null);
    if (!read) api.notificationsRead([id]).then(setData).catch(() => {});
    if (url) router.push(url);
  }

  async function readAll() {
    try {
      setData(await api.notificationsRead());
    } catch {}
  }

  async function turnOn() {
    if (!data?.push.publicKey) return;
    setBusy(true);
    setPushError(null);
    try {
      setPush(await enablePush(data.push.publicKey));
    } catch {
      setPushError("Couldn't turn them on in this browser. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      setPush(await disablePush());
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    try {
      const res = await api.notificationsTest();
      setOpen(false);
      setData(res);
      const t = res.items[0];
      if (t) show({ id: t.id, kind: t.kind, title: t.title, body: t.body, url: t.url });
    } catch {
      setPushError("Couldn't send a test. Try again.");
    } finally {
      setTesting(false);
    }
  }

  const unread = data?.unread || 0;
  const items = data?.items || [];
  const on = push === "on";
  const label = `Notifications${unread ? `, ${unread} unread` : ""}${push ? (on ? " (browser notifications on)" : " (browser notifications off)") : ""}`;

  return (
    <div ref={box} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        title={on ? "Notifications: on in this browser" : "Notifications: browser notifications are off"}
        aria-expanded={open}
        className={`relative flex h-9 w-9 items-center justify-center rounded-full border transition-colors ${
          open
            ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
            : on
              ? "border-indigo-200 bg-[var(--color-primary-soft)] text-[var(--color-primary)] hover:border-[var(--color-primary)]"
              : "border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-muted)] hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
        }`}
      >
        <BellIcon off={push !== null && !on} />
        {/* On in this browser: a green dot at the foot of the bell. */}
        {on && <span className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-[var(--color-paper)]" aria-hidden />}
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-600 px-1 text-[10.5px] font-bold leading-none text-white ring-2 ring-[var(--color-paper)]">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-x-3 top-16 z-50 overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[0_18px_48px_-12px_rgba(15,23,42,0.28)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-[380px]">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-line)] px-4 py-3">
            <p className="text-[13.5px] font-semibold text-[var(--color-ink)]">
              Notifications
              {unread > 0 && <span className="ml-1.5 text-[12px] font-medium text-[var(--color-muted)]">{unread} new</span>}
            </p>
            {unread > 0 && (
              <button type="button" onClick={readAll} className="text-[12px] font-semibold text-[var(--color-primary)] hover:underline">
                Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <div className="px-6 py-9 text-center">
              <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                <BellIcon />
              </span>
              <p className="mt-2.5 text-[13px] font-medium text-[var(--color-ink)]">Nothing yet</p>
              <p className="mt-0.5 text-[12px] text-[var(--color-muted)]">You&apos;ll hear here when a reviewer decides on a product you hunted.</p>
            </div>
          ) : (
            <ul className="max-h-[min(420px,60vh)] divide-y divide-[var(--color-line)] overflow-y-auto">
              {items.map((n) => {
                const k = KIND[n.kind] || OTHER;
                return (
                  <li key={n.id}>
                    <button type="button" onClick={() => openOne(n.id, n.url, Boolean(n.readAt))} className={`flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-paper)] ${n.readAt ? "" : "bg-[var(--color-primary-soft)]/35"}`}>
                      <span className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${k.ring}`}>
                        <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
                          {k.icon}
                        </svg>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[13px] ${n.readAt ? "font-medium text-[var(--color-ink)]" : "font-semibold text-[var(--color-ink)]"}`}>{n.title}</span>
                        {n.body && <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-[var(--color-muted)]">{n.body}</span>}
                        <span className="mt-1 block text-[11px] text-[var(--color-muted)]">{ago(n.createdAt)}</span>
                      </span>
                      {!n.readAt && <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-[var(--color-primary)]" aria-label="Unread" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <PushControl state={push} busy={busy} testing={testing} onEnable={turnOn} onDisable={turnOff} onTest={sendTest} />
          {pushError && <p className="border-t border-[var(--color-line)] px-4 py-2 text-[12px] text-[var(--color-danger)]">{pushError}</p>}
        </div>
      )}

      {toast && <ToastCard toast={toast} onOpen={() => openOne(toast.id, toast.url, false)} onClose={() => setToast(null)} />}
    </div>
  );
}

/**
 * After a hunter adds a product: an offer to be told when it's reviewed,
 * only while this browser could show notifications and hasn't been set up.
 */
export function PushPrompt() {
  const [key, setKey] = useState<string | null>(null);
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .notifications()
      .then(async (n) => {
        const s = await pushState(n.push.available);
        if (live) {
          setKey(n.push.publicKey);
          setState(s);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (state !== "off" || !key) return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          setState(await enablePush(key));
        } catch {
          setBusy(false);
        }
      }}
      className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-emerald-800 underline-offset-2 hover:underline disabled:opacity-60"
    >
      <BellIcon />
      {busy ? "Turning on…" : "Notify me when it's reviewed"}
    </button>
  );
}
