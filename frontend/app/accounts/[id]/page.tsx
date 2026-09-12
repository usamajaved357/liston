"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, Connection } from "@/lib/api";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Alert } from "@/components/Alert";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Logo } from "@/components/Logo";

const STATUS_STYLES: Record<Connection["status"], string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  expired: "bg-amber-50 text-amber-800 border-amber-200",
  error: "bg-red-50 text-red-700 border-red-200",
  suspended: "bg-red-50 text-red-700 border-red-200",
};

function ComingSoonCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">{title}</h2>
        <span className="rounded-full bg-[var(--color-line)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-muted)]">
          Coming soon
        </span>
      </div>
      <div className="mt-4 rounded-lg border border-dashed border-[var(--color-line)] p-8 text-center">
        <p className="text-sm text-[var(--color-muted)]">{description}</p>
      </div>
    </div>
  );
}

export default function AccountDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/login");
      return;
    }

    api
      .getConnection(params.id)
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
  }, [params.id, router]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.deleteConnection(params.id);
      router.push("/dashboard");
    } catch {
      setError("Couldn't remove this connection. Try again.");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <main className="min-h-screen">
      <header className="border-b border-[var(--color-line)] bg-[var(--color-panel)]">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Logo size={32} />
            <span className="font-semibold text-[var(--color-ink)]">Liston</span>
          </div>
          <Link
            href="/dashboard"
            className="text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)] transition-colors"
          >
            Back to dashboard
          </Link>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-10 space-y-6">
        {loading ? (
          <p className="text-sm text-[var(--color-muted)]">Loading…</p>
        ) : error ? (
          <Alert>{error}</Alert>
        ) : connection ? (
          <>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-4">
                <PlatformIcon platformKey={connection.platform_key} size={48} />
                <div>
                  <h1 className="text-2xl font-semibold text-[var(--color-ink)]">{connection.label}</h1>
                  <p className="text-sm text-[var(--color-muted)]">{connection.platform_name}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`rounded-full border px-3 py-1 text-xs font-medium capitalize ${STATUS_STYLES[connection.status]}`}
                >
                  {connection.status}
                </span>
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="text-sm font-medium text-[var(--color-danger)] hover:underline"
                >
                  Remove connection
                </button>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <ComingSoonCard
                title="Active listings"
                description="Live listings on this account will show up here once the listings sync is built."
              />
              <ComingSoonCard
                title="Drafted listings"
                description="Listings Liston has drafted for review, before you publish them, will show up here."
              />
              <ComingSoonCard
                title="Inbox"
                description="Buyer messages for this account will show up here once messaging is built."
              />
              <ComingSoonCard
                title="Campaigns"
                description="Advertising / promoted listings for this account, if the platform supports it."
              />
            </div>
          </>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Remove this connection?"
        description="Liston will no longer be able to draft or publish listings to this account."
        confirmLabel="Remove"
        danger
        loading={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
      />
    </main>
  );
}
