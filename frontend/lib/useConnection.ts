"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, Connection } from "@/lib/api";

export function useConnection(id: string) {
  const router = useRouter();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/login");
      return;
    }

    api
      .getConnection(id)
      .then((data) => setConnection(data.connection))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          localStorage.removeItem("token");
          router.replace("/login");
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setError("This account connection doesn't exist, or isn't yours.");
          return;
        }
        setError("Couldn't load this account.");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, router]);

  return { connection, loading, error };
}
