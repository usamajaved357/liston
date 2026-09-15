"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError, ConnectionPolicies, DraftListing, PriceBreakdown, isVariationDraft } from "@/lib/api";
import { Alert } from "@/components/Alert";
import { BackHeader } from "@/components/BackHeader";

// A price the seller didn't type needs to show its working, or it's just a
// number they have to take on faith. This is the whole calculation: what the
// item cost, what each fee takes, what's left, and the return that actually
// results after rounding.
function PriceBreakdownPanel({ breakdown }: { breakdown: PriceBreakdown }) {
  const rows = [
    { label: "Supplier cost", value: -breakdown.itemCost },
    ...(breakdown.shippingCost ? [{ label: "Shipping", value: -breakdown.shippingCost }] : []),
    { label: "eBay ads", value: -breakdown.fees.ads },
    { label: "Order processing", value: -breakdown.fees.processing },
    { label: "Fixed fee", value: -breakdown.fees.fixed },
  ];
  const hitTarget = breakdown.roiPercent >= breakdown.targetRoiPercent;

  return (
    <div className="mt-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)] p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Sell price</span>
        <span className="text-xl font-extrabold text-[var(--color-ink)]">
          {breakdown.currency} {breakdown.sellPrice.toFixed(2)}
        </span>
      </div>
      <div className="mt-3 space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between text-sm">
            <span className="text-[var(--color-muted)]">{row.label}</span>
            <span className="text-[var(--color-muted)]">
              −{breakdown.currency} {Math.abs(row.value).toFixed(2)}
            </span>
          </div>
        ))}
        <div className="flex justify-between border-t border-[var(--color-line)] pt-1.5 text-sm font-bold">
          <span className="text-[var(--color-ink)]">Profit</span>
          <span className={breakdown.profit > 0 ? "text-emerald-700" : "text-[var(--color-danger)]"}>
            {breakdown.currency} {breakdown.profit.toFixed(2)}
          </span>
        </div>
      </div>
      <p className={`mt-2.5 text-xs font-semibold ${hitTarget ? "text-emerald-700" : "text-[var(--color-danger)]"}`}>
        {breakdown.roiPercent.toFixed(0)}% ROI {hitTarget ? "— at or above" : "— BELOW"} your {breakdown.targetRoiPercent}% target
      </p>
      {/* Where the number came from. "Matched the competitor" and "hit your
          floor" are very different situations and shouldn't look identical. */}
      {breakdown.basis === "competitor" ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Matched the competitor&apos;s {breakdown.currency} {breakdown.competitorPrice?.toFixed(2)} — above your floor
          of {breakdown.currency} {breakdown.floorPrice?.toFixed(2)}.
        </p>
      ) : (
        breakdown.competitorPrice != null && (
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Competitor sells at {breakdown.currency} {breakdown.competitorPrice.toFixed(2)}, below your floor — priced
            at your target instead.
          </p>
        )
      )}
    </div>
  );
}

function policyName(
  policies: ConnectionPolicies | null,
  kind: "fulfillmentPolicyId" | "paymentPolicyId" | "returnPolicyId",
  id: string
) {
  if (!policies) return id;
  const list =
    kind === "fulfillmentPolicyId"
      ? policies.fulfillmentPolicies
      : kind === "paymentPolicyId"
      ? policies.paymentPolicies
      : policies.returnPolicies;
  const match = list.find((p) => p[kind] === id);
  return match?.name || id;
}

function AspectsTable({ aspects }: { aspects: Record<string, string[]> }) {
  if (!aspects || Object.keys(aspects).length === 0) return null;
  return (
    <div className="mt-6">
      <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Item specifics</h3>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5">
        {Object.entries(aspects).map(([name, values]) => (
          <div key={name} className="flex justify-between text-sm border-b border-[var(--color-line)] py-1">
            <span className="text-[var(--color-muted)]">{name}</span>
            <span className="text-[var(--color-ink)] font-medium">{values.join(", ")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DraftReviewPage() {
  const params = useParams<{ id: string; offerId: string }>();

  const [listing, setListing] = useState<DraftListing | null>(null);
  const [policies, setPolicies] = useState<ConnectionPolicies | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    api
      .getDraftListing(params.offerId)
      .then((data) => {
        setListing(data.listing);
        setPolicies(data.policies);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this draft."))
      .finally(() => setLoading(false));
  }, [params.offerId]);

  async function handlePublish() {
    if (!listing) return;
    if (!confirm("Publish this listing to eBay? It will go live immediately.")) return;
    setPublishing(true);
    setError(null);
    try {
      const data = await api.publishDraftListing(listing.id);
      setListing(data.listing);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't publish this listing. Try again.");
    } finally {
      setPublishing(false);
    }
  }

  const content = listing?.generated_data;
  const variation = content && isVariationDraft(content) ? content : null;
  const single = content && !isVariationDraft(content) ? content : null;

  return (
    <main className="min-h-screen">
      <BackHeader backHref={`/accounts/${params.id}/listings?filter=draft`} backLabel="Back to drafts" />

      <div className="max-w-3xl mx-auto px-6 py-12">
        {loading ? (
          <p className="text-sm text-[var(--color-muted)]">Loading…</p>
        ) : error && !listing ? (
          <Alert>{error}</Alert>
        ) : listing && content ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <h1 className="text-2xl font-extrabold text-[var(--color-ink)]">Review draft</h1>
              <div className="flex items-center gap-2">
                {variation && (
                  <span className="inline-flex rounded-full bg-[var(--color-paper)] px-3 py-1 text-xs font-bold text-[var(--color-muted)]">
                    {variation.variants.length} variants
                  </span>
                )}
                <span className="inline-flex rounded-full bg-[var(--color-accent)]/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-[var(--color-accent)]">
                  {listing.status.replace("_", " ")}
                </span>
              </div>
            </div>

            {error && (
              <div className="mt-4">
                <Alert>{error}</Alert>
              </div>
            )}

            {/* What the automated steps couldn't do: item specifics eBay
                wouldn't accept, supplier photos that were marketing graphics,
                variations with no photo of their own. Shown here so it's
                fixable before publishing rather than discovered on a live
                listing. */}
            {content.warnings && content.warnings.length > 0 && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-amber-800">Worth checking</p>
                <ul className="mt-2 space-y-1">
                  {content.warnings.map((warning) => (
                    <li key={warning} className="text-sm text-amber-900 leading-relaxed">
                      • {warning}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-6 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
              <div className="flex gap-5">
                <div className="flex gap-2 flex-wrap flex-shrink-0 w-40">
                  {content.imageUrls.map((url) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={url} src={url} alt="" className="h-16 w-16 rounded-lg object-cover border border-[var(--color-line)]" />
                  ))}
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-bold text-[var(--color-ink)]">
                    {single ? single.title : variation!.commonTitle}
                  </h2>
                  {single && (
                    <>
                      <p className="mt-1 text-sm text-[var(--color-muted)]">SKU {listing.sku || "—"}</p>
                      <p className="mt-1 text-xs text-[var(--color-muted)]">
                        Qty {single.quantity} · Condition {single.condition || "NEW"}
                      </p>
                      {single.priceBreakdown ? (
                        <PriceBreakdownPanel breakdown={single.priceBreakdown} />
                      ) : (
                        <p className="mt-2 text-xl font-extrabold text-[var(--color-ink)]">
                          {single.price.currency} {single.price.value}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="mt-6">
                <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Description</h3>
                <p className="mt-1.5 text-sm text-[var(--color-ink)] whitespace-pre-wrap">
                  {single ? single.description : variation!.commonDescription}
                </p>
              </div>

              <div className="mt-6">
                <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Category</h3>
                <p className="mt-1.5 text-sm text-[var(--color-ink)]">{content.categoryId}</p>
              </div>

              {single && <AspectsTable aspects={single.aspects || {}} />}
              {variation && <AspectsTable aspects={variation.variesBy.aspects || {}} />}

              {variation && (
                <div className="mt-6">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Variants</h3>
                  <div className="mt-2 rounded-lg border border-[var(--color-line)] overflow-hidden">
                    {variation.variants.map((v, i) => (
                      <div
                        key={v.sku || i}
                        className="flex items-center gap-3 px-3 py-2.5 border-b border-[var(--color-line)] last:border-b-0"
                      >
                        {v.imageUrls[0] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={v.imageUrls[0]} alt="" className="h-10 w-10 rounded-md object-cover flex-shrink-0 border border-[var(--color-line)]" />
                        ) : (
                          <div className="h-10 w-10 rounded-md bg-[var(--color-paper)] flex-shrink-0" />
                        )}
                        <div className="min-w-0 flex-1 text-sm text-[var(--color-ink)]">
                          {Object.entries(v.aspects)
                            .map(([name, values]) => `${name}: ${values.join(", ")}`)
                            .join(" · ")}
                        </div>
                        <p className="text-xs text-[var(--color-muted)] flex-shrink-0">SKU {v.sku || "—"}</p>
                        <div className="flex-shrink-0 text-right">
                          <p className="text-sm font-bold text-[var(--color-ink)]">
                            {v.price.currency} {v.price.value}
                          </p>
                          {v.priceBreakdown && (
                            <p
                              className={`text-xs ${
                                v.priceBreakdown.roiPercent >= v.priceBreakdown.targetRoiPercent
                                  ? "text-emerald-700"
                                  : "text-[var(--color-danger)]"
                              }`}
                            >
                              {v.priceBreakdown.profit.toFixed(2)} profit · {v.priceBreakdown.roiPercent.toFixed(0)}% ROI
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {content.listingPolicies && (
                <div className="mt-6">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Listing policies</h3>
                  <div className="mt-2 flex flex-col gap-1 text-sm text-[var(--color-ink)]">
                    <p>
                      <span className="text-[var(--color-muted)]">Fulfillment: </span>
                      {policyName(policies, "fulfillmentPolicyId", content.listingPolicies.fulfillmentPolicyId)}
                    </p>
                    <p>
                      <span className="text-[var(--color-muted)]">Payment: </span>
                      {policyName(policies, "paymentPolicyId", content.listingPolicies.paymentPolicyId)}
                    </p>
                    <p>
                      <span className="text-[var(--color-muted)]">Returns: </span>
                      {policyName(policies, "returnPolicyId", content.listingPolicies.returnPolicyId)}
                    </p>
                  </div>
                </div>
              )}

              {listing.status === "pending_review" ? (
                <button
                  onClick={handlePublish}
                  disabled={publishing}
                  className="mt-8 rounded-md bg-[var(--color-primary)] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40 transition-colors"
                >
                  {publishing ? "Publishing…" : "Publish to eBay"}
                </button>
              ) : listing.status === "published" ? (
                <div className="mt-8">
                  <Alert variant="success">
                    Published to eBay{listing.external_product_id ? ` — listing ${listing.external_product_id}` : ""}.
                  </Alert>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
