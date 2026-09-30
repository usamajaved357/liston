// Small helpers the Inbox's two modes share: days, times, sizes, initials
// and a steady colour per person (their initial's circle).

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Today", "Yesterday", "Monday", "23 Sep", "23 Sep 2025". */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  const days = (now.getTime() - d.getTime()) / 86400000;
  if (days < 6) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** "14:05" (or "2:05 pm", as the viewer's locale has it). */
export const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** A list row's time: the time today, "Yesterday", the weekday, else the date. */
export function listTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return timeLabel(iso);
  return dayLabel(iso, now);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export const initialOf = (name: string | null | undefined) => (String(name || "?").trim()[0] || "?").toUpperCase();

// Muted, readable circles; one per person by their id, never by rank.
const CIRCLES = ["#4f46e5", "#0d9488", "#b45309", "#be185d", "#0369a1", "#7c3aed", "#15803d", "#c2410c"];
export function colorFor(id: string | null | undefined): string {
  let h = 0;
  for (const ch of String(id || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CIRCLES[h % CIRCLES.length];
}

/** Minutes after midnight as "22:00". */
export const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export function money(amount: number | null | undefined, currency = "GBP"): string {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return "";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(amount));
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

/** "5m", "3h", "2d": how long ago, short. */
export function shortAgo(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
