"use client";

import { useState, FormEvent } from "react";
import { api, ApiError, Platform } from "@/lib/api";
import { PlatformIcon } from "@/components/PlatformIcon";

// Step 2 of adding an account: name it, then hand off to the marketplace's
// own sign-in. Liston never sees the password — only the OAuth grant.
function ConnectPlatformForm({ platform, onCancel }: { platform: Platform; onCancel: () => void }) {
  const [label, setLabel] = useState("");
  const sites = platform.marketplaces ?? [];
  const [site, setSite] = useState(sites[0]?.id ?? "");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setConnecting(true);
    try {
      if (platform.key === "ebay") {
        const { authorizeUrl } = await api.startEbayAuth(label, site || undefined);
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
    <form onSubmit={handleSubmit} className="mt-5 border-t border-[var(--color-line)] pt-5">
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <p className="label">Account name</p>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Walexo"
            autoComplete="off"
            autoFocus
            className="input mt-1"
          />
          <p className="mt-1.5 text-[12px] text-[var(--color-muted)]">How this account appears in Liston. You can change it later.</p>

          {sites.length > 0 && (
            <div className="mt-4">
              <p className="label">{platform.name} site</p>
              <div role="radiogroup" aria-label={`${platform.name} site`} className="mt-1 flex flex-wrap gap-1.5">
                {sites.map((m) => {
                  const on = site === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      title={`${m.name} · ${m.currency}`}
                      onClick={() => setSite(m.id)}
                      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-medium transition-colors ${
                        on
                          ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-ink)]"
                          : "border-[var(--color-line)] text-[var(--color-muted)] hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
                      }`}
                    >
                      <span aria-hidden>{m.flag}</span>
                      {m.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[12px] text-[var(--color-muted)]">
                Selling on more than one {platform.name} site? Connect the same account once for each site; each gets its own listings, orders and
                policies.
              </p>
            </div>
          )}
        </div>
        <div className="rounded-xl bg-[var(--color-paper)] px-4 py-3.5 text-[13px] leading-relaxed text-[var(--color-muted)]">
          <p className="font-medium text-[var(--color-ink)]">What happens next</p>
          <p className="mt-1">
            You&apos;ll be sent to {platform.name} to sign in and approve access, then brought straight back here. Your {platform.name}{" "}
            password never touches Liston.
          </p>
          {sites.length > 0 && (
            <p className="mt-2">
              {platform.name} uses one sign-in for every site. Linking an account for another site adds a second account in Liston and leaves the
              first one as it is.
            </p>
          )}
        </div>
      </div>

      {error && (
        <div className="notice notice-danger mt-4">
          <span className="flex-1">{error}</span>
        </div>
      )}

      <div className="mt-5 flex items-center gap-2">
        <button type="submit" disabled={connecting || !label.trim()} className="btn btn-primary btn-sm">
          {connecting ? "Redirecting…" : `Continue to ${sites.find((m) => m.id === site)?.name ?? platform.name}`}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}

interface AddConnectionPanelProps {
  platforms: Platform[];
  atLimit: boolean;
  maxConnections: number;
  onCancel?: () => void;
}

export function AddConnectionPanel({ platforms, atLimit, maxConnections, onCancel }: AddConnectionPanelProps) {
  // Start on the one marketplace that can actually be connected today, so the
  // name field is there straight away instead of behind a click.
  const [selectedPlatformKey, setSelectedPlatformKey] = useState<string | null>(() => platforms.find((p) => p.connectable)?.key ?? null);
  const selectedPlatform = platforms.find((p) => p.key === selectedPlatformKey) || null;

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Connect an account</h2>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Pick the marketplace, name the account, approve access. About a minute.</p>
        </div>
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn btn-ghost btn-icon" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      {atLimit ? (
        <div className="notice notice-warning mt-5">
          <span className="flex-1">
            Your plan allows {maxConnections} connection{maxConnections === 1 ? "" : "s"}. Remove one or upgrade to connect another.
          </span>
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {platforms.map((platform) => {
            const isSelected = selectedPlatformKey === platform.key;
            return (
              <button
                key={platform.key}
                type="button"
                disabled={!platform.connectable}
                onClick={() => setSelectedPlatformKey(isSelected ? null : platform.key)}
                className={`relative flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors ${
                  platform.connectable
                    ? isSelected
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] ring-2 ring-[var(--color-primary-soft)]"
                      : "border-[var(--color-line)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper)]"
                    : "cursor-not-allowed border-dashed border-[var(--color-line)] opacity-60"
                }`}
              >
                <PlatformIcon platformKey={platform.key} size={36} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--color-ink)]">{platform.name}</p>
                  <p className="text-[12px] text-[var(--color-muted)]">
                    {platform.connectable ? "Ready to connect" : platform.status === "coming_soon" ? "Coming soon" : "Setup pending"}
                  </p>
                </div>
                {isSelected && (
                  <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-primary)] text-white">
                    <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3">
                      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {selectedPlatform && <ConnectPlatformForm platform={selectedPlatform} onCancel={() => setSelectedPlatformKey(null)} />}
    </div>
  );
}
