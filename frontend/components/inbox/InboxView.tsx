"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PillTabs } from "@/components/PillTabs";
import { useChatUnreadValue } from "@/lib/useMyEvents";
import { TeamChat } from "./TeamChat";

// The Inbox, in two modes switched at the top: Team chat (the owner and
// their team, across every account) and eBay messages (buyers and eBay,
// for this account or all of them). The mode and the open conversation are
// in the address (?mode=, ?c=), so a notification or a shared link opens
// the right one.

export type InboxMode = "team" | "ebay";

export function InboxView({ me, isOwner, connectionId = null, canSeeEbay = true }: { me: string; isOwner: boolean; connectionId?: string | null; canSeeEbay?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const mode: InboxMode = search.get("mode") === "ebay" && canSeeEbay ? "ebay" : "team";
  const activeId = search.get("c");
  const unread = useChatUnreadValue();

  const go = useCallback(
    (next: Record<string, string | null>) => {
      const qs = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v) qs.set(k, v);
        else qs.delete(k);
      }
      router.replace(`${pathname}${qs.toString() ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, pathname, search]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PillTabs
          tabs={[
            { key: "team" as const, label: "Team chat", count: unread.unread || undefined, countTone: unread.mentions ? "alert" : "default" },
            ...(canSeeEbay ? [{ key: "ebay" as const, label: "eBay messages" }] : []),
          ]}
          value={mode}
          onChange={(m) => go({ mode: m === "team" ? null : m, c: null })}
          label="Inbox"
        />
      </div>
      <div className="card flex min-h-0 flex-1 overflow-hidden">
        {mode === "team" ? (
          <TeamChat me={me} isOwner={isOwner} activeId={activeId} onActiveChange={(id) => go({ c: id })} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <p className="text-[15px] font-semibold text-[var(--color-ink)]">eBay messages come next</p>
            <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-[var(--color-muted)]">
              Buyer questions and eBay&apos;s messages{connectionId ? " for this account" : " for every account"}, with the order and any return or case beside each conversation, are the next part of the Inbox being built.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
