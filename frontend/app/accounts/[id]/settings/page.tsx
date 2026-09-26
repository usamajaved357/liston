"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError, ConnectionPolicies, DescriptionLayout, DescriptionTemplate, EbaySettings, LocationAddress, Marketplace, Policy, PricingSettings, StoreReview, TEMPLATE_FONTS } from "@/lib/api";
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

// The description layouts, as the Theme tab offers them. Each card draws a
// small sketch of the layout in the account's own colours.
const LAYOUT_OPTIONS: { id: DescriptionLayout; name: string; blurb: string }[] = [
  { id: "classic", name: "Classic", blurb: "Store header, one description block, trust badges, delivery and returns." },
  { id: "showcase", name: "Showcase", blurb: "Product first: photo gallery, features grid, specifications, how to use." },
  { id: "minimal", name: "Minimal", blurb: "Clean white, thin lines, small accent headings." },
  { id: "bold", name: "Bold", blurb: "Dark hero banner, icon feature cards, strong contrast." },
  { id: "boutique", name: "Boutique", blurb: "Warm cream, serif headings, centred. Home, fashion, gifts." },
];

function LayoutSketch({ id, accent, dark }: { id: DescriptionLayout; accent: string; dark: string }) {
  const bar = (w: string, c: string, h = 4) => <div style={{ width: w, height: h, background: c, borderRadius: 2 }} />;
  const page = id === "boutique" ? "#faf7f2" : id === "bold" ? "#f3f3f5" : "#ffffff";
  return (
    <div className="flex h-[92px] flex-col gap-1.5 overflow-hidden rounded-lg border border-[var(--color-line)] p-2" style={{ background: page }}>
      {id === "classic" && (
        <>
          <div className="rounded" style={{ background: dark, height: 16 }} />
          <div style={{ background: accent, height: 4, borderRadius: 2 }} />
          {bar("80%", "#d6d6dd")}
          {bar("65%", "#e3e3e8")}
          <div className="mt-auto flex gap-1">{[0, 1, 2, 3].map((i) => <div key={i} className="h-3 flex-1 rounded" style={{ background: dark }} />)}</div>
        </>
      )}
      {id !== "classic" && (
        <>
          <div className={`flex flex-col gap-1 ${id === "minimal" ? "items-start" : "items-center"} rounded p-1`} style={id === "bold" ? { background: dark } : undefined}>
            {bar("55%", id === "bold" ? "#ffffff" : dark, 5)}
            <div className="flex gap-1">{[0, 1, 2].map((i) => <div key={i} style={{ width: 14, height: 4, borderRadius: 2, background: id === "minimal" ? "#dcdce2" : accent }} />)}</div>
          </div>
          <div className="flex flex-1 gap-1">
            <div className="flex-1 rounded" style={{ background: id === "minimal" ? "#eeeef1" : `${accent}33` }} />
            {id !== "minimal" && id !== "boutique" && <div className="w-[22%] rounded" style={{ background: `${accent}55` }} />}
          </div>
          <div className="flex gap-1">
            {(id === "bold" || id === "boutique" ? [0, 1, 2] : [0, 1]).map((i) => (
              <div key={i} className="h-3 flex-1 rounded" style={{ background: id === "bold" ? accent : id === "boutique" ? "#eee5d6" : `${accent}22`, borderTop: id === "showcase" ? `3px solid ${accent}` : undefined }} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const DEFAULT_TEMPLATE: DescriptionTemplate = {
  layout: "classic",
  bannerText: "Top Quality • Fast Dispatch",
  storeName: "",
  tagline: "Official UK Store",
  logoUrl: "",
  accentColor: "#FF6B2B",
  darkColor: "#1E1E2E",
  fontFamily: "modern",
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
  customHtml: "",
};

// The template's market-specific defaults (tagline, warehouse, carrier)
// come from the account's own eBay site. A value saved before defaults were
// per market that still reads as the UK default is treated as unset on a
// non-UK account, matching the server.
function templateForMarket(saved: Partial<DescriptionTemplate> | undefined, marketplace: Marketplace | null | undefined): DescriptionTemplate {
  const m = marketplace?.template;
  const local = m ? { tagline: m.tagline, dispatchNote: m.warehouse, carrier: m.carrier } : {};
  const cleaned: Partial<DescriptionTemplate> = { ...(saved || {}) };
  if (marketplace && marketplace.id !== "EBAY_GB") {
    (["tagline", "dispatchNote", "carrier"] as const).forEach((key) => {
      if (cleaned[key] === DEFAULT_TEMPLATE[key]) delete cleaned[key];
    });
  }
  return { ...DEFAULT_TEMPLATE, ...local, ...cleaned };
}

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

// The typeface picker: every option set in its own face, with a sample
// line, so the choice is made by eye rather than by name.
function FontPickerDialog({ value, onPick, onClose }: { value: string; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="w-full max-w-2xl rounded-2xl bg-[var(--color-panel)] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-[var(--color-ink)]">Choose a font</h2>
            <p className="text-xs text-[var(--color-muted)]">Fonts buyers already have on their device, so the listing looks the same on eBay as it does here.</p>
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
            Close
          </button>
        </div>
        <div className="mt-4 grid max-h-[60vh] gap-2 overflow-y-auto sm:grid-cols-2">
          {TEMPLATE_FONTS.map((f) => {
            const active = f.id === value;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onPick(f.id)}
                className={`rounded-xl border p-3.5 text-left transition-colors ${
                  active ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]" : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-[var(--color-ink)]">{f.name}</span>
                  {active && <span className="chip chip-primary !h-5 !text-[10.5px]">Selected</span>}
                </div>
                <p className="mt-1.5 text-[17px] leading-tight text-[var(--color-ink)]" style={{ fontFamily: f.stack }}>
                  Sample Product Title — Free UK Delivery
                </p>
                <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]" style={{ fontFamily: f.stack }}>
                  Durable, well made and ready to ship. 30-day returns.
                </p>
                <p className="mt-1.5 text-[11px] text-[var(--color-muted)]">{f.note}</p>
              </button>
            );
          })}
        </div>
      </div>
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

function PaletteRow({ name, accent, dark, active, onPick }: { name: string; accent: string; dark: string; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={`${accent.toUpperCase()} · ${dark.toUpperCase()}`}
      className={`flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors ${
        active ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]" : "border-[var(--color-line)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper)]"
      }`}
    >
      <span className="flex overflow-hidden rounded-lg ring-1 ring-inset ring-black/10">
        <span className="h-7 w-7" style={{ background: dark }} />
        <span className="h-7 w-7" style={{ background: accent }} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--color-ink)]">{name}</span>
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
  // What each tab last saved (or loaded), so Save only lights up on a change.
  const [savedSnapshot, setSavedSnapshot] = useState<{ policies: string; pricing: string; template: string }>({ policies: "", pricing: "", template: "" });
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [fetchingProfile, setFetchingProfile] = useState(false);
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const [logoPalettes, setLogoPalettes] = useState<{ name: string; accentColor: string; darkColor: string }[]>([]);
  const [paletteState, setPaletteState] = useState<"idle" | "loading" | "none">("idle");
  // The real rendered template over a sample product, kept in step with
  // the unsaved edits; and the code editor for the seller's own layout.
  const [preview, setPreview] = useState<{ html: string; key: string } | null>(null);
  const [editingCode, setEditingCode] = useState(false);
  const [codeDraft, setCodeDraft] = useState<string | null>(null);
  const [placeholders, setPlaceholders] = useState<[string, string][]>([]);
  const [ebayReviews, setEbayReviews] = useState<{ list: StoreReview[]; note: string | null } | null>(null);
  // Which slice of the pool is on show; "Show more" moves it along.
  const [reviewPage, setReviewPage] = useState(0);
  const REVIEWS_PER_PAGE = 6;

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
    const initialPricing = { ...DEFAULT_PRICING, ...(connection.marketplace ? { currency: connection.marketplace.currency } : {}), ...(connection.settings?.pricing || {}) };
    const initialTemplate = { ...templateForMarket(connection.settings?.template, connection.marketplace), storeName: connection.settings?.template?.storeName || connection.label };
    setPricing(initialPricing);
    setTemplate(initialTemplate);
    setSavedSnapshot((snap) => ({ ...snap, pricing: JSON.stringify(initialPricing), template: JSON.stringify(initialTemplate) }));

    api
      .getConnectionPolicies(connection.id)
      .then((data) => {
        setPolicies(data);
        if (!connection.settings?.pricing?.currency) {
          setPricing((p) => {
            const next = { ...p, currency: data.marketplace.currency };
            setSavedSnapshot((snap) => ({ ...snap, pricing: JSON.stringify(next) }));
            return next;
          });
        }
        // Nothing saved yet: preselect the first policy of each type so a
        // new account never looks empty. The seller still has to press Save.
        const saved: Partial<EbaySettings> = connection.settings?.ebay || {};
        setFulfillmentPolicyId(saved.fulfillmentPolicyId || data.fulfillmentPolicies[0]?.fulfillmentPolicyId || "");
        setPaymentPolicyId(saved.paymentPolicyId || data.paymentPolicies[0]?.paymentPolicyId || "");
        setReturnPolicyId(saved.returnPolicyId || data.returnPolicies[0]?.returnPolicyId || "");
        const savedLocation = connection.settings?.ebay?.merchantLocationKey;
        const locations = data.merchantLocations || [];
        setMerchantLocationKey(savedLocation || (locations.length === 1 ? locations[0].merchantLocationKey : ""));
        // Only what's actually saved counts as clean; preselected defaults
        // still need a Save.
        setSavedSnapshot((snap) => ({
          ...snap,
          policies: JSON.stringify([saved.fulfillmentPolicyId || "", saved.paymentPolicyId || "", saved.returnPolicyId || "", savedLocation || ""]),
        }));
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
      setSavedSnapshot((snap) => ({ ...snap, policies: JSON.stringify([fulfillmentPolicyId, paymentPolicyId, returnPolicyId, merchantLocationKey]) }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
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
      setSavedSnapshot((snap) => ({ ...snap, pricing: JSON.stringify(pricing) }));
      setPricingSaved(true);
      setTimeout(() => setPricingSaved(false), 2000);
    } catch (err) {
      setPricingError(err instanceof ApiError ? err.message : "Couldn't save your pricing. Try again.");
    } finally {
      setSavingPricing(false);
    }
  }

  // Preview follows the unsaved template, debounced so typing doesn't
  // render on every keystroke.
  const templateKey = JSON.stringify(template);
  useEffect(() => {
    if (!connection || tab !== "template" || connection.platform_key !== "ebay") return;
    let cancelled = false;
    const handle = setTimeout(() => {
      api
        .previewTemplate(connection.id, template)
        .then((data) => {
          if (!cancelled) setPreview({ html: data.html, key: templateKey });
        })
        .catch(() => {});
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, tab, templateKey]);

  useEffect(() => {
    if (!connection || tab !== "template" || ebayReviews !== null || connection.platform_key !== "ebay") return;
    let cancelled = false;
    api
      .getStoreReviews(connection.id)
      .then((data) => {
        if (!cancelled) setEbayReviews({ list: data.reviews, note: data.unavailable || null });
      })
      .catch(() => {
        if (!cancelled) setEbayReviews({ list: [], note: "Couldn't read your eBay feedback." });
      });
    return () => {
      cancelled = true;
    };
  }, [connection, tab, ebayReviews]);

  async function openCodeEditor() {
    if (!connection) return;
    if (template.customHtml) {
      setCodeDraft(template.customHtml);
    } else {
      try {
        const data = await api.getTemplateSource(connection.id);
        setCodeDraft(data.html);
        setPlaceholders(data.placeholders);
      } catch {
        setTemplateError("Couldn't load the template code.");
        return;
      }
    }
    if (!placeholders.length) {
      api.getTemplateSource(connection.id).then((data) => setPlaceholders(data.placeholders)).catch(() => {});
    }
    setEditingCode(true);
  }

  function toggleEbayReview(review: StoreReview) {
    const present = template.reviews.some((r) => r.text === review.text && r.buyer === review.buyer);
    if (present) {
      setT({ reviews: template.reviews.filter((r) => !(r.text === review.text && r.buyer === review.buyer)) });
    } else if (template.reviews.length < 10) {
      setT({ reviews: [...template.reviews, { stars: review.stars, text: review.text, buyer: review.buyer, date: review.date }] });
    }
  }

  async function handleSaveTemplate() {
    if (!connection) return;
    setSavingTemplate(true);
    setTemplateSaved(false);
    setTemplateError(null);
    try {
      await api.updateConnectionTemplate(connection.id, template);
      setSavedSnapshot((snap) => ({ ...snap, template: JSON.stringify(template) }));
      setTemplateSaved(true);
      setTimeout(() => setTemplateSaved(false), 2000);
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

  const policyIdsDirty = JSON.stringify([fulfillmentPolicyId, paymentPolicyId, returnPolicyId, merchantLocationKey]) !== savedSnapshot.policies;
  const templateDirty = JSON.stringify(template) !== savedSnapshot.template;
  // The Policies tab holds the policy ids and the delivery/returns copy (part
  // of the template); one Save writes whichever changed.
  const savePoliciesTab = async () => {
    if (policyIdsDirty) await handleSave();
    if (templateDirty) await handleSaveTemplate();
  };
  const saveState =
    tab === "policies"
      ? {
          dirty: policyIdsDirty || templateDirty,
          saving: saving || savingTemplate,
          saved: saved || templateSaved,
          error: error || templateError,
          onSave: savePoliciesTab,
          can: policyIdsDirty ? canSavePolicies : true,
        }
      : tab === "pricing"
        ? { dirty: JSON.stringify(pricing) !== savedSnapshot.pricing, saving: savingPricing, saved: pricingSaved, error: pricingError, onSave: handleSavePricing, can: true }
        : { dirty: templateDirty, saving: savingTemplate, saved: templateSaved, error: templateError, onSave: handleSaveTemplate, can: true };
  const saveControl = (
    <div className="flex items-center gap-3">
      {(saveState.error || saveState.saved) && (
        <span className={`text-[12.5px] ${saveState.error ? "text-[var(--color-danger)]" : "text-[var(--color-accent)]"}`}>{saveState.error || "Saved"}</span>
      )}
      <button type="button" onClick={saveState.onSave} disabled={saveState.saving || !saveState.dirty || !saveState.can} className="btn btn-primary btn-sm">
        {saveState.saving ? "Saving…" : "Save"}
      </button>
    </div>
  );

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
            {connection.label} · {connection.marketplace?.name ?? connection.platform_name}
          </p>
        </div>
      }
      subheader={
        connection.platform_key === "ebay" && (
            // Tabs and Save stay put while the page scrolls. The row spans
            // exactly the left column, so Save sits on that column's edge.
            <div className={tab === "template" ? "max-w-6xl xl:grid xl:grid-cols-[minmax(0,1fr)_460px] xl:gap-6" : "max-w-3xl"}>
              <div className="flex items-center justify-between gap-3">
                <div className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
                  {tabs.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setTab(t.key)}
                      className={`flex h-7 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium transition-colors ${
                        tab === t.key ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                      }`}
                    >
                      {t.label}
                      {t.attention && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}
                    </button>
                  ))}
                </div>
                {!loading && saveControl}
              </div>
            </div>
        )
      }
    >
      {connection.platform_key !== "ebay" ? (
        <Alert variant="info">Settings aren&apos;t available for {connection.platform_name} yet.</Alert>
      ) : (
        <div className={tab === "template" ? "max-w-6xl" : "max-w-3xl"}>
          {tab === "policies" &&
            (loading ? (
              <Skeleton />
            ) : (
              <div className="space-y-6">
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
              </div>

              {/* What the listing says about delivery and returns. Kept with the
                  policies: it's a promise to the buyer, not a matter of style. */}
              <div className="card overflow-hidden">
                <SectionHead title="Delivery and returns" blurb="What every listing tells buyers about dispatch, delivery and returns — shown as badges and a short section under the description." />
                <Row title="Dispatch" hint="How fast, and from where.">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input className="input input-sm" placeholder="1 to 2 business days" value={template.dispatchTime} onChange={(e) => setT({ dispatchTime: e.target.value })} />
                    <input className="input input-sm" placeholder={connection.marketplace?.template?.warehouse || "From our UK warehouse"} value={template.dispatchNote} onChange={(e) => setT({ dispatchNote: e.target.value })} />
                  </div>
                </Row>
                <Row title="Delivery" hint="Carrier and typical delivery time.">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input className="input input-sm" placeholder={connection.marketplace?.template?.carrier || "Royal Mail / Evri"} value={template.carrier} onChange={(e) => setT({ carrier: e.target.value })} />
                    <input className="input input-sm" placeholder="2 to 4 business days" value={template.deliveryTime} onChange={(e) => setT({ deliveryTime: e.target.value })} />
                  </div>
                </Row>
                <Row title={`Free ${connection.marketplace?.template?.postageWord || "P&P"} on ${connection.marketplace?.template?.region || "UK"} orders`} hint={`Off shows a Tracked ${connection.marketplace?.template?.postageWord || "P&P"} badge instead.`}>
                  <Switch on={template.freePostage} onChange={(v) => setT({ freePostage: v })} label="Free postage" />
                </Row>
                <Row title="Returns window" hint="0 hides the returns section.">
                  <Unit value={template.returnsDays} unit="days" onChange={(v) => setT({ returnsDays: v })} />
                </Row>
                <Row title="Reply time" hint="How quickly you answer messages." last>
                  <input className="input input-sm w-40" placeholder="24 hours" value={template.responseTime} onChange={(e) => setT({ responseTime: e.target.value })} />
                </Row>
              </div>
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
            </div>
          )}

          {tab === "template" && (
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_460px]">
            <div className="space-y-6">
              <div className="card overflow-hidden">
                <SectionHead
                  title="Layout"
                  blurb="How every description this account publishes is laid out. The preview updates as you pick; nothing changes on eBay until a listing is published or updated."
                />
                <div className="grid gap-3 px-6 py-5 sm:grid-cols-2 lg:grid-cols-3">
                  {LAYOUT_OPTIONS.map((l) => {
                    const active = (template.layout || "classic") === l.id;
                    return (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => setT({ layout: l.id })}
                        aria-pressed={active}
                        className={`rounded-xl border p-3 text-left transition-colors ${active ? "border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]/30" : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]"}`}
                      >
                        <LayoutSketch id={l.id} accent={template.accentColor} dark={template.darkColor} />
                        <p className="mt-2 flex items-center justify-between text-[13.5px] font-semibold text-[var(--color-ink)]">
                          {l.name}
                          {active && <span className="chip chip-primary !text-[11px]">In use</span>}
                        </p>
                        <p className="mt-0.5 text-[12px] leading-snug text-[var(--color-muted)]">{l.blurb}</p>
                      </button>
                    );
                  })}
                </div>
                {template.layout && template.layout !== "classic" && (
                  <Row title="Star line" hint="The line over the product name." last>
                    <input className="input input-sm" maxLength={60} placeholder="Top Quality • Fast Dispatch" value={template.bannerText} onChange={(e) => setT({ bannerText: e.target.value })} />
                  </Row>
                )}
                {template.customHtml && (
                  <p className="border-t border-[var(--color-line)] px-6 py-3 text-[12.5px] text-amber-700">
                    This account uses its own template code, which replaces the layout. Press &ldquo;Built-in&rdquo; above the preview to use a layout here instead.
                  </p>
                )}
              </div>
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
                <Row title="Feedback score" hint="Blank uses your live eBay score.">
                  <div className="relative w-36">
                    <input className="input input-sm !pr-8" placeholder="Live score" value={template.feedbackPercent} onChange={(e) => setT({ feedbackPercent: e.target.value.replace(/[^\d.]/g, "") })} />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-[var(--color-muted)]">%</span>
                  </div>
                </Row>
                <Row title="Font" hint="The typeface for the whole description." last>
                  {(() => {
                    const font = TEMPLATE_FONTS.find((f) => f.id === template.fontFamily) || TEMPLATE_FONTS[0];
                    return (
                      <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-line)] px-4 py-2.5">
                        <div className="min-w-0">
                          <p className="text-[13px] font-semibold text-[var(--color-ink)]">{font.name}</p>
                          <p className="truncate text-[15px] leading-tight text-[var(--color-ink)]" style={{ fontFamily: font.stack }}>
                            Sample Product Title — Free UK Delivery
                          </p>
                        </div>
                        <button type="button" onClick={() => setFontPickerOpen(true)} className="btn btn-secondary btn-sm flex-shrink-0">
                          Change font
                        </button>
                      </div>
                    );
                  })()}
                </Row>
              </div>

              <div className="card overflow-hidden">
                <SectionHead title="Colours" blurb="Accent for buttons and badges, header for the top bar. Pick a pair or set your own." />
                <div className="px-6 py-5">
                  <div className="space-y-4">
                    <div>
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">Suggested from your logo</p>
                      {paletteState === "loading" ? (
                        <div className="h-12 animate-pulse rounded-xl bg-[var(--color-paper)]" />
                      ) : logoPalettes.length ? (
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
                </div>
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
                  blurb="Up to ten, shown as a scrolling row in every description. Only feedback buyers actually left you on eBay; the section is left out when empty."
                />
                <div className="px-6 py-4">
                  {(() => {
                    const same = (a: { text: string; buyer: string }, b: { text: string; buyer: string }) => a.text === b.text && a.buyer === b.buyer;
                    const inTemplate = (r: StoreReview) => template.reviews.some((t) => same(t, r));
                    const pool = (ebayReviews?.list || []).filter((r) => !inTemplate(r));
                    const pages = Math.max(1, Math.ceil(pool.length / REVIEWS_PER_PAGE));
                    const page = Math.min(reviewPage, pages - 1);
                    const fresh = pool.slice(page * REVIEWS_PER_PAGE, page * REVIEWS_PER_PAGE + REVIEWS_PER_PAGE);
                    // Chosen ones at the bottom; a review added by hand in the
                    // past (no eBay match) still shows so it can be removed.
                    const chosen: StoreReview[] = template.reviews.map((t) => {
                      const match = (ebayReviews?.list || []).find((r) => same(r, t));
                      return { stars: t.stars || 5, text: t.text, buyer: t.buyer, date: t.date, itemTitle: match?.itemTitle };
                    });
                    const full = template.reviews.length >= 10;
                    const reread = () => {
                      setEbayReviews(null);
                      setReviewPage(0);
                      api
                        .getStoreReviews(connection.id, true)
                        .then((d) => setEbayReviews({ list: d.reviews, note: d.unavailable || null }))
                        .catch(() => setEbayReviews({ list: [], note: "Couldn't read your eBay feedback." }));
                    };
                    const card = (review: StoreReview, checked: boolean) => (
                      <button
                        key={`${checked ? "on" : "off"}-${review.buyer}-${review.text.slice(0, 24)}`}
                        type="button"
                        onClick={() => (checked ? setT({ reviews: template.reviews.filter((t) => !same(t, review)) }) : toggleEbayReview(review))}
                        disabled={!checked && full}
                        title={checked ? "Remove from the template" : full ? "The template holds ten reviews; untick one to swap it" : "Add to the template"}
                        className={`group/rev relative flex items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                          checked
                            ? "border-[var(--color-primary)]/35 bg-[var(--color-primary-soft)]/50"
                            : "border-[var(--color-line)] hover:border-[var(--color-primary)]"
                        }`}
                      >
                        <span
                          className={`mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                            checked
                              ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                              : "border-[var(--color-line-strong)] bg-[var(--color-panel)] text-transparent group-hover/rev:border-[var(--color-primary)] group-hover/rev:text-[var(--color-primary)]/40"
                          }`}
                          aria-hidden
                        >
                          <svg viewBox="0 0 16 16" fill="none" className="h-2.5 w-2.5">
                            <path d="M3.5 8.5l2.8 2.8L12.5 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={`line-clamp-2 text-[12.5px] leading-snug ${checked ? "text-[var(--color-muted)]" : "text-[var(--color-ink)]"}`} title={review.text}>
                            {review.text}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
                            <span className={checked ? "text-amber-400/60" : "text-amber-500"}>{"★".repeat(review.stars || 5)}</span>
                            <span className="truncate">
                              {review.buyer || "eBay buyer"}{review.date ? ` · ${review.date}` : ""}{review.itemTitle ? ` · ${review.itemTitle.slice(0, 32)}` : ""}
                            </span>
                          </span>
                        </span>
                      </button>
                    );
                    return (
                      <>
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                            From your eBay feedback{pool.length ? ` · ${pool.length} more available` : ""} · {template.reviews.length} of 10 in the template
                          </p>
                          <div className="flex gap-3 text-[12px] font-semibold">
                            {pool.length > REVIEWS_PER_PAGE && (
                              <button type="button" onClick={() => setReviewPage((p) => (p + 1) % pages)} className="text-[var(--color-primary)] hover:underline">
                                Show 6 more
                              </button>
                            )}
                            <button type="button" onClick={reread} className="text-[var(--color-primary)] hover:underline">
                              Re-read from eBay
                            </button>
                          </div>
                        </div>
                        {ebayReviews === null ? (
                          <div className="mt-3 h-24 animate-pulse rounded-xl bg-[var(--color-paper)]" />
                        ) : fresh.length === 0 && chosen.length === 0 ? (
                          <p className="mt-2 text-[13px] text-[var(--color-muted)]">{ebayReviews.note || "No written positive feedback found on this account yet."}</p>
                        ) : (
                          <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
                            {fresh.map((review) => card(review, false))}
                            {chosen.map((review) => card(review, true))}
                          </div>
                        )}
                        {ebayReviews !== null && fresh.length === 0 && chosen.length > 0 && ebayReviews.list.length > 0 && (
                          <p className="mt-2 text-[12px] text-[var(--color-muted)]">Every review read from eBay is in the template. Re-read from eBay to look for newer ones.</p>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>

            </div>

            {/* The live preview: the real template, half scale, kept in view
                while the settings on the left change it. */}
            <div className="xl:sticky xl:top-0 xl:self-start">
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="text-[13px] font-bold text-[var(--color-ink)]">Live preview</p>
                    <p className="text-[11.5px] text-[var(--color-muted)]">
                      {template.customHtml ? "Your own layout" : "Liston's layout"} · {preview && preview.key !== templateKey ? "updating…" : "as buyers will see it"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {template.customHtml && (
                      <button type="button" onClick={() => { setT({ customHtml: "" }); setCodeDraft(null); }} className="btn btn-ghost btn-sm">
                        Built-in
                      </button>
                    )}
                    <button type="button" onClick={openCodeEditor} className="btn btn-secondary btn-sm">
                      Edit code
                    </button>
                  </div>
                </div>
                <div className="relative overflow-hidden border-t border-[var(--color-line)] bg-[var(--color-paper)]" style={{ height: "calc(100vh - 210px)", minHeight: 480 }}>
                  {preview ? (
                    <iframe
                      title="Template preview"
                      sandbox=""
                      srcDoc={preview.html}
                      className={`absolute left-0 top-0 origin-top-left bg-white transition-opacity ${preview.key !== templateKey ? "opacity-70" : ""}`}
                      style={{ width: "200%", height: "200%", transform: "scale(0.5)" }}
                    />
                  ) : (
                    <div className="h-full animate-pulse bg-[var(--color-line)]/60" />
                  )}
                </div>
              </div>
            </div>
            </div>
          )}
        </div>
      )}

      {editingCode && codeDraft !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => setEditingCode(false)}>
          <div role="dialog" aria-modal="true" className="flex h-[85vh] w-full max-w-5xl flex-col rounded-2xl bg-[var(--color-panel)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-[var(--color-ink)]">Template code</h2>
                <p className="text-[12px] text-[var(--color-muted)]">
                  Placeholders are filled per listing:{" "}
                  {placeholders.map(([name, hint]) => (
                    <code key={name} title={hint} className="mr-1 rounded bg-[var(--color-paper)] px-1 py-0.5 text-[11px]">
                      {`{{${name}}}`}
                    </code>
                  ))}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => setEditingCode(false)} className="btn btn-ghost btn-sm">
                  Cancel
                </button>
                <button type="button" onClick={() => { setT({ customHtml: codeDraft }); setEditingCode(false); }} className="btn btn-primary btn-sm">
                  Apply to preview
                </button>
              </div>
            </div>
            <textarea
              className="input mt-3 min-h-0 flex-1 w-full resize-none font-mono text-[12px] leading-relaxed"
              spellCheck={false}
              value={codeDraft}
              onChange={(e) => setCodeDraft(e.target.value)}
            />
            <p className="mt-2 text-[12px] text-[var(--color-muted)]">Applied code shows in the live preview; press Save template to keep it. eBay doesn&apos;t allow scripts or iframes.</p>
          </div>
        </div>
      )}
      {fontPickerOpen && (
        <FontPickerDialog
          value={template.fontFamily}
          onPick={(id) => {
            setT({ fontFamily: id });
            setFontPickerOpen(false);
          }}
          onClose={() => setFontPickerOpen(false)}
        />
      )}
    </AccountShell>
  );
}
