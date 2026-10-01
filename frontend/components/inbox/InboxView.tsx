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
// (AccountInboxView). The mode, the open conversation and its open thread
// are in the address (?mode=, ?c=, ?t=, ?e=), so a notification or a
// shared link opens the right one.

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

// The Dashboard's Inbox shows team chat only until the all-accounts eBay view is picked up again.
const SHOW_EBAY_MODE = false;

export function InboxView({ me, isOwner, canSeeEbay = true, tabsSlot = null }: { me: string; isOwner: boolean; canSeeEbay?: boolean; tabsSlot?: HTMLElement | null }) {
  const { search, go } = useInboxAddress();
  const mode: InboxMode = search.get("mode") === "ebay" && canSeeEbay ? "ebay" : "team";
  const activeId = search.get("c");
  const threadId = activeId ? search.get("t") : null;
  const openChat = useCallback((c: string | null, t: string | null = null) => go({ c, t: c ? t : null }), [go]);
  const unread = useChatUnreadValue();

  const modeSwitch = (
    <PillTabs
      tabs={[
        { key: "team" as const, label: "Team chat", count: unread.unread || undefined, countTone: unread.mentions ? "alert" : "default" },
        ...(canSeeEbay ? [{ key: "ebay" as const, label: "eBay messages" }] : []),
      ]}
      value={mode}
      onChange={(m) => go({ mode: m === "team" ? null : m, c: null, t: null, e: null })}
      label="Inbox"
    />
  );

  // Team chat only for now: every account's eBay messages here (the mode switch) come back later; each account's Inbox has its own.
  if (SHOW_EBAY_MODE && mode === "ebay") return <EbayInbox connectionId={null} activeKey={search.get("e")} onActiveChange={(key) => go({ e: key })} reconnectHref={isOwner ? "/connections" : null} modeSwitch={modeSwitch} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {SHOW_EBAY_MODE && <div className="flex flex-wrap items-center gap-3">{modeSwitch}</div>}
      <div className="card flex min-h-0 flex-1 overflow-hidden">
        <TeamChat me={me} isOwner={isOwner} activeId={activeId} threadId={threadId} onOpen={openChat} tabsSlot={tabsSlot} />
      </div>
    </div>
  );
}
