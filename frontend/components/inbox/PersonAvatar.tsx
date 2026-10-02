"use client";

import { colorFor, initialOf } from "./inbox-format";

// A person in the Inbox: their photo, else their initial on a steady colour,
// with a green dot while they're online. Round, or `square` (softly
// rounded, as Slack draws people beside their messages and in its sidebar).
export function PersonAvatar({ id, name, avatarUrl, size = 32, online, square = false }: { id: string | null | undefined; name: string | null | undefined; avatarUrl?: string | null; size?: number; online?: boolean; square?: boolean }) {
  const shape = square ? { borderRadius: Math.max(4, Math.round(size * 0.22)) } : { borderRadius: 9999 };
  return (
    <span className="relative inline-flex flex-shrink-0" style={{ width: size, height: size }}>
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className="h-full w-full object-cover" style={shape} />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-semibold text-white" style={{ ...shape, background: colorFor(id), fontSize: Math.max(10, Math.round(size * 0.42)) }} aria-hidden>
          {initialOf(name)}
        </span>
      )}
      {online && <span className={`absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-[var(--color-panel)] bg-emerald-500 ${size < 24 ? "h-2.5 w-2.5" : "h-3 w-3"}`} title="Online" />}
    </span>
  );
}
