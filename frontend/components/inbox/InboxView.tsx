"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PillTabs } from "@/components/PillTabs";
import { useChatUnreadValue } from "@/lib/useMyEvents";
import { TeamChat } from "./TeamChat";
import { EbayInbox } from "./ebay/EbayInbox";

// The Dashboard's Inbox, in two modes switched at the top: Team chat (the
// owner and their team, across every account) and eBay messages (buyers
// and eBay on every account). An account's Inbox is only its eBay messages
// (AccountInboxView). The mode and the open conversation are in the
// address (?mode=, ?c=, ?e=), so a notification or a shared link opens the
// right one.

export type InboxMode = "team" | "ebay";

// The address's inbox parts, and a way to change them without a new history entry.
function useInboxAddress() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
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
  return { search, go };
}

/** An account's Inbox: its eBay messages, the sync state in the page's header (`syncSlot`). */
export function AccountInboxView({ connectionId, isOwner, syncSlot }: { connectionId: string; isOwner: boolean; syncSlot: HTMLElement | null }) {
  const { search, go } = useInboxAddress();
  return <EbayInbox connectionId={connectionId} activeKey={search.get("e")} onActiveChange={(key) => go({ e: key })} reconnectHref={isOwner ? "/connections" : null} syncSlot={syncSlot} />;
}

export function InboxView({ me, isOwner, canSeeEbay = true }: { me: string; isOwner: boolean; canSeeEbay?: boolean }) {
  const { search, go } = useInboxAddress();
  const mode: InboxMode = search.get("mode") === "ebay" && canSeeEbay ? "ebay" : "team";
  const activeId = search.get("c");
  const unread = useChatUnreadValue();

  const modeSwitch = (
    <PillTabs
      tabs={[
        { key: "team" as const, label: "Team chat", count: unread.unread || undefined, countTone: unread.mentions ? "alert" : "default" },
        ...(canSeeEbay ? [{ key: "ebay" as const, label: "eBay messages" }] : []),
      ]}
      value={mode}
      onChange={(m) => go({ mode: m === "team" ? null : m, c: null, e: null })}
      label="Inbox"
    />
  );

  if (mode === "ebay") return <EbayInbox connectionId={null} activeKey={search.get("e")} onActiveChange={(key) => go({ e: key })} reconnectHref={isOwner ? "/connections" : null} modeSwitch={modeSwitch} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">{modeSwitch}</div>
      <div className="card flex min-h-0 flex-1 overflow-hidden">
        <TeamChat me={me} isOwner={isOwner} activeId={activeId} onActiveChange={(id) => go({ c: id })} />
      </div>
    </div>
  );
}
