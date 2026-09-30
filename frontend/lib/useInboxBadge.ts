"use client";

import { useEffect, useRef } from "react";
import { inboxApi } from "@/lib/api";
import { setChatUnread, useChatUnreadValue, useMyEvents } from "@/lib/useMyEvents";

// The Inbox item's count in the sidebar: unread team chat (muted
// conversations left out), kept current from the live channel.
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
    if (e.type === "chat.message" || e.type === "chat.read" || e.type === "chat.conversation" || e.type === "chat.updated") refresh();
  }, refresh);
  return value.unread;
}
