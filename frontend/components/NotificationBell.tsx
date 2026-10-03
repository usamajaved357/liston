"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, NotificationList } from "@/lib/api";
import { disablePush, enablePush, pushState, PushState, refreshPush } from "@/lib/push";
import { ago } from "@/components/hunting/HuntBits";
import { useMyEvents } from "@/lib/useMyEvents";
import { useVoicePopupOpen } from "@/lib/voicePlayback";
import { currentTeam } from "@/lib/team";

// The bell in the page header: what Liston has told this person (a reviewer
// approved, rejected, sent back or removed one of their hunted products, a
// team chat or buyer message), newest first, and the switch for browser
// notifications, which reach them even when Liston isn't open. While Liston
// is open and in view, a new one also pops up as a card with a chime,
// whatever the computer's own notification settings (the system
// notification is for when it isn't): NotificationPopups, on every
// signed-in page, bell or not.

// `at`: when its line last moved. A chat or buyer conversation keeps one line
// (one id) that each new message moves up, so a notification is new by both.
type Toast = { id: string; at?: string | null; kind: string | null; title: string; body: string | null; url: string | null };
const keyOf = (t: { id: string; at?: string | null }) => (t.at ? `${t.id}@${t.at}` : t.id);

type Kind = { label: string; ring: string; chip: string; note: string; icon: React.ReactNode };
const KIND: Record<string, Kind> = {
  "hunt.approved": {
    label: "Approved",
    ring: "bg-emerald-50 text-emerald-600 ring-emerald-200",
    chip: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    note: "border-emerald-300",
    icon: <path d="M5 10.5l3.2 3.2L15 6.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />,
  },
  "hunt.rejected": {
    label: "Rejected",
    ring: "bg-rose-50 text-rose-600 ring-rose-200",
    chip: "bg-rose-50 text-rose-700 ring-rose-200",
    note: "border-rose-300",
    icon: <path d="M6.5 6.5l7 7M13.5 6.5l-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />,
  },
  "hunt.sent_back": {
    label: "Sent back",
    ring: "bg-amber-50 text-amber-600 ring-amber-200",
    chip: "bg-amber-50 text-amber-800 ring-amber-200",
    note: "border-amber-300",
    icon: <path d="M8 6L4.5 9.5 8 13M5 9.5h7a3.5 3.5 0 010 7h-1" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />,
  },
  "hunt.removed": {
    label: "Removed",
    ring: "bg-slate-100 text-slate-500 ring-slate-200",
    chip: "bg-slate-100 text-slate-600 ring-slate-200",
    note: "border-slate-300",
    icon: <path d="M5 6.5h10M8.5 6.5V5h3v1.5M6.5 6.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />,
  },
  // The workspace owner made you a co-manager (owner access), or stopped it.
  "team.owner_access_given": {
    label: "Co-manager",
    ring: "bg-indigo-50 text-indigo-600 ring-indigo-200",
    chip: "bg-indigo-50 text-indigo-700 ring-indigo-200",
    note: "border-indigo-300",
    icon: (
      <>
        <circle cx="7" cy="7.5" r="3.6" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9.6 10.1L16.5 17M13.6 14.1l1.7-1.7M15.2 15.7l1.4-1.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ),
  },
  "team.owner_access_removed": {
    label: "Access changed",
    ring: "bg-slate-100 text-slate-500 ring-slate-200",
    chip: "bg-slate-100 text-slate-600 ring-slate-200",
    note: "border-slate-300",
    icon: (
      <>
        <circle cx="7" cy="7.5" r="3.6" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9.6 10.1L16.5 17M13.6 14.1l1.7-1.7M15.2 15.7l1.4-1.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ),
  },
  // Another workspace owner added you to their workspace.
  "team.added": {
    label: "New workspace",
    ring: "bg-teal-50 text-teal-600 ring-teal-200",
    chip: "bg-teal-50 text-teal-700 ring-teal-200",
    note: "border-teal-300",
    icon: (
      <>
        <circle cx="8" cy="7" r="2.6" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3.5 15.5c0-2.5 2-4.2 4.5-4.2s4.5 1.7 4.5 4.2M15 6.5v5M12.5 9h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ),
  },
  // Invited to another workspace: the link opens the invitation.
  "team.invited": {
    label: "Invitation",
    ring: "bg-teal-50 text-teal-600 ring-teal-200",
    chip: "bg-teal-50 text-teal-700 ring-teal-200",
    note: "border-teal-300",
    icon: <path d="M3.5 6.5l6.5 4.5 6.5-4.5M4.5 5h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V6a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  },
  // Someone you invited joined: the link opens their access.
  "team.joined": {
    label: "New member",
    ring: "bg-emerald-50 text-emerald-600 ring-emerald-200",
    chip: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    note: "border-emerald-300",
    icon: (
      <>
        <circle cx="8" cy="7" r="2.6" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3.5 15.5c0-2.5 2-4.2 4.5-4.2s4.5 1.7 4.5 4.2M12.5 9.5l1.8 1.8 3.2-3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  // A buyer's new eBay message, and a conversation given to you.
  "inbox.message": {
    label: "Buyer message",
    ring: "bg-sky-50 text-sky-600 ring-sky-200",
    chip: "bg-sky-50 text-sky-700 ring-sky-200",
    note: "border-sky-300",
    icon: <path d="M5 5.5h10a1 1 0 011 1v6a1 1 0 01-1 1H9.5L6.5 16v-2.5H5a1 1 0 01-1-1v-6a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />,
  },
};
const OTHER: Kind = {
  label: "Liston",
  ring: "bg-indigo-50 text-indigo-600 ring-indigo-200",
  chip: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  note: "border-indigo-300",
  icon: <path d="M6.5 13.5V9.5a3.5 3.5 0 117 0v4l1 1.3h-9l1-1.3zM8.8 16.3a1.3 1.3 0 002.4 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
};
const kindOf = (kind: string | null | undefined) => (kind && KIND[kind]) || OTHER;

// Today / Yesterday / Earlier, by this computer's own day.
function dayGroup(iso: string) {
  const d = new Date(iso);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (d >= start) return "Today";
  start.setDate(start.getDate() - 1);
  if (d >= start) return "Yesterday";
  return "Earlier";
}

function BellIcon({ off = false, className = "h-4 w-4" }: { off?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M6 16.5V11a6 6 0 1112 0v5.5l1.5 2h-15l1.5-2z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M10 20.5a2.2 2.2 0 004 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      {off && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />}
    </svg>
  );
}

// A sharp two-note "ding-ding", made in the browser (no sound file): high,
// bright notes (a triangle wave with a ringing overtone) that start at once
// and fall away quickly. Browsers only play sound once the person has
// clicked or typed on the page; before that it's skipped quietly.
let audio: AudioContext | null = null;
function chime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio = audio || new Ctx();
    if (audio.state === "suspended") audio.resume().catch(() => {});
    const ctx = audio;
    const now = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = 1.25;
    out.connect(ctx.destination);
    const note = (freq: number, at: number, length: number) => {
      // The body of the note, and an overtone an octave and a fifth up for the "ping".
      for (const [type, mult, level] of [
        ["triangle", 1, 0.34],
        ["sine", 3, 0.12],
      ] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq * mult, now + at);
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(level, now + at + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + length);
        osc.connect(gain).connect(out);
        osc.start(now + at);
        osc.stop(now + at + length + 0.02);
      }
    };
    note(1760, 0, 0.18); // A6
    note(2349.3, 0.11, 0.34); // D7
  } catch {
    // No sound; the card still shows.
  }
}

function Switch({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-emerald-500" : "bg-slate-300 hover:bg-slate-400"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

// Browser notifications for this browser: a switch, what it means, and a test.
function PushControl({ state, busy, testing, onEnable, onDisable, onTest }: { state: PushState | null; busy: boolean; testing: boolean; onEnable: () => void; onDisable: () => void; onTest: () => void }) {
  if (!state) return null;
  const on = state === "on";
  const status =
    state === "on"
      ? "On in this browser"
      : state === "off"
        ? "Get them even when Liston is closed"
        : state === "blocked"
          ? "Blocked: allow from the icon left of the address"
          : state === "unsupported"
            ? "This browser can't show them"
            : "Not set up on this server yet";
  return (
    <div className="border-t border-[var(--color-line)] bg-[var(--color-paper)]/70 px-3.5 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${on ? "bg-emerald-50 text-emerald-600 ring-emerald-200" : "bg-white text-[var(--color-muted)] ring-[var(--color-line)]"}`}>
          <BellIcon off={!on} className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold leading-tight text-[var(--color-ink)]">Browser notifications</p>
          <p className={`truncate text-[11px] leading-tight ${state === "blocked" ? "text-amber-700" : on ? "text-emerald-700" : "text-[var(--color-muted)]"}`} title={on ? "Nothing in the background? Allow your browser in your computer's notification settings." : undefined}>
            {status}
          </p>
        </div>
        <button type="button" onClick={onTest} disabled={testing} className="flex-shrink-0 text-[11.5px] font-semibold text-[var(--color-primary)] hover:underline disabled:opacity-50">
          {testing ? "Sending…" : "Test"}
        </button>
        {(state === "on" || state === "off") && <Switch on={on} disabled={busy} onChange={on ? onDisable : onEnable} label="Browser notifications" />}
      </div>
    </div>
  );
}

/** What the card's button opens: a hunted product, a chat thread or conversation, else just "Open". */
function openLabel(toast: Toast): string {
  if (toast.kind?.startsWith("hunt.")) return "Open the product";
  if (toast.kind === "chat.message") return toast.url?.includes("&t=") ? "Open the thread" : "Open the conversation";
  if (toast.kind?.includes("message")) return "Open the conversation";
  if (toast.kind === "team.added") return "Open the workspace";
  if (toast.kind === "team.invited") return "Open the invitation";
  if (toast.kind === "team.joined") return "Choose their access";
  if (toast.kind?.startsWith("team.owner_access")) return "Reload Liston";
  return "Open";
}

function ToastCard({ toast, onOpen, onClose }: { toast: Toast; onOpen: () => void; onClose: () => void }) {
  const k = kindOf(toast.kind);
  // Under the voice note playing, when its pop-up is up there.
  const below = useVoicePopupOpen();
  return (
    <div role="status" aria-live="polite" className={`fixed right-4 ${below ? "top-[162px]" : "top-[68px]"} z-[70] w-[min(380px,calc(100vw-32px))] animate-[fadeIn_200ms_ease-out] overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[0_22px_56px_-14px_rgba(15,23,42,0.35)]`}>
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
          {openLabel(toast)}
        </button>
      )}
    </div>
  );
}

// ---- what's new, on every signed-in page ------------------------------------------
//
// The service worker leaves a push to a Liston tab that's in view (sw.js),
// so every signed-in page has to be able to show it, not only the ones with
// a bell in their header: NotificationPopups sits in the frame every
// signed-in page is in (ShellFrame). It pops a new notification up as a card
// with a chime (from a push, the live channel or a poll while in view), ties
// this browser's push to whoever signed in (once per sign-in), and hands
// each list it reads to the bell, if there is one on the page.

/** Opens what a notification is about, in its team: another team's, or a change to one's access, loads Liston again there. */
function openNotification(router: ReturnType<typeof useRouter>, url: string | null, kind?: string | null) {
  const team = url ? new URLSearchParams(url.split("?")[1] || "").get("ws") : null;
  if (url && (kind?.startsWith("team.") || (team && team !== currentTeam()))) window.location.assign(url);
  else if (url) router.push(url);
}

// The notifications this tab has already had (keyOf: a line and when it last moved), for the sign-in they came to.
let known: { token: string; ids: Set<string> } | null = null;
// The sign-in this browser's push subscription was last tied to.
let linkedFor: string | null = null;
// The bell on the page, if any, kept in step with each list read here.
const lists = new Set<(list: NotificationList) => void>();
// The popper on the page: the bell's Test pops up through it.
const poppers = new Set<(t: Toast) => void>();

const signedIn = () => {
  try {
    return localStorage.getItem("token");
  } catch {
    return null;
  }
};

export function NotificationPopups() {
  const router = useRouter();
  const [toast, setToast] = useState<Toast | null>(null);
  // The last one popped up: a push and the live channel bring the same message within a moment of each other.
  const shown = useRef<{ key: string; id: string; time: number } | null>(null);

  const show = useCallback((t: Toast) => {
    const key = keyOf(t);
    known?.ids.add(key);
    if (document.visibilityState !== "visible") return;
    const last = shown.current;
    if (last?.key === key) return;
    // The same line again a moment later (the other route, or the next message straight after): the card says the latest, one chime.
    const again = last?.id === t.id && Date.now() - last.time < 3000;
    shown.current = { key, id: t.id, time: Date.now() };
    setToast(t);
    if (!again) chime();
  }, []);

  // Reads the list; with `fresh`, pops up the newest unread one this tab hasn't had yet.
  const check = useCallback(
    async (fresh: boolean) => {
      const token = signedIn();
      if (!token) return;
      try {
        const list = await api.notifications();
        const before = known?.token === token ? known.ids : null;
        known = { token, ids: new Set([...(before || []), ...list.items.map((n) => keyOf({ id: n.id, at: n.createdAt }))]) };
        lists.forEach((fn) => fn(list));
        if (!before || !fresh) return;
        const next = list.items.find((n) => !n.readAt && !before.has(keyOf({ id: n.id, at: n.createdAt })));
        if (next) show({ id: next.id, at: next.createdAt, kind: next.kind, title: next.title, body: next.body, url: next.url });
      } catch {
        // The next change or poll tries again.
      }
    },
    [show]
  );

  // Live: the server says when a line is added (or read); a new one pops up at once.
  useMyEvents((e) => {
    if (e.type === "notifications.changed") check(true);
  });

  useEffect(() => {
    const token = signedIn();
    // This browser's push goes to whoever is signed in now (a changed password unties every browser).
    if (token && linkedFor !== token) {
      linkedFor = token;
      refreshPush();
    }
    // What's there already is known, not new; then a poll every 30 seconds while in view, in case the live channel drops.
    const first = setTimeout(() => check(false), 0);
    const timer = setInterval(() => document.visibilityState === "visible" && check(true), 30_000);
    // A push arrived: its card comes straight from it, then the bell catches up.
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== "liston:notification") return;
      if (e.data.id) show({ id: e.data.id, at: e.data.at || null, kind: e.data.kind || null, title: e.data.title, body: e.data.body || null, url: e.data.url || null });
      check(false);
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    poppers.add(show);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
      poppers.delete(show);
    };
  }, [check, show]);

  // The card goes by itself after a while.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  return (
    <ToastCard
      toast={toast}
      onOpen={() => {
        setToast(null);
        api
          .notificationsRead([toast.id])
          .then((list) => lists.forEach((fn) => fn(list)))
          .catch(() => {});
        openNotification(router, toast.url, toast.kind);
      }}
      onClose={() => setToast(null)}
    />
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
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [confirmClear, setConfirmClear] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const take = useCallback(async (next: NotificationList) => {
    setData(next);
    setPush(await pushState(next.push.available));
  }, []);

  const load = useCallback(async () => {
    try {
      await take(await api.notifications());
    } catch {
      // The bell stays as it was; the next change or poll tries again.
    }
  }, [take]);

  // Every list read on the page (a change on the live channel, a push, a poll) comes here too.
  useEffect(() => {
    const first = setTimeout(load, 0);
    lists.add(take);
    // Coming back to the tab: the bell catches up (the system showed what came meanwhile).
    window.addEventListener("focus", load);
    return () => {
      clearTimeout(first);
      lists.delete(take);
      window.removeEventListener("focus", load);
    };
  }, [load, take]);

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

  function openOne(id: string, url: string | null, read: boolean, kind?: string | null) {
    setOpen(false);
    if (!read) api.notificationsRead([id]).then(take).catch(() => {});
    openNotification(router, url, kind);
  }

  async function readAll() {
    try {
      setData(await api.notificationsRead());
    } catch {}
  }

  async function clearOne(id: string) {
    try {
      setData(await api.notificationsClear([id]));
    } catch {}
  }

  // Clear all asks once more, for a few seconds.
  async function clearAll() {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3500);
      return;
    }
    setConfirmClear(false);
    try {
      setData(await api.notificationsClear());
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
      await take(res);
      const t = res.items[0];
      if (t) poppers.forEach((pop) => pop({ id: t.id, at: t.createdAt, kind: t.kind, title: t.title, body: t.body, url: t.url }));
    } catch {
      setPushError("Couldn't send a test. Try again.");
    } finally {
      setTesting(false);
    }
  }

  const unread = data?.unread || 0;
  const items = data?.items || [];
  const shownItems = filter === "unread" ? items.filter((n) => !n.readAt) : items;
  const groups = shownItems.reduce<{ label: string; items: typeof items }[]>((acc, n) => {
    const label = dayGroup(n.createdAt);
    const last = acc[acc.length - 1];
    if (last && last.label === label) last.items.push(n);
    else acc.push({ label, items: [n] });
    return acc;
  }, []);
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
        className={`relative flex h-8 w-8 items-center justify-center rounded-full border transition-colors ${
          open
            ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
            : on
              ? "border-indigo-200 bg-[var(--color-primary-soft)] text-[var(--color-primary)] hover:border-[var(--color-primary)]"
              : "border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-muted)] hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
        }`}
      >
        <BellIcon off={push !== null && !on} />
        {/* On in this browser: a green dot at the foot of the bell. */}
        {on && <span className="absolute bottom-0 right-0 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-[var(--color-paper)]" aria-hidden />}
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-[var(--color-paper)]">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-x-3 top-16 z-50 flex max-h-[min(560px,calc(100dvh-88px))] flex-col overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-[0_18px_44px_-14px_rgba(15,23,42,0.3)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-[344px]">
          {/* Header: the count, read all, clear all; then All / Unread. */}
          <div className="flex-shrink-0 border-b border-[var(--color-line)] px-3.5 pb-2.5 pt-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="text-[13.5px] font-semibold text-[var(--color-ink)]">Notifications</h3>
                {unread > 0 && <span className="rounded-full bg-[var(--color-primary)] px-1.5 py-px text-[10.5px] font-semibold text-white">{unread} new</span>}
              </div>
              {items.length > 0 && (
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={readAll}
                    disabled={unread === 0}
                    title="Mark all as read"
                    className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11.5px] font-semibold text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] disabled:pointer-events-none disabled:opacity-40"
                  >
                    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                      <path d="M2.5 10.5l3 3L12 7M8.5 13.5L15 7M17.5 7l-6.5 6.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Read all
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    title="Clear all notifications"
                    className={`inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11.5px] font-semibold transition-colors ${confirmClear ? "bg-rose-600 text-white hover:bg-rose-700" : "text-[var(--color-muted)] hover:bg-rose-50 hover:text-rose-600"}`}
                  >
                    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                      <path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {confirmClear ? "Clear all?" : "Clear"}
                  </button>
                </div>
              )}
            </div>
            {items.length > 0 && (
              <div className="mt-2 inline-flex rounded-full bg-[var(--color-paper)] p-0.5 ring-1 ring-inset ring-[var(--color-line)]">
                {(["all", "unread"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={`h-6 rounded-full px-2.5 text-[11.5px] font-semibold transition-colors ${filter === f ? "bg-white text-[var(--color-ink)] shadow-sm ring-1 ring-[var(--color-line)]" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"}`}
                  >
                    {f === "all" ? "All" : `Unread${unread ? ` (${unread})` : ""}`}
                  </button>
                ))}
              </div>
            )}
          </div>

          {shownItems.length === 0 ? (
            <div className="flex-1 px-6 py-7 text-center">
              <span className="relative mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-50 to-[var(--color-primary-soft)] text-[var(--color-primary)] ring-1 ring-inset ring-indigo-100">
                <BellIcon className="h-5 w-5" />
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-white">
                  <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" aria-hidden>
                    <path d="M5 10.5l3.2 3.2L15 6.8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </span>
              <p className="mt-2.5 text-[13px] font-semibold text-[var(--color-ink)]">{filter === "unread" && items.length ? "You're all caught up" : "No notifications"}</p>
              <p className="mx-auto mt-0.5 max-w-[240px] text-[11.5px] leading-relaxed text-[var(--color-muted)]">
                {filter === "unread" && items.length ? "Nothing unread. Earlier ones are under All." : "When a reviewer approves, rejects or sends back a product you hunted, it shows up here."}
              </p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {groups.map((g) => (
                <div key={g.label}>
                  <p className="sticky top-0 z-[1] bg-[var(--color-panel)]/95 px-3.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-muted)] backdrop-blur">{g.label}</p>
                  <ul>
                    {g.items.map((n) => {
                      const k = kindOf(n.kind);
                      const d = n.detail || {};
                      const structured = Boolean(d.product);
                      return (
                        <li key={n.id} className="group relative">
                          <button
                            type="button"
                            onClick={() => openOne(n.id, n.url, Boolean(n.readAt), n.kind)}
                            className={`relative flex w-full gap-2.5 py-2.5 pl-3.5 pr-9 text-left transition-colors hover:bg-[var(--color-paper)] ${n.readAt ? "" : "bg-[var(--color-primary-soft)]/30"}`}
                          >
                            {!n.readAt && <span className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-r-full bg-[var(--color-primary)]" aria-label="Unread" />}
                            <span className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${k.ring}`}>
                              <svg viewBox="0 0 20 20" fill="none" className="h-[15px] w-[15px]" aria-hidden>
                                {k.icon}
                              </svg>
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className={`inline-flex h-[18px] items-center rounded-full px-1.5 text-[10px] font-semibold ring-1 ring-inset ${k.chip}`}>{structured ? k.label : n.kind === "test" ? "Test" : k.label}</span>
                                <span className="text-[10.5px] text-[var(--color-muted)]">{ago(n.createdAt)}</span>
                              </span>
                              <span className={`mt-1 line-clamp-2 block text-[12.5px] leading-snug text-[var(--color-ink)] ${n.readAt ? "font-medium" : "font-semibold"}`}>{structured ? d.product : n.title}</span>
                              <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--color-muted)]">
                                {structured ? (
                                  <>
                                    {d.by ? (
                                      <>
                                        by <b className="font-semibold text-[var(--color-ink)]">{d.by}</b>
                                      </>
                                    ) : (
                                      "by a reviewer"
                                    )}
                                    {d.reason ? ` · ${d.reason}` : ""}
                                  </>
                                ) : (
                                  n.body
                                )}
                              </span>
                              {structured && d.note && (
                                <span className={`mt-1.5 block rounded-r-md border-l-2 bg-[var(--color-paper)] px-2 py-1 text-[11.5px] leading-snug text-[var(--color-ink)] ${k.note}`}>“{d.note}”</span>
                              )}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => clearOne(n.id)}
                            aria-label="Clear this notification"
                            title="Clear"
                            className="absolute right-2 top-2.5 flex h-6 w-6 items-center justify-center rounded-full text-[var(--color-muted)] opacity-0 transition hover:bg-white hover:text-rose-600 hover:shadow-sm focus-visible:opacity-100 group-hover:opacity-100 max-sm:opacity-100"
                          >
                            <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                              <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                            </svg>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}

          <div className="flex-shrink-0">
            <PushControl state={push} busy={busy} testing={testing} onEnable={turnOn} onDisable={turnOff} onTest={sendTest} />
            {pushError && <p className="border-t border-[var(--color-line)] px-4 py-2 text-[12px] text-[var(--color-danger)]">{pushError}</p>}
          </div>
        </div>
      )}
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
