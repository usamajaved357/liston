"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError, ConnectionPolicies, DescriptionTemplate, MerchantLocation, Policy, PricingSettings } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";

// Mirrors the backend defaults in src/modules/pricing/pricing.service.js —
// what a connection prices at until the seller changes it.
const DEFAULT_PRICING: PricingSettings = {
  targetRoiPercent: 60,
  adsFeePercent: 18,
  processingFeePercent: 12,
  fixedFeePerOrder: 0.3,
  shippingCostPerOrder: 0,
  currency: "GBP",
  roundTo99: true,
  followCompetitorPrice: true,
};

const DEFAULT_TEMPLATE: DescriptionTemplate = {
  storeName: "",
  tagline: "Official UK Store",
  logoUrl: "",
  accentColor: "#FF6B2B",
  darkColor: "#1E1E2E",
  feedbackPercent: "",
  dispatchTime: "1–2 Business Days",
  dispatchNote: "From our UK warehouse",
  carrier: "Royal Mail / Evri",
  deliveryTime: "2–4 Business Days",
  freePostage: true,
  returnsDays: 30,
  recommendedCount: 4,
  responseTime: "24 hours",
  reviews: [],
};

function TextField({ label, hint, value, onChange, placeholder }: { label: string; hint?: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">{label}</label>
      <input
        className="mt-1.5 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-ink)]"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="mt-1 text-xs text-[var(--color-muted)] leading-relaxed">{hint}</p>}
    </div>
  );
}

const numberInputClass =
  "w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-ink)]";

function NumberField({
  label,
  hint,
  value,
  suffix,
  step = "1",
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  suffix?: string;
  step?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">{label}</label>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          type="number"
          min="0"
          step={step}
          className={numberInputClass}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {suffix && <span className="text-sm text-[var(--color-muted)]">{suffix}</span>}
      </div>
      {hint && <p className="mt-1 text-xs text-[var(--color-muted)] leading-relaxed">{hint}</p>}
    </div>
  );
}

// Shows the seller exactly what their settings do to a real number, live, so
// the effect of a change is visible before it is saved rather than on the
// next draft.
function previewPrice(cost: number, p: PricingSettings) {
  const feeRate = (p.adsFeePercent + p.processingFeePercent) / 100;
  if (feeRate >= 1) return null;
  const totalCost = cost + p.shippingCostPerOrder;
  const exact = (totalCost * (1 + p.targetRoiPercent / 100) + p.fixedFeePerOrder) / (1 - feeRate);
  const sell = p.roundTo99 ? Math.floor(exact) + 0.99 >= exact ? Math.floor(exact) + 0.99 : Math.floor(exact) + 1.99 : Math.ceil(exact * 100) / 100;
  const profit = sell - totalCost - sell * feeRate - p.fixedFeePerOrder;
  return { sell, profit, roi: (profit / totalCost) * 100 };
}

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
  const { connection, user, loading: loadingConnection, error: connectionError } = useConnection(params.id);

  const [policies, setPolicies] = useState<ConnectionPolicies | null>(null);
  const [fulfillmentPolicyId, setFulfillmentPolicyId] = useState("");
  const [paymentPolicyId, setPaymentPolicyId] = useState("");
  const [returnPolicyId, setReturnPolicyId] = useState("");
  const [merchantLocationKey, setMerchantLocationKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pricing, setPricing] = useState<PricingSettings>(DEFAULT_PRICING);
  const [savingPricing, setSavingPricing] = useState(false);
  const [pricingSaved, setPricingSaved] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [template, setTemplate] = useState<DescriptionTemplate>(DEFAULT_TEMPLATE);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [fetchingProfile, setFetchingProfile] = useState(false);

  // Pulls the store's name, logo and feedback from eBay itself and drops them
  // into the form — the seller can still edit before saving.
  async function handleFillFromEbay() {
    if (!connection) return;
    setFetchingProfile(true);
    setTemplateError(null);
    try {
      const profile = await api.getStoreProfile(connection.id);
      setTemplate((t) => ({
        ...t,
        storeName: profile.storeName || t.storeName,
        logoUrl: profile.logoUrl || t.logoUrl,
        feedbackPercent: profile.feedbackPercent || t.feedbackPercent,
      }));
    } catch (err) {
      setTemplateError(err instanceof ApiError ? err.message : "Couldn't read your store from eBay.");
    } finally {
      setFetchingProfile(false);
    }
  }

  useEffect(() => {
    if (!connection) return;
    if (connection.platform_key !== "ebay") {
      setLoading(false);
      return;
    }

    setPricing({ ...DEFAULT_PRICING, ...(connection.settings?.pricing || {}) });
    // Store name defaults to the connection's label — the seller named it.
    setTemplate({ ...DEFAULT_TEMPLATE, storeName: connection.label, ...(connection.settings?.template || {}) });

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

  async function handleSaveTemplate() {
    if (!connection) return;
    setSavingTemplate(true);
    setTemplateSaved(false);
    setTemplateError(null);
    try {
      await api.updateConnectionTemplate(connection.id, template);
      setTemplateSaved(true);
    } catch (err) {
      setTemplateError(err instanceof ApiError ? err.message : "Couldn't save your template. Try again.");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleSavePricing() {
    if (!connection) return;
    setSavingPricing(true);
    setPricingSaved(false);
    setPricingError(null);
    try {
      await api.updateConnectionPricing(connection.id, pricing);
      setPricingSaved(true);
    } catch (err) {
      setPricingError(err instanceof ApiError ? err.message : "Couldn't save your listing settings. Try again.");
    } finally {
      setSavingPricing(false);
    }
  }

  if (loadingConnection) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--color-muted)] text-sm">Loading…</p>
      </main>
    );
  }

  if (connectionError || !connection || !user) {
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
      permissions={connection.permissions}
      user={user}
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

      {connection.platform_key === "ebay" && (
        <div className="mt-6 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
          <h2 className="text-sm font-bold text-[var(--color-ink)]">Listing settings</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)] leading-relaxed">
            Every listing&apos;s price is worked out from the supplier&apos;s own cost and these numbers, so you never
            type a price per draft. Each variation is priced separately from its own cost.
          </p>

          {pricingError && (
            <div className="mt-4">
              <Alert>{pricingError}</Alert>
            </div>
          )}

          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <NumberField
              label="Target ROI"
              suffix="%"
              hint="Profit as a share of what you paid. 60% means £2 spent returns £1.20 profit."
              value={pricing.targetRoiPercent}
              onChange={(v) => setPricing({ ...pricing, targetRoiPercent: v })}
            />
            <NumberField
              label="eBay ads fee"
              suffix="%"
              hint="Your Promoted Listings rate. Typically 12–18% — set it to the highest rate you bid, so a lower one beats target."
              value={pricing.adsFeePercent}
              onChange={(v) => setPricing({ ...pricing, adsFeePercent: v })}
            />
            <NumberField
              label="Order processing fee"
              suffix="%"
              hint="eBay's final value fee on the sale price, usually around 12%."
              value={pricing.processingFeePercent}
              onChange={(v) => setPricing({ ...pricing, processingFeePercent: v })}
            />
            <NumberField
              label="Fixed fee per order"
              suffix={pricing.currency}
              step="0.01"
              hint="eBay's flat per-order charge, normally £0.30."
              value={pricing.fixedFeePerOrder}
              onChange={(v) => setPricing({ ...pricing, fixedFeePerOrder: v })}
            />
            <NumberField
              label="Shipping cost per order"
              suffix={pricing.currency}
              step="0.01"
              hint="What postage costs you per order. Added to the item cost before the ROI is worked out."
              value={pricing.shippingCostPerOrder}
              onChange={(v) => setPricing({ ...pricing, shippingCostPerOrder: v })}
            />
            <div>
              <label className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Rounding</label>
              <label className="mt-2.5 flex items-center gap-2 text-sm text-[var(--color-ink)]">
                <input
                  type="checkbox"
                  checked={pricing.roundTo99}
                  onChange={(e) => setPricing({ ...pricing, roundTo99: e.target.checked })}
                />
                End prices in .99
              </label>
              <p className="mt-1 text-xs text-[var(--color-muted)] leading-relaxed">
                Rounds up, so your actual return is always at or above target.
              </p>
              <label className="mt-4 flex items-center gap-2 text-sm text-[var(--color-ink)]">
                <input
                  type="checkbox"
                  checked={pricing.followCompetitorPrice}
                  onChange={(e) => setPricing({ ...pricing, followCompetitorPrice: e.target.checked })}
                />
                Match the competitor when they sell higher
              </label>
              <p className="mt-1 text-xs text-[var(--color-muted)] leading-relaxed">
                Treats your target ROI as a floor. If the competitor already sells above it, their price is used
                instead for a wider margin. Never prices below the floor.
              </p>
            </div>
          </div>

          {/* The settings only mean something as a price. This shows what they
              do to real costs, live, before anything is saved. */}
          <div className="mt-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">What this prices at</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {[1, 5, 15].map((cost) => {
                const preview = previewPrice(cost, pricing);
                return (
                  <div key={cost} className="text-sm">
                    <span className="text-[var(--color-muted)]">
                      {pricing.currency} {cost.toFixed(2)} cost →{" "}
                    </span>
                    {preview ? (
                      <>
                        <span className="font-bold text-[var(--color-ink)]">
                          {pricing.currency} {preview.sell.toFixed(2)}
                        </span>
                        <span className="text-[var(--color-muted)]">
                          {" "}
                          ({preview.profit.toFixed(2)} profit, {preview.roi.toFixed(0)}% ROI)
                        </span>
                      </>
                    ) : (
                      <span className="text-[var(--color-danger)]">fees exceed 100%</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={handleSavePricing}
              disabled={savingPricing}
              className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40 transition-colors"
            >
              {savingPricing ? "Saving…" : "Save listing settings"}
            </button>
            {pricingSaved && <span className="text-sm text-emerald-700">Saved</span>}
          </div>
        </div>
      )}

      {connection.platform_key === "ebay" && (
        <div className="mt-6 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-sm font-bold text-[var(--color-ink)]">Description template</h2>
            <button
              type="button"
              onClick={handleFillFromEbay}
              disabled={fetchingProfile}
              className="flex-shrink-0 rounded-md border border-[var(--color-line)] px-3 py-1.5 text-xs font-semibold text-[var(--color-ink)] hover:border-[var(--color-accent)]/50 disabled:opacity-40"
            >
              {fetchingProfile ? "Reading store…" : "Fill from my eBay store"}
            </button>
          </div>
          <p className="mt-1 text-sm text-[var(--color-muted)] leading-relaxed">
            Every listing this account publishes wraps its description in this branding — header, trust badges,
            delivery, returns, and a &ldquo;You may also like&rdquo; row of this account&apos;s own live listings,
            pulled fresh at publish time. Each account has its own.
          </p>

          {templateError && (
            <div className="mt-4">
              <Alert>{templateError}</Alert>
            </div>
          )}

          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <TextField label="Store name" value={template.storeName} onChange={(v) => setTemplate({ ...template, storeName: v })} />
            <TextField label="Tagline" value={template.tagline} onChange={(v) => setTemplate({ ...template, tagline: v })} />
            <TextField
              label="Logo image URL"
              hint="Blank means your eBay store's own logo is used automatically. Or paste any eBay-hosted image URL."
              value={template.logoUrl}
              onChange={(v) => setTemplate({ ...template, logoUrl: v })}
              placeholder="https://i.ebayimg.com/…"
            />
            <TextField
              label="Feedback %"
              hint="Blank means your live eBay feedback score is used automatically."
              value={template.feedbackPercent}
              onChange={(v) => setTemplate({ ...template, feedbackPercent: v })}
              placeholder="99.7"
            />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Accent</label>
                <div className="mt-1.5 flex items-center gap-2">
                  <input type="color" value={template.accentColor} onChange={(e) => setTemplate({ ...template, accentColor: e.target.value })} className="h-9 w-12 cursor-pointer rounded border border-[var(--color-line)]" />
                  <span className="text-xs text-[var(--color-muted)]">{template.accentColor}</span>
                </div>
              </div>
              <div>
                <label className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Header</label>
                <div className="mt-1.5 flex items-center gap-2">
                  <input type="color" value={template.darkColor} onChange={(e) => setTemplate({ ...template, darkColor: e.target.value })} className="h-9 w-12 cursor-pointer rounded border border-[var(--color-line)]" />
                  <span className="text-xs text-[var(--color-muted)]">{template.darkColor}</span>
                </div>
              </div>
            </div>
            <TextField label="Dispatch time" value={template.dispatchTime} onChange={(v) => setTemplate({ ...template, dispatchTime: v })} />
            <TextField label="Dispatch note" value={template.dispatchNote} onChange={(v) => setTemplate({ ...template, dispatchNote: v })} />
            <TextField label="Carrier" value={template.carrier} onChange={(v) => setTemplate({ ...template, carrier: v })} />
            <TextField label="Delivery time" value={template.deliveryTime} onChange={(v) => setTemplate({ ...template, deliveryTime: v })} />
            <NumberField label="Returns window" suffix="days" hint="0 hides the returns section." value={template.returnsDays} onChange={(v) => setTemplate({ ...template, returnsDays: v })} />
            <NumberField label="Recommended listings" suffix="cards" hint="How many of this account's live listings to show. 0 hides the row." value={template.recommendedCount} onChange={(v) => setTemplate({ ...template, recommendedCount: v })} />
            <TextField label="Reply time" value={template.responseTime} onChange={(v) => setTemplate({ ...template, responseTime: v })} />
            <div>
              <label className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Postage</label>
              <label className="mt-2.5 flex items-center gap-2 text-sm text-[var(--color-ink)]">
                <input type="checkbox" checked={template.freePostage} onChange={(e) => setTemplate({ ...template, freePostage: e.target.checked })} />
                Free P&amp;P on all UK orders
              </label>
            </div>
          </div>

          <div className="mt-6">
            <div className="flex items-baseline justify-between">
              <label className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Customer reviews (up to 3)</label>
              {template.reviews.length < 3 && (
                <button type="button" onClick={() => setTemplate({ ...template, reviews: [...template.reviews, { stars: 5, text: "", buyer: "", date: "" }] })} className="text-xs text-[var(--color-accent)] hover:underline">
                  + Add review
                </button>
              )}
            </div>
            <p className="mt-1 text-xs text-[var(--color-muted)] leading-relaxed">
              Real feedback only, copied from your eBay feedback page. The section is left out entirely when empty —
              invented reviews get listings removed.
            </p>
            {template.reviews.map((review, i) => (
              <div key={i} className="mt-3 grid gap-2 rounded-lg border border-[var(--color-line)] p-3 sm:grid-cols-[1fr_140px_110px_auto]">
                <input className="rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-1.5 text-sm text-[var(--color-ink)]" placeholder="What they said" value={review.text} onChange={(e) => setTemplate({ ...template, reviews: template.reviews.map((r, j) => (j === i ? { ...r, text: e.target.value } : r)) })} />
                <input className="rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-1.5 text-sm text-[var(--color-ink)]" placeholder="Buyer ID" value={review.buyer} onChange={(e) => setTemplate({ ...template, reviews: template.reviews.map((r, j) => (j === i ? { ...r, buyer: e.target.value } : r)) })} />
                <input className="rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-1.5 text-sm text-[var(--color-ink)]" placeholder="Month Year" value={review.date} onChange={(e) => setTemplate({ ...template, reviews: template.reviews.map((r, j) => (j === i ? { ...r, date: e.target.value } : r)) })} />
                <button type="button" onClick={() => setTemplate({ ...template, reviews: template.reviews.filter((_, j) => j !== i) })} className="text-xs text-[var(--color-danger)] hover:underline">
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="mt-6 flex items-center gap-3">
            <button
              onClick={handleSaveTemplate}
              disabled={savingTemplate}
              className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40 transition-colors"
            >
              {savingTemplate ? "Saving…" : "Save template"}
            </button>
            {templateSaved && <span className="text-sm text-emerald-700">Saved</span>}
          </div>
        </div>
      )}
    </AccountShell>
  );
}
