"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Connection management now lives on the dashboard itself — this route is
// kept only so old links/bookmarks land somewhere useful instead of a 404.
export default function ConnectionsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard");
  }, [router]);

  return (
    <main className="min-h-screen flex items-center justify-center">
      <p className="text-[var(--color-muted)] text-sm">Redirecting…</p>
    </main>
  );
}
