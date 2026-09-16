"use client";

import { useState, FormEvent } from "react";
import { api, ApiError, Platform } from "@/lib/api";
import { Field } from "@/components/Field";
import { Alert } from "@/components/Alert";
import { PlatformIcon } from "@/components/PlatformIcon";

function ConnectPlatformForm({ platform, onCancel }: { platform: Platform; onCancel: () => void }) {
  const [label, setLabel] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setConnecting(true);
    try {
      if (platform.key === "ebay") {
        const { authorizeUrl } = await api.startEbayAuth(label);
        window.location.href = authorizeUrl;
        return;
      }
      throw new ApiError(`Connecting ${platform.name} isn't built yet.`, 400);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the connection. Try again.");
      setConnecting(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5 p-5 mt-4">
      <div className="flex items-center gap-3 mb-4">
        <PlatformIcon platformKey={platform.key} size={32} />
        <div>
          <p className="text-sm font-semibold text-[var(--color-ink)]">Connect {platform.name}</p>
          <p className="text-xs text-[var(--color-muted)]">
            You&apos;ll be redirected to {platform.name} to sign in and approve access, then brought back
            here. Your password is never seen by Liston.
          </p>
        </div>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Field
          label="Label (e.g. the store or account name)"
          type="text"
          value={label}
          onChange={setLabel}
          autoComplete="off"
        />
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={connecting || !label.trim()}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60 transition-colors"
          >
            {connecting ? "Redirecting…" : `Connect ${platform.name}`}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-4 py-2 text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)] transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

interface AddConnectionPanelProps {
  platforms: Platform[];
  atLimit: boolean;
  maxConnections: number;
}

export function AddConnectionPanel({ platforms, atLimit, maxConnections }: AddConnectionPanelProps) {
  const [selectedPlatformKey, setSelectedPlatformKey] = useState<string | null>(null);
  const selectedPlatform = platforms.find((p) => p.key === selectedPlatformKey) || null;

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
      <h2 className="text-base font-semibold text-[var(--color-ink)] mb-1">Add a connection</h2>
      <p className="text-sm text-[var(--color-muted)] mb-5">Choose a marketplace to link an account.</p>

      {atLimit ? (
        <Alert variant="warning">
          Your plan allows {maxConnections} connection{maxConnections === 1 ? "" : "s"}. Remove one or
          upgrade your plan to connect another.
        </Alert>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {platforms.map((platform) => {
            const isSelected = selectedPlatformKey === platform.key;
            return (
              <button
                key={platform.key}
                type="button"
                disabled={!platform.connectable}
                onClick={() => setSelectedPlatformKey(isSelected ? null : platform.key)}
                className={`relative flex flex-col items-center gap-2 rounded-lg border p-4 text-center transition-colors ${
                  platform.connectable
                    ? isSelected
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)]/5"
                      : "border-[var(--color-line)] hover:border-[var(--color-accent)]/50"
                    : "border-[var(--color-line)] opacity-50 cursor-not-allowed"
                }`}
              >
                <PlatformIcon platformKey={platform.key} size={40} />
                <span className="text-sm font-medium text-[var(--color-ink)]">{platform.name}</span>
                {!platform.connectable && (
                  <span className="absolute top-2 right-2 rounded-full bg-[var(--color-line)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-muted)]">
                    {platform.status === "coming_soon" ? "Coming soon" : "Setup pending"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {selectedPlatform && (
        <ConnectPlatformForm platform={selectedPlatform} onCancel={() => setSelectedPlatformKey(null)} />
      )}
    </div>
  );
}
