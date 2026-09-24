"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";

// The header's "Updated … ↻" for a page that doesn't hold the synced time
// itself: the page reports how fresh its data is (`setSyncedAt`), and a
// refresh re-reads the account from eBay and bumps `reloadKey` so the page
// loads again. Same wording as Orders and Listings.
export function useAccountRefresh(connectionId: string | undefined) {
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  async function onRefresh() {
    if (!connectionId) return;
    setRefreshing(true);
    setNote(null);
    try {
      await api.refreshConnection(connectionId);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setNote(err instanceof ApiError && err.status === 429 ? "Refreshed under a minute ago" : "Couldn't refresh from eBay");
      setTimeout(() => setNote(null), 6000);
    } finally {
      setRefreshing(false);
    }
  }

  return { sync: { syncedAt, onRefresh, refreshing, note }, setSyncedAt, reloadKey };
}
