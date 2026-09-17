"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError, ConnectionPolicies, DescriptionTemplate, EbaySettings, LocationAddress, Policy, PricingSettings } from "@/lib/api";
import { useConnection } from "@/lib/useConnection";
import { currencySymbol } from "@/lib/format";
import { AccountShell } from "@/components/AccountShell";
import { Alert } from "@/components/Alert";

// Account settings in three tabs: the eBay policies every listing carries,
// how prices are worked out, and the branded description template. Each tab
// is a card of rows (what it is on the left, the control on the right) with
// its own Save, so a change in one never touches the others.

// Mirrors the backend defaults in src/modules/pricing/pricing.service.js.
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
  dispatchTime: "1 to 2 business days",
  dispatchNote: "From our UK warehouse",
  carrier: "Royal Mail / Evri",
  deliveryTime: "2 to 4 business days",
  freePostage: true,
  returnsDays: 30,
  recommendedCount: 12,
  responseTime: "24 hours",
  reviews: [],
};

// Curated pairs that always read well on eBay, shown under the ones taken
// from the logo.
const PRESET_PALETTES: { name: string; accentColor: string; darkColor: string }[] = [
  { name: "Sunset", accentColor: "#FF6B2B", darkColor: "#1E1E2E" },
  { name: "Ocean", accentColor: "#0EA5E9", darkColor: "#0F172A" },
  { name: "Forest", accentColor: "#22C55E", darkColor: "#14532D" },
  { name: "Royal", accentColor: "#8B5CF6", darkColor: "#1E1B4B" },
  { name: "Cherry", accentColor: "#E11D48", darkColor: "#111827" },
  { name: "Gold", accentColor: "#F59E0B", darkColor: "#292524" },
];

type Tab = "policies" | "pricing" | "template";

function Row({ title, hint, children, last }: { title: string; hint?: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`grid gap-3 px-6 py-5 md:grid-cols-[240px_minmax(0,1fr)] ${last ? "" : "border-b border-[var(--color-line)]"}`}>
      <div>
        <p className="text-sm font-medium text-[var(--color-ink)]">{title}</p>
        {hint && <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function SectionHead({ title, blurb, action }: { title: string; blurb: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-6 py-5">
      <div>
        <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">{title}</h2>
        <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">{blurb}</p>
      </div>
      {action}
    </div>
  );
}

function SaveBar({ saving, saved, error, onSave, disabled, label = "Save changes" }: { saving: boolean; saved: boolean; error: string | null; onSave: () => void; disabled?: boolean; label?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-[var(--color-paper)] px-6 py-3.5">
      <span className={`text-[12.5px] ${error ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}>
        {error ? error : saved ? "Saved" : "Changes apply to every listing published from now on."}
      </span>
      <button type="button" onClick={onSave} disabled={saving || disabled} className="btn btn-primary btn-sm">
        {saving ? "Saving…" : label}
      </button>
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-[22px] w-[38px] flex-shrink-0 items-center rounded-full transition-colors ${on ? "bg-[var(--color-accent)]" : "bg-[var(--color-line-strong)]"}`}
    >
      <span className={`absolute left-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : "translate-x-0"}`} />
    </button>
  );
}

function Unit({ value, unit, step = "1", onChange, width = "w-28" }: { value: number; unit: string; step?: string; onChange: (v: number) => void; width?: string }) {
  return (
    <div className={`relative ${width}`}>
      <input type="number" min="0" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="input input-sm !pr-10 text-right" />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-[var(--color-muted)]">{unit}</span>
    </div>
  );
}

function Select({ value, onChange, options, placeholder = "Choose…" }: { value: string; onChange: (v: string) => void; options: { id: string; label: string }[]; placeholder?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="input input-sm">
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function policyId(p: Policy) {
  return p.fulfillmentPolicyId || p.paymentPolicyId || p.returnPolicyId || "";
}

// What the settings do to a real cost, live.
function previewPrice(cost: number, p: PricingSettings) {
  const feeRate = (p.adsFeePercent + p.processingFeePercent) / 100;
  if (feeRate >= 1) return null;
  const totalCost = cost + p.shippingCostPerOrder;
  const exact = (totalCost * (1 + p.targetRoiPercent / 100) + p.fixedFeePerOrder) / (1 - feeRate);
  const sell = p.roundTo99 ? (Math.floor(exact) + 0.99 >= exact ? Math.floor(exact) + 0.99 : Math.floor(exact) + 1.99) : Math.ceil(exact * 100) / 100;
  const profit = sell - totalCost - sell * feeRate - p.fixedFeePerOrder;
  return { sell, profit, roi: (profit / totalCost) * 100 };
}

// A miniature of the template header, so a colour choice is seen before
// it's saved.
function TemplatePreview({ t }: { t: DescriptionTemplate }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-line)]">
      <div className="flex items-center justify-between px-4 py-3" style={{ background: t.darkColor }}>
        <div className="flex items-center gap-2.5">
          {t.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={t.logoUrl} alt="" className="h-7 w-7 rounded-md bg-white object-contain" />
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold text-white" style={{ background: t.accentColor }}>
              {(t.storeName || "S").slice(0, 1).toUpperCase()}
            </span>
          )}
          <div>
            <p className="text-[13px] font-bold leading-tight text-white">{t.storeName || "Your store"}</p>
            <p className="text-[9.5px] uppercase tracking-wider text-white/70">{t.tagline || "Tagline"}</p>
          </div>
        </div>
        <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white" style={{ background: t.accentColor }}>
          {t.freePostage ? "Free P&P" : "Tracked P&P"}
        </span>
      </div>
      <div className="flex gap-3 px-4 py-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-white" style={{ background: t.accentColor }}>
        <span>UK based</span>
        <span>Fast dispatch</span>
        {t.returnsDays > 0 && <span>{t.returnsDays}-day returns</span>}
      </div>
      <div className="bg-white px-4 py-3">
        <p className="text-[13px] font-bold text-[#1C1C28]">Product name goes here</p>
        <div className="mt-1.5 flex gap-1.5">
          <span className="rounded-full px-2 py-0.5 text-[9.5px] font-semibold text-white" style={{ background: t.accentColor }}>
            New
          </span>
          <span className="rounded-full border px-2 py-0.5 text-[9.5px] font-semibold" style={{ borderColor: t.accentColor, color: t.accentColor }}>
            UK Stock
          </span>
        </div>
      </div>
    </div>
  );
}

function PaletteRow({ name, accent, dark, active, onPick }: { name: string; accent: string; dark: string; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
        active ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]" : "border-[var(--color-line)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper)]"
      }`}
    >
      <span className="flex overflow-hidden rounded-lg ring-1 ring-inset ring-black/10">
        <span className="h-7 w-7" style={{ background: dark }} />
        <span className="h-7 w-7" style={{ background: accent }} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-[var(--color-ink)]">{name}</span>
        <span className="block font-mono text-[11px] text-[var(--color-muted)]">
          {accent.toUpperCase()} · {dark.toUpperCase()}
        </span>
      </span>
      {active && (
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-[var(--color-primary)]">
          <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

function Skeleton() {
  return (
    <div className="card max-w-3xl divide-y divide-[var(--color-line)]" aria-busy="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="grid gap-3 px-6 py-5 md:grid-cols-[240px_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="h-3.5 w-32 animate-pulse rounded-full bg-[var(--color-line)]" />
            <div className="h-3 w-44 animate-pulse rounded-full bg-[var(--color-paper)]" />
          </div>
          <div className="h-8 w-64 animate-pulse rounded-full bg-[var(--color-paper)]" />
        </div>
      ))}
    </div>
  );
}

export default function AccountSettingsPage() {
  const params = useParams<{ id: string }>();
  const { connection, user, loading: loadingConnection, error: connectionError } = useConnection(params.id);
  const [tab, setTab] = useState<Tab>("policies");

  const [policies, setPolicies] = useState<ConnectionPolicies | null>(null);
  const [fulfillmentPolicyId, setFulfillmentPolicyId] = useState("");
  const [paymentPolicyId, setPaymentPolicyId] = useState("");
  const [returnPolicyId, setReturnPolicyId] = useState("");
  const [merchantLocationKey, setMerchantLocationKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [locationForm, setLocationForm] = useState<({ name: string } & LocationAddress) | null>(null);
  const [creatingLocation, setCreatingLocation] = useState(false);

  const [pricing, setPricing] = useState<PricingSettings>(DEFAULT_PRICING);
  const [savingPricing, setSavingPricing] = useState(false);
  const [pricingSaved, setPricingSaved] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);

  const [template, setTemplate] = useState<DescriptionTemplate>(DEFAULT_TEMPLATE);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [fetchingProfile, setFetchingProfile] = useState(false);
  const [logoPalettes, setLogoPalettes] = useState<{ name: string; accentColor: string; darkColor: string }[]>([]);
  const [paletteState, setPaletteState] = useState<"idle" | "loading" | "none">("idle");

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
      loadPalettes(profile.logoUrl || undefined);
    } catch (err) {
      setTemplateError(err instanceof ApiError ? err.message : "Couldn't read your store from eBay.");
    } finally {
      setFetchingProfile(false);
    }
  }

  async function loadPalettes(logoUrl?: string) {
    if (!connection) return;
    setPaletteState("loading");
    try {
      const data = await api.getTemplatePalette(connection.id, logoUrl);
      setLogoPalettes(data.palettes);
      setPaletteState(data.palettes.length ? "idle" : "none");
    } catch {
      setLogoPalettes([]);
      setPaletteState("none");
    }
  }

  useEffect(() => {
    if (!connection) return;
    if (connection.platform_key !== "ebay") {
      setLoading(false);
      return;
    }
    setPricing({ ...DEFAULT_PRICING, ...(connection.marketplace ? { currency: connection.marketplace.currency } : {}), ...(connection.settings?.pricing || {}) });
    setTemplate({ ...DEFAULT_TEMPLATE, storeName: connection.label, ...(connection.settings?.template || {}) });

    api
      .getConnectionPolicies(connection.id)
      .then((data) => {
        setPolicies(data);
        setPricing((p) => (connection.settings?.pricing?.currency ? p : { ...p, currency: data.marketplace.currency }));
        // Nothing saved yet: preselect the first policy of each type so a
        // new account never looks empty. The seller still has to press Save.
        const saved: Partial<EbaySettings> = connection.settings?.ebay || {};
        setFulfillmentPolicyId(saved.fulfillmentPolicyId || data.fulfillmentPolicies[0]?.fulfillmentPolicyId || "");
        setPaymentPolicyId(saved.paymentPolicyId || data.paymentPolicies[0]?.paymentPolicyId || "");
        setReturnPolicyId(saved.returnPolicyId || data.returnPolicies[0]?.returnPolicyId || "");
        const savedLocation = connection.settings?.ebay?.merchantLocationKey;
        const locations = data.merchantLocations || [];
        setMerchantLocationKey(savedLocation || (locations.length === 1 ? locations[0].merchantLocationKey : ""));
      })
      .catch(() => setError("Couldn't load your eBay business policies. Try again."))
      .finally(() => setLoading(false));
    // Colour suggestions come from the saved logo, or eBay's store logo.
    api
      .getTemplatePalette(connection.id, connection.settings?.template?.logoUrl || undefined)
      .then((data) => {
        setLogoPalettes(data.palettes);
        setPaletteState(data.palettes.length ? "idle" : "none");
      })
      .catch(() => setPaletteState("none"));
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

  function startLocationForm() {
    const a = policies?.registrationAddress;
    setLocationForm({
      name: `${connection?.label || "Main"} warehouse`,
      addressLine1: a?.addressLine1 || "",
      addressLine2: a?.addressLine2 || "",
      city: a?.city || "",
      stateOrProvince: a?.stateOrProvince || "",
      postalCode: a?.postalCode || "",
      country: a?.country || policies?.marketplace.country || "",
      phone: a?.phone || "",
    });
  }

  async function handleCreateLocation() {
    if (!connection || !locationForm) return;
    setCreatingLocation(true);
    setError(null);
    try {
      const { merchantLocationKey } = await api.createConnectionLocation(connection.id, locationForm);
      setMerchantLocationKey(merchantLocationKey);
      setLocationForm(null);
      const data = await api.getConnectionPolicies(connection.id);
      setPolicies(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the location on eBay. Check the address and try again.");
    } finally {
      setCreatingLocation(false);
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
      setPricingError(err instanceof ApiError ? err.message : "Couldn't save your pricing. Try again.");
    } finally {
      setSavingPricing(false);
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

  if (loadingConnection) {
    return (
      <main className="min-h-screen bg-[var(--color-paper)] p-10">
        <Skeleton />
      </main>
    );
  }

  if (connectionError || !connection || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <Alert>{connectionError || "This account connection doesn't exist, or isn't yours."}</Alert>
      </main>
    );
  }

  const canSavePolicies = Boolean(fulfillmentPolicyId && paymentPolicyId && returnPolicyId && merchantLocationKey);
  const policiesReady = canSavePolicies;
  const tabs: { key: Tab; label: string; attention?: boolean }[] = [
    { key: "policies", label: "Policies", attention: !loading && !policiesReady },
    { key: "pricing", label: "Pricing" },
    { key: "template", label: "Description template" },
  ];
  const setT = (patch: Partial<DescriptionTemplate>) => setTemplate((t) => ({ ...t, ...patch }));
  const setP = (patch: Partial<PricingSettings>) => setPricing((p) => ({ ...p, ...patch }));
  const sym = currencySymbol(pricing.currency);
  const activePalette = (p: { accentColor: string; darkColor: string }) =>
    p.accentColor.toLowerCase() === template.accentColor.toLowerCase() && p.darkColor.toLowerCase() === template.darkColor.toLowerCase();

  return (
    <AccountShell
      connectionId={connection.id}
      label={connection.label}
      platformKey={connection.platform_key}
      platformName={connection.platform_name}
      marketplace={connection.marketplace}
      permissions={connection.permissions}
      user={user}
      header={
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">Settings</h1>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
            {connection.label} · {connection.platform_name}
          </p>
        </div>
      }
    >
      {connection.platform_key !== "ebay" ? (
        <Alert variant="info">Settings aren&apos;t available for {connection.platform_name} yet.</Alert>
      ) : (
        <div className="max-w-3xl">
          <div className="mb-4 inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium transition-colors ${
                  tab === t.key ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                }`}
              >
                {t.label}
                {t.attention && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}
              </button>
            ))}
          </div>

          {tab === "policies" &&
            (loading ? (
              <Skeleton />
            ) : (
              <div className="card overflow-hidden">
                <SectionHead
                  title="Listing policies"
                  blurb="Attached to every listing Liston publishes. eBay won't accept a listing without all four."
                  action={
                    policies?.marketplace ? (
                      <span className="chip flex-shrink-0 font-medium" title="Detected from the eBay account">
                        {policies.marketplace.flag} {policies.marketplace.name} · {policies.marketplace.currency}
                      </span>
                    ) : undefined
                  }
                />
                {!policiesReady && (
                  <div className="notice notice-warning mx-6 mt-4">
                    <span className="flex-1">Pick all four before publishing anything from this account.</span>
                  </div>
                )}
                <Row title="Fulfillment policy" hint="Postage services, handling time and where you ship to.">
                  <Select value={fulfillmentPolicyId} onChange={setFulfillmentPolicyId} options={(policies?.fulfillmentPolicies || []).map((p) => ({ id: policyId(p), label: p.name }))} />
                  {(policies?.fulfillmentPolicies || []).length === 0 && (
                    <p className="mt-1.5 text-[12px] text-[var(--color-muted)]">No postage policies on {policies?.marketplace.name}. Create one in Seller Hub, then reload.</p>
                  )}
                </Row>
                <Row title="Payment policy" hint="How buyers pay you.">
                  <Select value={paymentPolicyId} onChange={setPaymentPolicyId} options={(policies?.paymentPolicies || []).map((p) => ({ id: policyId(p), label: p.name }))} />
                </Row>
                <Row title="Return policy" hint="Whether and how buyers can return.">
                  <Select value={returnPolicyId} onChange={setReturnPolicyId} options={(policies?.returnPolicies || []).map((p) => ({ id: policyId(p), label: p.name }))} />
                </Row>
                <Row title="Shipping location" hint="The address stock ships from. eBay keeps these separately from your Seller Hub addresses, so one is created here if you have none." last>
                  {(policies?.merchantLocations || []).length > 0 && (
                    <Select
                      value={merchantLocationKey}
                      onChange={setMerchantLocationKey}
                      options={(policies?.merchantLocations || []).map((l) => ({
                        id: l.merchantLocationKey,
                        label: `${l.name || l.merchantLocationKey}${l.address ? ` · ${[l.address.addressLine1, l.address.city, l.address.postalCode, l.address.country].filter(Boolean).join(", ")}` : ""}`,
                      }))}
                    />
                  )}
                  {locationForm ? (
                    <div className="mt-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] p-4">
                      <p className="text-[12.5px] text-[var(--color-muted)]">
                        {policies?.registrationAddress ? "Prefilled from your eBay registration address. Check it, then create." : "Enter the address your orders ship from."}
                      </p>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <input className="input input-sm sm:col-span-2" placeholder="Location name" value={locationForm.name} onChange={(e) => setLocationForm({ ...locationForm, name: e.target.value })} />
                        <input className="input input-sm sm:col-span-2" placeholder="Address line 1" value={locationForm.addressLine1} onChange={(e) => setLocationForm({ ...locationForm, addressLine1: e.target.value })} />
                        <input className="input input-sm sm:col-span-2" placeholder="Address line 2 (optional)" value={locationForm.addressLine2} onChange={(e) => setLocationForm({ ...locationForm, addressLine2: e.target.value })} />
                        <input className="input input-sm" placeholder="City" value={locationForm.city} onChange={(e) => setLocationForm({ ...locationForm, city: e.target.value })} />
                        <input className="input input-sm" placeholder="State / county (optional)" value={locationForm.stateOrProvince} onChange={(e) => setLocationForm({ ...locationForm, stateOrProvince: e.target.value })} />
                        <input className="input input-sm" placeholder="Postcode" value={locationForm.postalCode} onChange={(e) => setLocationForm({ ...locationForm, postalCode: e.target.value })} />
                        <input className="input input-sm" placeholder="Country code (GB, US)" maxLength={2} value={locationForm.country} onChange={(e) => setLocationForm({ ...locationForm, country: e.target.value.toUpperCase() })} />
                        <input className="input input-sm sm:col-span-2" placeholder="Phone (optional)" value={locationForm.phone} onChange={(e) => setLocationForm({ ...locationForm, phone: e.target.value })} />
                      </div>
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleCreateLocation}
                          disabled={creatingLocation || !locationForm.name || !locationForm.addressLine1 || !locationForm.city || !locationForm.postalCode || (locationForm.country || "").length !== 2}
                          className="btn btn-primary btn-sm"
                        >
                          {creatingLocation ? "Creating…" : "Create on eBay"}
                        </button>
                        <button type="button" onClick={() => setLocationForm(null)} className="btn btn-ghost btn-sm">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={startLocationForm} className="btn btn-secondary btn-sm mt-2">
                      {(policies?.merchantLocations || []).length ? "Add another location" : policies?.registrationAddress ? "Create from my eBay address" : "Add shipping location"}
                    </button>
                  )}
                </Row>
                <SaveBar saving={saving} saved={saved} error={error} onSave={handleSave} disabled={!canSavePolicies} label="Save policies" />
              </div>
            ))}

          {tab === "pricing" && (
            <div className="card overflow-hidden">
              <SectionHead title="Pricing" blurb="Every draft is priced from the supplier's cost and these numbers. Each variation is priced from its own cost." />
              <Row title="Target ROI" hint={`Profit as a share of what you paid. 60% means ${sym}2 spent returns ${sym}1.20 profit.`}>
                <Unit value={pricing.targetRoiPercent} unit="%" onChange={(v) => setP({ targetRoiPercent: v })} />
              </Row>
              <Row title="eBay fees" hint="Promoted Listings rate, final value fee, and the flat per-order charge.">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                  <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
                    Ads <Unit value={pricing.adsFeePercent} unit="%" onChange={(v) => setP({ adsFeePercent: v })} width="w-24" />
                  </label>
                  <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
                    Final value <Unit value={pricing.processingFeePercent} unit="%" onChange={(v) => setP({ processingFeePercent: v })} width="w-24" />
                  </label>
                  <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
                    Per order <Unit value={pricing.fixedFeePerOrder} unit={pricing.currency} step="0.01" onChange={(v) => setP({ fixedFeePerOrder: v })} />
                  </label>
                </div>
              </Row>
              <Row title="Shipping cost" hint="What postage costs you per order. Added to the item cost before ROI is worked out.">
                <Unit value={pricing.shippingCostPerOrder} unit={pricing.currency} step="0.01" onChange={(v) => setP({ shippingCostPerOrder: v })} />
              </Row>
              <Row title="End prices in .99" hint="Rounds up, so the real return is always at or above target.">
                <Switch on={pricing.roundTo99} onChange={(v) => setP({ roundTo99: v })} label="End prices in .99" />
              </Row>
              <Row title="Match a higher competitor price" hint="Your target ROI is a floor. If the competitor sells above it, their price is used for a wider margin. Never below the floor." last>
                <Switch on={pricing.followCompetitorPrice} onChange={(v) => setP({ followCompetitorPrice: v })} label="Match the competitor when they sell higher" />
              </Row>
              <div className="border-t border-[var(--color-line)] px-6 py-5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">What this prices at</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  {[1, 5, 15].map((cost) => {
                    const preview = previewPrice(cost, pricing);
                    return (
                      <div key={cost} className="rounded-xl bg-[var(--color-paper)] px-4 py-3">
                        <p className="text-[12px] text-[var(--color-muted)]">Costs {sym}{cost.toFixed(2)}</p>
                        {preview ? (
                          <>
                            <p className="mt-0.5 text-[20px] font-semibold tracking-tight text-[var(--color-ink)]">{sym}{preview.sell.toFixed(2)}</p>
                            <p className="text-[12px] text-[var(--color-muted)]">
                              {sym}{preview.profit.toFixed(2)} profit · {preview.roi.toFixed(0)}% ROI
                            </p>
                          </>
                        ) : (
                          <p className="mt-1 text-[13px] text-[var(--color-danger)]">Fees exceed 100%</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <SaveBar saving={savingPricing} saved={pricingSaved} error={pricingError} onSave={handleSavePricing} label="Save pricing" />
            </div>
          )}

          {tab === "template" && (
            <div className="space-y-6">
              <div className="card overflow-hidden">
                <SectionHead
                  title="Brand"
                  blurb="Every description this account publishes is wrapped in this header, with trust badges, delivery and returns below it."
                  action={
                    <button type="button" onClick={handleFillFromEbay} disabled={fetchingProfile} className="btn btn-secondary btn-sm flex-shrink-0">
                      {fetchingProfile ? "Reading…" : "Fill from eBay"}
                    </button>
                  }
                />
                <Row title="Store" hint="Name and the line under it.">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input className="input input-sm" placeholder="Store name" value={template.storeName} onChange={(e) => setT({ storeName: e.target.value })} />
                    <input className="input input-sm" placeholder="Tagline" value={template.tagline} onChange={(e) => setT({ tagline: e.target.value })} />
                  </div>
                </Row>
                <Row title="Logo" hint="Blank uses your eBay store logo. Any eBay-hosted image URL works.">
                  <div className="flex items-center gap-2">
                    <input className="input input-sm" placeholder="https://i.ebayimg.com/…" value={template.logoUrl} onChange={(e) => setT({ logoUrl: e.target.value })} onBlur={() => loadPalettes(template.logoUrl || undefined)} />
                  </div>
                </Row>
                <Row title="Feedback score" hint="Blank uses your live eBay score." last>
                  <div className="relative w-36">
                    <input className="input input-sm !pr-8" placeholder="Live score" value={template.feedbackPercent} onChange={(e) => setT({ feedbackPercent: e.target.value.replace(/[^\d.]/g, "") })} />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-[var(--color-muted)]">%</span>
                  </div>
                </Row>
              </div>

              <div className="card overflow-hidden">
                <SectionHead title="Colours" blurb="Accent for buttons and badges, header for the top bar. Pick a pair or set your own." />
                <div className="grid gap-6 px-6 py-5 md:grid-cols-[minmax(0,1fr)_280px]">
                  <div className="space-y-4">
                    <div>
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Suggested from your logo</p>
                      {paletteState === "loading" ? (
                        <div className="h-12 animate-pulse rounded-xl bg-[var(--color-paper)]" />
                      ) : logoPalettes.length ? (
                        <div className="space-y-2">
                          {logoPalettes.map((p) => (
                            <PaletteRow key={p.name} name={p.name} accent={p.accentColor} dark={p.darkColor} active={activePalette(p)} onPick={() => setT({ accentColor: p.accentColor, darkColor: p.darkColor })} />
                          ))}
                        </div>
                      ) : (
                        <p className="text-[12.5px] text-[var(--color-muted)]">Add a logo above and suggestions appear here.</p>
                      )}
                    </div>
                    <div>
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Classic pairs</p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {PRESET_PALETTES.map((p) => (
                          <PaletteRow key={p.name} name={p.name} accent={p.accentColor} dark={p.darkColor} active={activePalette(p)} onPick={() => setT({ accentColor: p.accentColor, darkColor: p.darkColor })} />
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
                        Accent
                        <input type="color" value={template.accentColor} onChange={(e) => setT({ accentColor: e.target.value })} className="h-7 w-9 cursor-pointer rounded-md border border-[var(--color-line)] bg-transparent p-0.5" />
                        <span className="font-mono text-[11px]">{template.accentColor.toUpperCase()}</span>
                      </label>
                      <label className="flex items-center gap-2 text-[12.5px] text-[var(--color-muted)]">
                        Header
                        <input type="color" value={template.darkColor} onChange={(e) => setT({ darkColor: e.target.value })} className="h-7 w-9 cursor-pointer rounded-md border border-[var(--color-line)] bg-transparent p-0.5" />
                        <span className="font-mono text-[11px]">{template.darkColor.toUpperCase()}</span>
                      </label>
                    </div>
                  </div>
                  <div>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Preview</p>
                    <TemplatePreview t={template} />
                  </div>
                </div>
              </div>

              <div className="card overflow-hidden">
                <SectionHead title="Delivery and returns" blurb="Shown as badges and a short section under the description." />
                <Row title="Dispatch" hint="How fast, and from where.">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input className="input input-sm" placeholder="1 to 2 business days" value={template.dispatchTime} onChange={(e) => setT({ dispatchTime: e.target.value })} />
                    <input className="input input-sm" placeholder="From our UK warehouse" value={template.dispatchNote} onChange={(e) => setT({ dispatchNote: e.target.value })} />
                  </div>
                </Row>
                <Row title="Delivery" hint="Carrier and typical delivery time.">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input className="input input-sm" placeholder="Royal Mail / Evri" value={template.carrier} onChange={(e) => setT({ carrier: e.target.value })} />
                    <input className="input input-sm" placeholder="2 to 4 business days" value={template.deliveryTime} onChange={(e) => setT({ deliveryTime: e.target.value })} />
                  </div>
                </Row>
                <Row title="Free P&P on UK orders" hint="Off shows a Tracked P&P badge instead.">
                  <Switch on={template.freePostage} onChange={(v) => setT({ freePostage: v })} label="Free postage" />
                </Row>
                <Row title="Returns window" hint="0 hides the returns section.">
                  <Unit value={template.returnsDays} unit="days" onChange={(v) => setT({ returnsDays: v })} />
                </Row>
                <Row title="Reply time" hint="How quickly you answer messages." last>
                  <input className="input input-sm w-40" placeholder="24 hours" value={template.responseTime} onChange={(e) => setT({ responseTime: e.target.value })} />
                </Row>
              </div>

              <div className="card overflow-hidden">
                <SectionHead title="More from your store" blurb="A scrolling row of this account's own live listings, pulled fresh when each listing is published." />
                <Row title="Listings to show" hint="Up to 24. 0 hides the row." last>
                  <Unit value={template.recommendedCount} unit="cards" onChange={(v) => setT({ recommendedCount: Math.min(24, Math.max(0, v)) })} />
                </Row>
              </div>

              <div className="card overflow-hidden">
                <SectionHead
                  title="Customer reviews"
                  blurb="Up to three, copied from your eBay feedback. Left out when empty. Invented reviews get listings removed."
                  action={
                    template.reviews.length < 3 ? (
                      <button type="button" onClick={() => setT({ reviews: [...template.reviews, { stars: 5, text: "", buyer: "", date: "" }] })} className="btn btn-secondary btn-sm flex-shrink-0">
                        Add review
                      </button>
                    ) : undefined
                  }
                />
                {template.reviews.length === 0 ? (
                  <p className="px-6 py-5 text-[13px] text-[var(--color-muted)]">No reviews added.</p>
                ) : (
                  <div className="divide-y divide-[var(--color-line)]">
                    {template.reviews.map((review, i) => (
                      <div key={i} className="grid items-center gap-2 px-6 py-3 sm:grid-cols-[minmax(0,1fr)_140px_110px_32px]">
                        <input className="input input-sm" placeholder="What they said" value={review.text} onChange={(e) => setT({ reviews: template.reviews.map((r, j) => (j === i ? { ...r, text: e.target.value } : r)) })} />
                        <input className="input input-sm" placeholder="Buyer ID" value={review.buyer} onChange={(e) => setT({ reviews: template.reviews.map((r, j) => (j === i ? { ...r, buyer: e.target.value } : r)) })} />
                        <input className="input input-sm" placeholder="Month Year" value={review.date} onChange={(e) => setT({ reviews: template.reviews.map((r, j) => (j === i ? { ...r, date: e.target.value } : r)) })} />
                        <button type="button" onClick={() => setT({ reviews: template.reviews.filter((_, j) => j !== i) })} className="btn btn-danger-ghost btn-icon" aria-label="Remove review">
                          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="card overflow-hidden">
                <SaveBar saving={savingTemplate} saved={templateSaved} error={templateError} onSave={handleSaveTemplate} label="Save template" />
              </div>
            </div>
          )}
        </div>
      )}
    </AccountShell>
  );
}
