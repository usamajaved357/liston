"use client";

import { colorFor, initialOf } from "./inbox-format";

// A person in the Inbox: their photo, else their initial on a steady colour,
// with a green dot while they're online.
export function PersonAvatar({ id, name, avatarUrl, size = 32, online }: { id: string | null | undefined; name: string | null | undefined; avatarUrl?: string | null; size?: number; online?: boolean }) {
  return (
    <span className="relative inline-flex flex-shrink-0" style={{ width: size, height: size }}>
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white" style={{ background: colorFor(id), fontSize: Math.max(10, Math.round(size * 0.42)) }} aria-hidden>
          {initialOf(name)}
        </span>
      )}
      {online && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--color-panel)] bg-emerald-500" title="Online" />}
    </span>
  );
}
