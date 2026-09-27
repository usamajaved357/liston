"use client";

import { useEffect, useState } from "react";
import { api, Connection } from "@/lib/api";

// The viewer's accounts (an owner's all, a member's the ones they were
// given), fetched once per login and remembered for the session, for the
// sidebars' account switching. Keyed by the login token, so a different
// user in the same tab never sees the previous user's accounts.
let cached: { token: string; connections: Connection[] } | null = null;

function currentToken() {
  try {
    return localStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

export function useConnections(): Connection[] {
  const [connections, setConnections] = useState<Connection[]>(() => (cached && cached.token === currentToken() ? cached.connections : []));
  useEffect(() => {
    const token = currentToken();
    if (cached && cached.token === token) return;
    cached = null;
    api
      .listConnections()
      .then((data) => {
        cached = { token, connections: data.connections };
        setConnections(data.connections);
      })
      .catch(() => {});
  }, []);
  return connections;
}
