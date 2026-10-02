"use client";

import { useEffect, useRef } from "react";
import { useState } from "react";
import { ebayInboxApi, inboxApi } from "@/lib/api";
import { setChatUnread, useChatUnreadValue, useMyEvents } from "@/lib/useMyEvents";

// The Inbox item's count in the sidebar: unread team chat (muted
// conversations left out) and new replies in threads the person follows,
// kept current from the live channel.
export function useInboxBadge(): number {
  const value = useChatUnreadValue();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      inboxApi.chatUnread().then(setChatUnread).catch(() => {});
    }, 300);
  };
  useEffect(() => {
    inboxApi.chatUnread().then(setChatUnread).catch(() => {});
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useMyEvents((e) => {
    if (e.type === "chat.message" || e.type === "chat.read" || e.type === "chat.conversation" || e.type === "chat.updated" || e.type === "chat.thread") refresh();
  }, refresh);
  return value.unread + value.threads;
}

// An account's Inbox item: how many of its buyers' and eBay's conversations
// are unread (the Inbox on an account is its eBay messages). Read when the
// page opens and again when Liston hears the account's messages changed;
// the open Inbox tells it at once as conversations are read
// ("liston:inbox-unread").
export function useAccountInboxBadge(connectionId: string, enabled: boolean): number {
  const [unread, setUnread] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      ebayInboxApi
        .unread(connectionId)
        .then((r) => setUnread(r.unread))
        .catch(() => {});
    }, 300);
  };
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    ebayInboxApi
      .unread(connectionId)
      .then((r) => live && setUnread(r.unread))
      .catch(() => {});
    const onCounts = (e: Event) => {
      const detail = (e as CustomEvent<{ connectionId: string; unread: number }>).detail;
      if (detail?.connectionId === connectionId) setUnread(detail.unread);
    };
    window.addEventListener("liston:inbox-unread", onCounts);
    return () => {
      live = false;
      window.removeEventListener("liston:inbox-unread", onCounts);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [connectionId, enabled]);
  useMyEvents((e) => {
    if (enabled && e.type === "inbox.updated" && e.connectionId === connectionId) load();
  }, () => enabled && load());
  return enabled ? unread : 0;
}
