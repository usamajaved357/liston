"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError, ConnectionPolicies, DraftListing, isVariationDraft } from "@/lib/api";
import { Alert } from "@/components/Alert";
import { BackHeader } from "@/components/BackHeader";

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
                      <p className="mt-2 text-xl font-extrabold text-[var(--color-ink)]">
                        {single.price.currency} {single.price.value}
                      </p>
                      <p className="mt-1 text-xs text-[var(--color-muted)]">
                        Qty {single.quantity} · Condition {single.condition || "NEW"}
                      </p>
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
                        <p className="text-sm font-bold text-[var(--color-ink)] flex-shrink-0">
                          {v.price.currency} {v.price.value}
                        </p>
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
