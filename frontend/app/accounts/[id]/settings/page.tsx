"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError, ConnectionPolicies, MerchantLocation, Policy } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";

function policyId(p: Policy) {
  return p.fulfillmentPolicyId || p.paymentPolicyId || p.returnPolicyId || "";
}

function PickerField({
  label,
  emptyCopy,
  options,
  value,
  onChange,
}: {
  label: string;
  emptyCopy: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (options.length === 0) {
    return (
      <div>
        <label className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">{label}</label>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">{emptyCopy}</p>
      </div>
    );
  }

  return (
    <div>
      <label className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-ink)]"
      >
        <option value="">Select…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function PolicySelect({
  label,
  policies,
  value,
  onChange,
}: {
  label: string;
  policies: Policy[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <PickerField
      label={label}
      emptyCopy={`You have no ${label.toLowerCase()} on eBay yet — create one in Seller Hub, then refresh this page.`}
      options={policies.map((p) => ({ id: policyId(p), label: p.name }))}
      value={value}
      onChange={onChange}
    />
  );
}

export default function AccountSettingsPage() {
  const params = useParams<{ id: string }>();
  const { connection, loading: loadingConnection, error: connectionError } = useConnection(params.id);

  const [policies, setPolicies] = useState<ConnectionPolicies | null>(null);
  const [fulfillmentPolicyId, setFulfillmentPolicyId] = useState("");
  const [paymentPolicyId, setPaymentPolicyId] = useState("");
  const [returnPolicyId, setReturnPolicyId] = useState("");
  const [merchantLocationKey, setMerchantLocationKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!connection) return;
    if (connection.platform_key !== "ebay") {
      setLoading(false);
      return;
    }

    const marketplaceId = connection.settings?.ebay?.marketplaceId || "EBAY_GB";
    api
      .getConnectionPolicies(connection.id, marketplaceId)
      .then((data) => {
        setPolicies(data);
        setFulfillmentPolicyId(connection.settings?.ebay?.fulfillmentPolicyId || "");
        setPaymentPolicyId(connection.settings?.ebay?.paymentPolicyId || "");
        setReturnPolicyId(connection.settings?.ebay?.returnPolicyId || "");
        // Pre-fill (not auto-save) when there's exactly one location — still
        // shown, so the user sees what would be used.
        const savedLocation = connection.settings?.ebay?.merchantLocationKey;
        const locations = data.merchantLocations || [];
        setMerchantLocationKey(savedLocation || (locations.length === 1 ? locations[0].merchantLocationKey : ""));
      })
      .catch(() => setError("Couldn't load your eBay business policies. Try again."))
      .finally(() => setLoading(false));
  }, [connection]);

  async function handleSave() {
    if (!connection) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await api.updateConnectionPolicies(connection.id, {
        marketplaceId: connection.settings?.ebay?.marketplaceId || "EBAY_GB",
        fulfillmentPolicyId,
        paymentPolicyId,
        returnPolicyId,
        merchantLocationKey,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save your policies. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loadingConnection) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--color-muted)] text-sm">Loading…</p>
      </main>
    );
  }

  if (connectionError || !connection) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <Alert>{connectionError || "This account connection doesn't exist, or isn't yours."}</Alert>
      </main>
    );
  }

  const canSave = Boolean(fulfillmentPolicyId && paymentPolicyId && returnPolicyId && merchantLocationKey);

  return (
    <AccountShell
      connectionId={connection.id}
      label={connection.label}
      platformKey={connection.platform_key}
      platformName={connection.platform_name}
      status={connection.status}
      header={<h1 className="text-xl font-extrabold text-[var(--color-ink)]">Settings</h1>}
    >
      {connection.platform_key !== "ebay" ? (
        <Alert variant="info">Settings aren't available for {connection.platform_name} yet.</Alert>
      ) : (
        <div className="max-w-lg rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
          <h2 className="text-sm font-bold text-[var(--color-ink)]">Default listing policies</h2>
          <p className="mt-1 text-xs text-[var(--color-muted)] leading-relaxed">
            Every listing Liston drafts and publishes to eBay carries these — eBay won&apos;t accept a listing without
            them attached.
          </p>

          {loading ? (
            <p className="mt-6 text-sm text-[var(--color-muted)]">Loading your eBay policies…</p>
          ) : (
            <>
              {error && (
                <div className="mt-4">
                  <Alert>{error}</Alert>
                </div>
              )}
              {saved && !error && (
                <div className="mt-4">
                  <Alert variant="success">Policies saved.</Alert>
                </div>
              )}
              <div className="mt-5 flex flex-col gap-4">
                <PolicySelect
                  label="Fulfillment policy"
                  policies={policies?.fulfillmentPolicies || []}
                  value={fulfillmentPolicyId}
                  onChange={setFulfillmentPolicyId}
                />
                <PolicySelect
                  label="Payment policy"
                  policies={policies?.paymentPolicies || []}
                  value={paymentPolicyId}
                  onChange={setPaymentPolicyId}
                />
                <PolicySelect
                  label="Return policy"
                  policies={policies?.returnPolicies || []}
                  value={returnPolicyId}
                  onChange={setReturnPolicyId}
                />
                <PickerField
                  label="Shipping location"
                  emptyCopy="You have no inventory location set up on eBay yet — add one in Seller Hub, then refresh this page."
                  options={(policies?.merchantLocations || []).map((l: MerchantLocation) => ({
                    id: l.merchantLocationKey,
                    label: l.name || l.merchantLocationKey,
                  }))}
                  value={merchantLocationKey}
                  onChange={setMerchantLocationKey}
                />
              </div>
              <button
                onClick={handleSave}
                disabled={!canSave || saving}
                className="mt-6 rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40 transition-colors"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      )}
    </AccountShell>
  );
}
