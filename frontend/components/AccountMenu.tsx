"use client";

import { Avatar } from "@/components/Avatar";

// The signed-in person's photo at the top right of a page: only the picture.
// Their settings are the sidebar's Settings and Log out is at its foot.
export function HeaderAvatar({ email, avatarUrl }: { email: string; avatarUrl?: string | null }) {
  return (
    <span className="flex flex-shrink-0 rounded-full" title={email}>
      <Avatar avatarUrl={avatarUrl} size={34} />
    </span>
  );
}
