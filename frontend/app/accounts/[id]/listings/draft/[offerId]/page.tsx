"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { EditorSkeleton } from "@/components/Skeleton";
import {
  api,
  ApiError,
  AspectSchemaEntry,
  ConnectionPolicies,
  DraftCategoryInfo,
  DraftContent,
  DraftListing,
  DraftPatch,
  ImageCheck,
  ImageProposal,
  PriceBreakdown,
  RevisionCurrentState,
  StoreCategory,
  TextProposal,
  VariationDraftContent,
  VariationDraftVariant,
  VariationFixes,
  isVariationDraft,
} from "@/lib/api";
import { Alert } from "@/components/Alert";
import { EditorHeader } from "@/components/EditorHeader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CategoryPicker, CategorySelection, ShopCategoryPicker, shopCategoryLabel } from "@/components/CategoryPicker";
import { RichTextEditor, markersToHtml } from "@/components/RichTextEditor";
import { currencySymbol, formatPrice } from "@/lib/format";

// The draft editor. A draft lives only in Liston until Publish, so every
// change here is a local edit saved with one PATCH — nothing touches eBay
// until the seller decides to go live. AI revisions are proposals: they're
// shown beside the current version and change nothing until accepted.
//
// Layout: a fixed header (back · what you're editing · Save/Publish) over a
// scrolling body. Photos and the AI box on the left; details, specifics and
// description on the right; variations full-width beneath, laid out the way
// eBay's own variation editor does it — one row per combination, one column
// per attribute, price and quantity editable in place.

const inputClass = "input";
const labelClass = "label";
const cardClass = "card p-4";
const cardTitleClass = "text-[14px] font-bold text-[var(--color-ink)]";
const smallButton = "btn btn-secondary btn-sm";
const TITLE_MAX = 80;

// Small inline icons for the compact action rows.
const Icon = {
  star: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8L12 3.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  ),
  swap: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M4 7h13l-3-3M20 17H7l3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  upload: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M12 4v12m0 0l-4-4m4 4l4-4M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  text: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M5 6h14M12 6v13M9 19h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M20 12a8 8 0 01-14.9 4M4 12a8 8 0 0114.9-4M19 4v4h-4M5 20v-4h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  restore: (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
      <path d="M4 10h11a5 5 0 010 10h-4M4 10l4-4M4 10l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
};

function flattenStorePaths(categories: StoreCategory[], prefix = ""): string[] {
  return categories.flatMap((c) => [`${prefix}/${c.name}`, ...flattenStorePaths(c.children || [], `${prefix}/${c.name}`)]);
}

const CONDITIONS = [
  { value: "NEW", label: "New" },
  { value: "USED_EXCELLENT", label: "Used, excellent" },
  { value: "USED_GOOD", label: "Used, good" },
  { value: "USED_ACCEPTABLE", label: "Used, acceptable" },
];

// The same working as the backend's priceForCost, re-run for a price the
// seller has typed, so the ROI badge and its panel follow the input as it
// changes rather than describing the price the AI originally chose.
function repriceBreakdown(breakdown: PriceBreakdown, priceText: string | undefined): PriceBreakdown {
  if (priceText === undefined) return breakdown;
  const sellPrice = Number(priceText);
  if (!Number.isFinite(sellPrice) || sellPrice <= 0 || Math.abs(sellPrice - breakdown.sellPrice) < 0.005) return breakdown;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const adsRate = breakdown.feeRates ? breakdown.feeRates.adsPercent / 100 : breakdown.sellPrice > 0 ? breakdown.fees.ads / breakdown.sellPrice : 0;
  const processingRate = breakdown.feeRates
    ? breakdown.feeRates.processingPercent / 100
    : breakdown.sellPrice > 0
      ? breakdown.fees.processing / breakdown.sellPrice
      : 0;
  const ads = round2(sellPrice * adsRate);
  const processing = round2(sellPrice * processingRate);
  const profit = round2(sellPrice - breakdown.totalCost - ads - processing - breakdown.fees.fixed);
  return {
    ...breakdown,
    sellPrice: round2(sellPrice),
    fees: { ...breakdown.fees, ads, processing },
    profit,
    roiPercent: breakdown.totalCost > 0 ? round2((profit / breakdown.totalCost) * 100) : 0,
    // A typed price is the seller's own, whichever rule chose the original.
    basis: "manual",
  };
}

// A price the seller didn't type needs to show its working, or it's just a
// number they have to take on faith.
function PriceBreakdownPanel({ breakdown }: { breakdown: PriceBreakdown }) {
  const rows = [
    { label: "Supplier cost", value: breakdown.itemCost },
    ...(breakdown.shippingCost ? [{ label: "Shipping", value: breakdown.shippingCost }] : []),
    { label: "eBay ads", value: breakdown.fees.ads },
    { label: "Order processing", value: breakdown.fees.processing },
    { label: "Fixed fee", value: breakdown.fees.fixed },
  ];
  const hitTarget = breakdown.roiPercent >= breakdown.targetRoiPercent;

  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)] p-4">
      <div className="flex items-baseline justify-between">
        <span className={labelClass}>Sell price</span>
        <span className="text-xl font-extrabold text-[var(--color-ink)]">{formatPrice(breakdown.sellPrice, breakdown.currency)}</span>
      </div>
      <div className="mt-3 space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between text-sm text-[var(--color-muted)]">
            <span>{row.label}</span>
            <span>−{formatPrice(row.value, breakdown.currency)}</span>
          </div>
        ))}
        <div className="flex justify-between border-t border-[var(--color-line)] pt-1.5 text-sm font-bold">
          <span className="text-[var(--color-ink)]">Profit</span>
          <span className={breakdown.profit > 0 ? "text-emerald-700" : "text-[var(--color-danger)]"}>
            {formatPrice(breakdown.profit, breakdown.currency)}
          </span>
        </div>
      </div>
      <p className={`mt-2.5 text-xs font-semibold ${hitTarget ? "text-emerald-700" : "text-[var(--color-danger)]"}`}>
        {breakdown.roiPercent.toFixed(0)}% ROI {hitTarget ? "is at or above" : "is BELOW"} your{" "}
        {breakdown.targetRoiPercent}% target
      </p>
      {breakdown.basis === "manual" ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Your own price{breakdown.floorPrice ? ` · target-ROI floor is ${formatPrice(breakdown.floorPrice, breakdown.currency)}` : ""}
          {breakdown.competitorPrice != null ? `, competitor sells at ${formatPrice(breakdown.competitorPrice, breakdown.currency)}` : ""}.
        </p>
      ) : breakdown.basis === "competitor" ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Matched the competitor&apos;s {formatPrice(breakdown.competitorPrice ?? 0, breakdown.currency)}, above your floor
          of {formatPrice(breakdown.floorPrice ?? 0, breakdown.currency)}.
        </p>
      ) : (
        breakdown.competitorPrice != null && (
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Competitor sells at {formatPrice(breakdown.competitorPrice, breakdown.currency)}, below your floor, so priced
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
  return list.find((p) => p[kind] === id)?.name || id;
}

// --- Description formatting ---------------------------------------------------
//
// The description is plain text with a few inline markers the template
// renders (**bold**, ==highlight==, [color=#hex]…[/color], [size=lg]…[/size]).
// The toolbar wraps the current selection in the textarea with those markers,
// so what's stored stays safe text and the AI can still rewrite it.

// --- Gallery ----------------------------------------------------------------
//
// Every image at once, not a carousel: the seller is deciding what to keep,
// which needs the whole set in view. The first tile is the main image (the
// search thumbnail).

// Variations removed from this draft, kept until it's published: each can
// be put back (it saves like any other edit). Nothing here goes to eBay.
function RemovedVariations({
  removed,
  restoring,
  onRestore,
  disabled,
}: {
  removed: NonNullable<VariationDraftContent["removedVariants"]>;
  restoring: number[];
  onRestore: (indexes: number[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const waiting = removed.map((v, index) => ({ v, index })).filter(({ index }) => !restoring.includes(index));
  if (!waiting.length) return null;
  const label = (v: VariationDraftVariant) => Object.values(v.aspects || {}).map((values) => values[0]).join(" / ");
  return (
    <section className="card mt-4 overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-left" aria-expanded={open}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden className={`h-4 w-4 text-[var(--color-muted)] transition-transform ${open ? "rotate-90" : ""}`}>
            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[14px] font-semibold text-[var(--color-ink)]">Removed variations</span>
          <span className="rounded-full bg-[var(--color-paper)] px-2 py-0.5 text-[12px] font-medium text-[var(--color-muted)]">{waiting.length}</span>
        </button>
        <div className="flex items-center gap-3">
          <span className="hidden text-[12px] text-[var(--color-muted)] sm:inline">Kept until you publish; not sent to eBay</span>
          {waiting.length > 1 && (
            <button type="button" onClick={() => onRestore(waiting.map((w) => w.index))} disabled={disabled} className="btn btn-secondary btn-sm">
              Undo all
            </button>
          )}
        </div>
      </div>
      {open && (
        <ul className="divide-y divide-[var(--color-line)]">
          {waiting.map(({ v, index }) => (
            <li key={index} className="flex items-center gap-3 px-4 py-2.5">
              {v.imageUrls?.[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={v.imageUrls[0]} alt="" className="h-10 w-10 shrink-0 rounded-lg border border-[var(--color-line)] bg-white object-contain opacity-70" />
              ) : (
                <span className="h-10 w-10 shrink-0 rounded-lg border border-dashed border-[var(--color-line)]" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-[var(--color-muted)] line-through decoration-[var(--color-line-strong)]">{label(v) || "Variation"}</span>
                <span className="text-[12px] text-[var(--color-muted)]">
                  {formatPrice(v.price.value, v.price.currency)} · {v.quantity} in stock
                </span>
              </span>
              <button type="button" onClick={() => onRestore([index])} disabled={disabled} className="btn btn-ghost btn-sm text-[var(--color-primary)]">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden className="h-4 w-4">
                  <path d="M9 14L4 9l5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M4 9h10.5a5.5 5.5 0 010 11H11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                Undo
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Every picture type, by type and by extension: AI tools and phones save
// .avif, .jfif, .heic and the like, which a picker limited to JPG/PNG/GIF/WebP
// greyed out. The server reads the file itself and converts what eBay needs.
const IMAGE_ACCEPT = "image/*,.jpg,.jpeg,.jfif,.pjpeg,.png,.gif,.webp,.avif,.heic,.heif,.bmp,.tif,.tiff";

function FileButton({
  label,
  multiple,
  disabled,
  onFiles,
  className,
  title,
}: {
  label: React.ReactNode;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  className: string;
  title?: string;
}) {
  return (
    <label title={title} className={`cursor-pointer ${className} ${disabled ? "pointer-events-none opacity-40" : ""}`}>
      {label}
      <input
        type="file"
        accept={IMAGE_ACCEPT}
        multiple={multiple}
        hidden
        disabled={disabled}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
    </label>
  );
}

function GalleryGrid({
  images,
  selected,
  onSelect,
  onSetMain,
  onMove,
  onDelete,
  onUpload,
  onReplace,
  onDownloadAll,
  uploading,
  disabled,
}: {
  images: string[];
  selected: number;
  onSelect: (index: number) => void;
  onSetMain: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onDelete: (index: number) => void;
  onUpload: (files: File[]) => void;
  onReplace: (index: number, file: File) => void;
  onDownloadAll: () => void;
  uploading: boolean;
  disabled: boolean;
}) {
  const count = images.length;
  const current = images[selected];
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const canDrag = !disabled && count > 1;
  function endDrag() {
    setDragFrom(null);
    setDragOver(null);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || count < 2) return;
      if (e.key === "ArrowLeft") onSelect((selected - 1 + count) % count);
      if (e.key === "ArrowRight") onSelect((selected + 1) % count);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, count, onSelect]);

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={cardTitleClass}>
          Photos <span className="font-medium text-[var(--color-muted)]">· {count}</span>
          <span className="ml-1.5 text-[11px] font-normal text-[var(--color-muted)]" title="eBay allows up to 24 photos per listing">(max 24)</span>
        </h3>
        <div className="flex items-center gap-1.5">
          <FileButton
            label={<>{Icon.upload}<span>{uploading ? "Uploading…" : "Upload"}</span></>}
            multiple
            disabled={disabled || uploading || count >= 24}
            onFiles={onUpload}
            className="btn btn-secondary btn-sm"
            title="Upload photos from your computer"
          />
          {count > 0 && (
            <button type="button" onClick={onDownloadAll} title="Download all photos" className="btn btn-secondary btn-sm">
              {Icon.download}
              <span>All</span>
            </button>
          )}
        </div>
      </div>

      {count === 0 ? (
        <div className="mt-4 flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--color-line)]">
          <p className="text-sm text-[var(--color-muted)]">No photos yet. eBay needs at least one.</p>
          <FileButton label="Upload photos" multiple disabled={disabled || uploading} onFiles={onUpload} className={smallButton} />
        </div>
      ) : (
        <>
          {/* Selected image, large. Dropping a thumbnail here makes it the main photo. */}
          <div
            className={`relative mt-3 aspect-square rounded-xl border bg-white transition-all ${
              dragOver === -1 ? "border-2 border-dashed border-[var(--color-primary)] ring-4 ring-[var(--color-primary-soft)]" : "border-[var(--color-line)]"
            }`}
            onDragOver={(e) => {
              if (dragFrom === null || dragFrom === 0) return; // already the main photo
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOver !== -1) setDragOver(-1);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver((o) => (o === -1 ? null : o));
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom !== null) onSetMain(dragFrom);
              endDrag();
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={current} alt="" draggable={false} className="h-full w-full rounded-xl object-contain" />
            {dragFrom !== null && dragFrom !== 0 && (
              <div
                className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl transition-colors ${
                  dragOver === -1 ? "bg-[var(--color-primary)]/15" : "bg-white/60"
                }`}
              >
                <span className="flex items-center gap-1.5 rounded-full bg-[var(--color-primary)] px-3 py-1.5 text-xs font-semibold text-white shadow-md">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                    <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8L12 3.5z" />
                  </svg>
                  Drop to set as main photo
                </span>
              </div>
            )}
            {selected === 0 && (
              <span title="Main photo" className="absolute left-3 top-3 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-primary)] text-white shadow-sm">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                  <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8L12 3.5z" />
                </svg>
              </span>
            )}
            <span className="absolute right-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-white">
              {selected + 1} / {count}
            </span>
            {count > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => onSelect((selected - 1 + count) % count)}
                  aria-label="Previous photo"
                  className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--color-line)] bg-white text-[var(--color-ink)] shadow-md transition-colors hover:border-[var(--color-line-strong)]"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                    <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => onSelect((selected + 1) % count)}
                  aria-label="Next photo"
                  className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--color-line)] bg-white text-[var(--color-ink)] shadow-md transition-colors hover:border-[var(--color-line-strong)]"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                    <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </>
            )}
          </div>

          {/* One action here: which photo leads. Everything else lives on
              the thumbnails (remove) and in the AI box (badges). */}
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => onSetMain(selected)}
              disabled={disabled || selected === 0}
              className="btn !h-7 !px-3 !text-[12px] bg-[var(--color-primary-soft)] font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white disabled:opacity-100 disabled:hover:bg-[var(--color-primary-soft)] disabled:hover:text-[var(--color-primary)]"
            >
              {selected === 0 ? "Main photo" : "Set as main"}
            </button>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-[var(--color-muted)]">Photo {selected + 1}</span>
              <FileButton label={Icon.swap} disabled={disabled || uploading} onFiles={(f) => onReplace(selected, f[0])} className="btn btn-secondary btn-icon !h-7 !w-7" title="Replace this photo" />
              <button
                type="button"
                onClick={() => onDelete(selected)}
                disabled={disabled || count === 1}
                title={count === 1 ? "A listing needs at least one photo" : "Remove this photo"}
                aria-label="Remove this photo"
                className="btn btn-danger-ghost btn-icon !h-7 !w-7"
              >
                {Icon.trash}
              </button>
            </div>
          </div>

          {/* Every image — drag one onto another frame to move it there */}
          <div className="mt-2.5 grid grid-cols-5 gap-1.5 sm:grid-cols-6">
            {images.map((url, i) => (
              <button
                key={`${url}-${i}`}
                type="button"
                onClick={() => onSelect(i)}
                draggable={canDrag}
                title={canDrag ? "Drag to reorder" : undefined}
                onDragStart={(e) => {
                  setDragFrom(i);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(i));
                }}
                onDragOver={(e) => {
                  if (dragFrom === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOver !== i) setDragOver(i);
                }}
                onDragLeave={() => setDragOver((o) => (o === i ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== null) onMove(dragFrom, i);
                  endDrag();
                }}
                onDragEnd={endDrag}
                className={`group relative aspect-square overflow-hidden rounded-lg border-2 bg-white transition-all ${canDrag ? "cursor-grab active:cursor-grabbing" : ""} ${
                  dragOver === i && dragFrom !== i
                    ? "scale-105 border-dashed border-[var(--color-primary)] ring-2 ring-[var(--color-primary-soft)]"
                    : i === selected
                      ? "border-[var(--color-primary)] shadow-sm"
                      : "border-[var(--color-line)] hover:border-[var(--color-muted)]"
                } ${dragFrom === i ? "opacity-40" : ""}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" draggable={false} className="pointer-events-none h-full w-full object-contain" />
                <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-bold text-white">{i + 1}</span>
                {i === 0 && (
                  <span title="Main photo" className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-primary)] text-white shadow-sm">
                    <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="currentColor">
                      <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8L12 3.5z" />
                    </svg>
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// --- Variations --------------------------------------------------------------
//
// One row per combination; one column per attribute; photo, SKU, price and
// quantity in their own columns — the shape eBay's own variation grid uses,
// which is what sellers already know how to read.

type AxisRemoval = { axis: string; value: string };
type Renames = Record<string, Record<string, string>>; // axis -> original value -> new name

// A label that turns into an input on click: how variation names and
// option names are edited in place, without a form.
function InlineName({
  value,
  onChange,
  disabled,
  className,
  maxLength = 50,
  suggestions,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
  maxLength?: number;
  // Offered while editing (eBay's allowed attribute names, say).
  suggestions?: string[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const listId = suggestions?.length ? `inline-name-${value.replace(/\W+/g, "-")}` : undefined;
  if (editing && !disabled) {
    return (
      <>
      {listId && (
        <datalist id={listId}>
          {suggestions!.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      <input
        list={listId}
        autoFocus
        className="h-6 min-w-[6rem] rounded-md border border-[var(--color-primary)] bg-[var(--color-panel)] px-1.5 text-[13px] text-[var(--color-ink)] focus:outline-none"
        value={draft}
        maxLength={maxLength}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const next = draft.trim();
          if (next && next !== value) onChange(next);
          else setDraft(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
      />
      </>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? undefined : "Click to rename"}
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      className={`group/name inline-flex items-center gap-1 rounded-md text-left ${disabled ? "" : "hover:bg-[var(--color-primary-soft)]"} ${className || ""}`}
    >
      <span>{value}</span>
      {!disabled && (
        <span className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-paper)] text-[var(--color-muted)] group-hover/name:bg-[var(--color-primary)] group-hover/name:text-white" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3">
            <path d="M4 20h4l10-10-4-4L4 16v4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </button>
  );
}

// Choose a variation's photo from everything the draft already has (the
// gallery and every other variation's photo), or upload a new one.
function ImagePickerDialog({
  title,
  images,
  current,
  onPick,
  onUpload,
  onClose,
}: {
  title: string;
  images: string[];
  current: string | null;
  onPick: (url: string) => void;
  onUpload: (file: File) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="w-full max-w-2xl rounded-2xl bg-[var(--color-panel)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-[var(--color-ink)]">{title}</h2>
            <p className="text-xs text-[var(--color-muted)]">Pick one of the draft&apos;s photos, or upload a new one for this variation.</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <FileButton label="Upload" onFiles={(f) => f[0] && onUpload(f[0])} className="btn btn-secondary btn-sm" />
            <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
              Close
            </button>
          </div>
        </div>
        <div className="mt-4 grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4 md:grid-cols-5">
          {images.map((url, i) => (
            <button
              key={url}
              type="button"
              onClick={() => onPick(url)}
              className={`relative aspect-square overflow-hidden rounded-xl border-2 bg-white transition-colors ${
                url === current ? "border-[var(--color-primary)]" : "border-[var(--color-line)] hover:border-[var(--color-primary)]"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="h-full w-full object-contain" />
              <span className="absolute left-1.5 top-1.5 rounded-full bg-black/60 px-1.5 text-[10px] font-semibold text-white">{i + 1}</span>
              {url === current && <span className="absolute bottom-1.5 right-1.5 rounded-full bg-[var(--color-primary)] px-1.5 text-[10px] font-semibold text-white">Current</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function VariationsTable({
  variants,
  specifications,
  galleryImages,
  removedIndexes,
  removedAxisValues,
  priceOverrides,
  quantityOverrides,
  imageOverrides,
  imageAxis,
  onRemoveRow,
  onRestoreRow,
  onRemoveAxisValue,
  onRestoreAxisValue,
  onPriceChange,
  onQuantityChange,
  onImageChange,
  onUploadImage,
  onApplyAll,
  disabled,
  variationsSupported,
  onSplit,
  splitting,
  splitDone,
  accountId,
  valueRenames,
  axisRenames,
  onRenameValue,
  onRenameAxis,
  addedValues,
  onAddValue,
  onUndoAddValue,
  allowedAxes,
  blockedAxes,
  fixes,
  onApplyFix,
  applyingFix,
  onSplitAll,
}: {
  variants: VariationDraftVariant[];
  // Attribute names eBay accepts as variations in this category; null if unknown.
  allowedAxes: string[] | null;
  // Item specifics of the category eBay does NOT let a listing vary by; any
  // other name (listed or the seller's own) is accepted. Null if unknown.
  blockedAxes: string[] | null;
  fixes: VariationFixes | null;
  onApplyFix?: (fix: VariationFixes["categories"][number]) => void;
  applyingFix: boolean;
  onSplitAll?: () => void;
  // Options added since the last save (they exist only once saved).
  addedValues: { axis: string; value: string; copyFrom: string }[];
  onAddValue: (axis: string, value: string, copyFrom: string) => void;
  onUndoAddValue: (axis: string, value: string) => void;
  valueRenames: Renames;
  axisRenames: Record<string, string>;
  onRenameValue: (axis: string, from: string, to: string) => void;
  onRenameAxis: (from: string, to: string) => void;
  variationsSupported: boolean | null;
  onSplit?: (index: number) => void;
  splitting: number | null;
  splitDone: { id: string; title: string }[];
  accountId: string;
  specifications: { name: string; values: string[] }[];
  galleryImages: string[];
  removedIndexes: Set<number>;
  removedAxisValues: AxisRemoval[];
  priceOverrides: Record<number, string>;
  quantityOverrides: Record<number, string>;
  imageOverrides: Record<number, string>;
  imageAxis?: string;
  onRemoveRow: (index: number) => void;
  onRestoreRow: (index: number) => void;
  onRemoveAxisValue: (r: AxisRemoval) => void;
  onRestoreAxisValue: (r: AxisRemoval) => void;
  onPriceChange: (index: number, value: string) => void;
  onQuantityChange: (index: number, value: string) => void;
  onImageChange: (indexes: number[], url: string) => void;
  onUploadImage: (index: number, file: File) => void;
  onApplyAll: (field: "price" | "quantity", value: string) => void;
  disabled: boolean;
}) {
  const [bulkPrice, setBulkPrice] = useState("");
  const [bulkQty, setBulkQty] = useState("");
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [adding, setAdding] = useState<{ axis: string; value: string } | null>(null);
  // Names as the seller has renamed them (unsaved), falling back to the draft's.
  const showAxis = (axis: string) => axisRenames[axis] || axis;
  const axisAllowed = (axis: string) => !blockedAxes || !blockedAxes.some((a) => a.toLowerCase() === showAxis(axis).toLowerCase());
  const [ownName, setOwnName] = useState("");
  const disallowedAxes = specifications.map((s) => s.name).filter((axis) => !axisAllowed(axis));
  // Listing options one by one is a way OUT of a category that refuses this
  // variation (or variations at all); offered only then, with the warning
  // above the table that explains it.
  const splitOffered = Boolean(onSplit) && (variationsSupported === false || disallowedAxes.length > 0);
  const showValue = (axis: string, value: string) => valueRenames[axis]?.[value] || value;
  // Every photo the draft has, for the picker: gallery first, then each
  // variation's own.
  const allImages = [...new Set([...galleryImages, ...variants.flatMap((v) => v.imageUrls || []), ...Object.values(imageOverrides)])];
  // Which row's price working is open — the ROI figure is a button.
  // Rendered position: fixed, so the table's own scroll container can't
  // clip it.
  const [openBreakdown, setOpenBreakdown] = useState<{ index: number; top?: number; bottom?: number; right: number } | null>(null);
  const axisRemoved = (axis: string, value: string) => removedAxisValues.some((r) => r.axis === axis && r.value === value);
  const isRowGone = (variant: VariationDraftVariant, index: number) =>
    removedIndexes.has(index) || Object.entries(variant.aspects).some(([axis, values]) => axisRemoved(axis, values[0]));
  const axes = specifications.map((s) => s.name);
  const remaining = variants.filter((v, i) => !isRowGone(v, i)).length;
  // eBay shows one photo per option of one attribute (Colour, usually): on
  // a Colour × Size listing, every size of Red shows Red's photo. So a photo
  // picked on one row goes to every row with that option. Same rule as the
  // server's (variant-photos.js).
  const photoAxis =
    imageAxis && axes.includes(imageAxis)
      ? imageAxis
      : axes.length <= 1
        ? axes[0]
        : axes.find((a) => /colou?r|pattern|style|design|print|flavou?r|scent|finish/i.test(a)) || axes[0];
  const otherAxes = axes.filter((a) => a !== photoAxis);
  const photoValue = (index: number) => (photoAxis ? variants[index]?.aspects[photoAxis]?.[0] : undefined);
  const photoRows = (index: number) => {
    const value = photoValue(index);
    if (value === undefined || !otherAxes.length) return [index];
    return variants.map((v, i) => (v.aspects[photoAxis!]?.[0] === value ? i : -1)).filter((i) => i >= 0);
  };
  const photoTitle = (index: number) =>
    otherAxes.length && photoValue(index) !== undefined
      ? `Photo for ${showValue(photoAxis!, photoValue(index)!)} · every ${otherAxes.map(showAxis).join(" and ")}`
      : `Photo for ${axes.map((axis) => showValue(axis, variants[index].aspects[axis]?.[0] || "")).filter(Boolean).join(" · ") || `variation ${index + 1}`}`;
  const currency = variants[0]?.price.currency || "GBP";
  const cell = "px-2.5 py-1 align-middle";
  const numInput = "input input-sm !h-7 text-center text-[12.5px]";

  return (
    <div className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className={cardTitleClass}>
          Variations{" "}
          <span className="font-medium text-[var(--color-muted)]">
            · {remaining} of {variants.length} listed
          </span>
        </h3>
        {!disabled && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <span className="text-[var(--color-muted)]">All rows:</span>
            <div className="flex items-center overflow-hidden rounded-full border border-[var(--color-line)]">
              <span className="pl-2.5 text-[var(--color-muted)]">{currencySymbol(currency)}</span>
              <input type="number" step="0.01" min="0" placeholder="price" value={bulkPrice} onChange={(e) => setBulkPrice(e.target.value)} className="h-7 w-16 bg-transparent px-1.5 text-[12.5px] focus:outline-none" />
              <button type="button" disabled={!bulkPrice} onClick={() => { onApplyAll("price", bulkPrice); setBulkPrice(""); }} className="h-7 border-l border-[var(--color-line)] px-2.5 font-semibold text-[var(--color-primary)] disabled:opacity-40">
                Set
              </button>
            </div>
            <div className="flex items-center overflow-hidden rounded-full border border-[var(--color-line)]">
              <input type="number" step="1" min="0" placeholder="qty" value={bulkQty} onChange={(e) => setBulkQty(e.target.value)} className="h-7 w-14 bg-transparent px-2.5 text-[12.5px] focus:outline-none" />
              <button type="button" disabled={!bulkQty} onClick={() => { onApplyAll("quantity", bulkQty); setBulkQty(""); }} className="h-7 border-l border-[var(--color-line)] px-2.5 font-semibold text-[var(--color-primary)] disabled:opacity-40">
                Set
              </button>
            </div>
          </div>
        )}
      </div>

      {variationsSupported === false && (
        <div className="mt-3 rounded-2xl border border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-ink)]">
          <p>
            <strong>eBay doesn&apos;t allow variations in this category.</strong> Publishing this as one listing will be refused. Either
            change the category, or use <em>List separately</em> on each variation you want to sell: each becomes its own single-item
            draft with the shared title, photos and specifics plus that option&apos;s own.
          </p>
        </div>
      )}
      {disallowedAxes.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-2xl border border-[var(--color-warning)]/40">
          <div className="flex items-start gap-3 bg-[var(--color-warning-soft)] px-4 py-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-warning)] text-white">
              <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
                <path d="M12 8v5M12 16.5h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-[var(--color-ink)]">
                eBay won&apos;t accept &ldquo;{disallowedAxes.map(showAxis).join("”, “")}&rdquo; as the thing buyers choose in this category
              </p>
              <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">
                In this category that&apos;s a fixed item specific, not something a listing may vary by. Pick one of the ways out below; publishing is blocked until then.
              </p>
            </div>
          </div>
          <div className="grid gap-4 bg-[var(--color-panel)] px-4 py-4 md:grid-cols-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-muted)]">Switch category</p>
              {fixes === null ? (
                <div className="mt-2 h-9 animate-pulse rounded-xl bg-[var(--color-paper)]" />
              ) : fixes.categories.length === 0 ? (
                <p className="mt-2 text-[12.5px] text-[var(--color-muted)]">
                  None of eBay&apos;s suggested categories for this product allow a variation like this one. You can still change the category by hand from the details panel.
                </p>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {fixes.categories.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      disabled={disabled || applyingFix}
                      onClick={() => onApplyFix?.(c)}
                      className="w-full rounded-xl border border-[var(--color-line)] px-3 py-2 text-left transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)] disabled:opacity-50"
                    >
                      <span className="block text-[13px] font-semibold text-[var(--color-ink)]">{applyingFix ? "Switching…" : `Switch to ${c.name}`}</span>
                      <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{c.path.join(" › ")}</span>
                      <span className="block text-[11.5px] text-[var(--color-muted)]">
                        Options become &ldquo;{Object.values(c.axisNames).join("”, “")}&rdquo; · title and specifics refitted
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-muted)]">Rename the attribute</p>
              <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">Keep the category; call the options one of the names eBay suggests here:</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(allowedAxes || []).map((name) => (
                  <button
                    key={name}
                    type="button"
                    disabled={disabled}
                    onClick={() => disallowedAxes.forEach((axis) => onRenameAxis(axis, name))}
                    className="rounded-full border border-[var(--color-line)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-ink)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                  >
                    {name}
                  </button>
                ))}
              </div>
              <p className="mt-2.5 text-[12.5px] text-[var(--color-muted)]">…or a name of your own (eBay allows it):</p>
              <form
                className="mt-1.5 flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = ownName.trim();
                  if (!name || !axisAllowed(name)) return;
                  disallowedAxes.forEach((axis) => onRenameAxis(axis, name));
                  setOwnName("");
                }}
              >
                <input
                  className="h-8 min-w-0 flex-1 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-3 text-[12.5px] text-[var(--color-ink)] placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] focus:outline-none"
                  placeholder="e.g. Breaking Strain"
                  value={ownName}
                  maxLength={65}
                  disabled={disabled}
                  onChange={(e) => setOwnName(e.target.value)}
                />
                <button type="submit" disabled={disabled || !ownName.trim() || !axisAllowed(ownName.trim())} className="btn btn-primary btn-sm !h-8">
                  Use it
                </button>
              </form>
              {ownName.trim() && !axisAllowed(ownName.trim()) && (
                <p className="mt-1 text-[11.5px] text-[var(--color-danger)]">eBay doesn&apos;t let listings vary by &ldquo;{ownName.trim()}&rdquo; in this category either.</p>
              )}
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-muted)]">List separately</p>
              <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">
                Publish each option as its own listing (the usual way for multipacks). Use the buttons on each row, or all at once:
              </p>
              {onSplitAll && (
                <button type="button" disabled={disabled || splitting !== null} onClick={onSplitAll} className="btn btn-accent btn-sm mt-2">
                  {splitting !== null ? "Creating…" : `List all ${remaining} separately`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {splitDone.length > 0 && (
        <div className="mt-3 rounded-2xl border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-4 py-3 text-sm">
          <p className="font-semibold text-[var(--color-ink)]">
            {splitDone.length} separate draft{splitDone.length === 1 ? "" : "s"} created
          </p>
          <ul className="mt-1 space-y-0.5">
            {splitDone.map((d) => (
              <li key={d.id}>
                <a href={`/accounts/${accountId}/listings/draft/${d.id}`} className="text-[var(--color-primary)] hover:underline">
                  {d.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Attribute values — rename in place, remove a whole colour or size at once */}
      <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
        {specifications.map((spec) => (
          <div key={spec.name} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)]/70 px-3 py-2">
            <div className={`${labelClass} flex items-center justify-between`}>
              <InlineName
                value={showAxis(spec.name)}
                onChange={(to) => onRenameAxis(spec.name, to)}
                disabled={disabled}
                maxLength={65}
                suggestions={allowedAxes || undefined}
                className={`px-1 -ml-1 ${axisAllowed(spec.name) ? "" : "text-[var(--color-danger)]"}`}
              />
              {!disabled && <span className="text-[10px] font-medium normal-case tracking-normal text-[var(--color-muted)]">click a name to rename</span>}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {spec.values.map((value) => {
                const gone = axisRemoved(spec.name, value);
                const count = variants.filter((v) => v.aspects[spec.name]?.[0] === value).length;
                return (
                  <span
                    key={value}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-full border pl-2.5 pr-0.5 text-[12.5px] ${
                      gone
                        ? "border-dashed border-[var(--color-line)] text-[var(--color-muted)]"
                        : "border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-ink)]"
                    }`}
                  >
                    {gone ? (
                      <span className="line-through">{showValue(spec.name, value)}</span>
                    ) : (
                      <InlineName value={showValue(spec.name, value)} onChange={(to) => onRenameValue(spec.name, value, to)} disabled={disabled} className="font-medium" />
                    )}
                    {specifications.length > 1 && (
                      <span title={`${count} variation${count === 1 ? "" : "s"} use this`} className="rounded-full bg-[var(--color-paper)] px-1.5 text-[10.5px] font-semibold text-[var(--color-muted)]">
                        {count}
                      </span>
                    )}
                    {!disabled && (
                      <button
                        type="button"
                        aria-label={gone ? `Restore ${value}` : `Remove ${value}`}
                        title={gone ? "Restore" : specifications.length > 1 ? `Remove all ${count} combination${count === 1 ? "" : "s"}` : "Remove this option"}
                        onClick={() => (gone ? onRestoreAxisValue({ axis: spec.name, value }) : onRemoveAxisValue({ axis: spec.name, value }))}
                        className={`flex h-5.5 w-5.5 items-center justify-center rounded-full transition-colors ${
                          gone
                            ? "text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
                            : "text-[var(--color-muted)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
                        }`}
                      >
                        {gone ? Icon.restore : Icon.trash}
                      </button>
                    )}
                  </span>
                );
              })}
              {addedValues
                .filter((a) => a.axis === spec.name)
                .map((a) => (
                  <span key={`new-${a.value}`} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed border-[var(--color-primary)] bg-[var(--color-primary-soft)] pl-2.5 pr-0.5 text-[12.5px] text-[var(--color-ink)]">
                    <span className="font-medium">{a.value}</span>
                    <span className="text-[11px] font-semibold text-[var(--color-primary)]">new</span>
                    {!disabled && (
                      <button type="button" aria-label={`Undo adding ${a.value}`} title="Undo" onClick={() => onUndoAddValue(spec.name, a.value)} className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]">
                        {Icon.close}
                      </button>
                    )}
                  </span>
                ))}
              {!disabled &&
                (adding?.axis === spec.name ? (
                  <form
                    className="inline-flex h-7 items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const value = adding.value.trim();
                      const taken = spec.values.some((v) => showValue(spec.name, v).toLowerCase() === value.toLowerCase()) || addedValues.some((a) => a.axis === spec.name && a.value.toLowerCase() === value.toLowerCase());
                      if (!value || taken) return;
                      onAddValue(spec.name, value, spec.values[0]);
                      setAdding(null);
                    }}
                  >
                    <input
                      autoFocus
                      className="h-7 w-28 rounded-full border border-[var(--color-primary)] bg-[var(--color-panel)] px-2.5 text-[12.5px] focus:outline-none"
                      placeholder={`New ${showAxis(spec.name).toLowerCase()}`}
                      value={adding.value}
                      maxLength={50}
                      onChange={(e) => setAdding({ axis: spec.name, value: e.target.value })}
                      onKeyDown={(e) => e.key === "Escape" && setAdding(null)}
                    />
                    <button type="submit" className="btn btn-primary btn-sm !h-7">
                      Add
                    </button>
                    <button type="button" onClick={() => setAdding(null)} className="btn btn-ghost btn-sm !h-7">
                      Cancel
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAdding({ axis: spec.name, value: "" })}
                    className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-[var(--color-line-strong)] px-2.5 text-[12px] font-medium text-[var(--color-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                  >
                    + Add option
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2.5 overflow-x-auto rounded-xl border border-[var(--color-line)]">
        <table className="w-full min-w-[640px] border-collapse text-[12.5px]">
          <thead className="bg-[var(--color-paper)] text-left">
            <tr className="text-[10.5px] font-bold uppercase tracking-wider text-[var(--color-muted)]">
              <th className={`${cell} w-14`}>Photo</th>
              {axes.map((axis) => (
                <th key={axis} className={cell}>
                  {showAxis(axis)}
                </th>
              ))}
              <th className={`${cell} w-28 text-center`}>Price ({currencySymbol(currency)})</th>
              <th className={`${cell} w-20 text-center`}>Qty</th>
              <th className={`${cell} w-20 text-center`}>ROI</th>
              <th className={`${cell} ${splitOffered ? "w-40" : "w-12"}`} />
            </tr>
          </thead>
          <tbody>
            {variants.map((v, i) => {
              const gone = isRowGone(v, i);
              const rowRemovedDirectly = removedIndexes.has(i);
              const image = imageOverrides[i] ?? v.imageUrls[0];
              const roi = v.priceBreakdown ? repriceBreakdown(v.priceBreakdown, priceOverrides[i] ?? v.price.value) : undefined;
              return (
                <tr
                  key={v.sku || i}
                  className={`border-t border-[var(--color-line)] ${gone ? "bg-[var(--color-paper)]/60 text-[var(--color-muted)]" : "hover:bg-[var(--color-paper)]/40"}`}
                >
                  <td className={cell}>
                    <button
                      type="button"
                      disabled={disabled || gone}
                      onClick={() => setPickerFor(i)}
                      title={disabled || gone ? undefined : otherAxes.length && photoValue(i) !== undefined ? `Change the photo for every ${showValue(photoAxis!, photoValue(i)!)} variation` : "Change this variation's photo"}
                      className="group relative block h-9 w-9 rounded-lg disabled:cursor-default"
                    >
                      {image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={image} alt="" className={`h-9 w-9 rounded-lg border border-[var(--color-line)] bg-white object-contain ${gone ? "opacity-40" : ""}`} />
                      ) : (
                        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-[var(--color-danger)] text-[10px] text-[var(--color-danger)]">
                          none
                        </span>
                      )}
                      {!disabled && !gone && (
                        <span className="absolute inset-0 hidden items-center justify-center rounded-lg bg-black/55 text-white group-hover:flex">
                          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                            <path d="M4 7h3l2-2h6l2 2h3v12H4V7z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                            <circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="2" />
                          </svg>
                        </span>
                      )}
                    </button>
                  </td>
                  {axes.map((axis) => (
                    <td key={axis} className={`${cell} font-medium ${gone ? "line-through" : "text-[var(--color-ink)]"}`}>
                      {v.aspects[axis]?.[0] !== undefined ? showValue(axis, v.aspects[axis][0]) : "—"}
                    </td>
                  ))}
                  <td className={`${cell} text-center`}>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={priceOverrides[i] ?? v.price.value}
                      disabled={disabled || gone}
                      onChange={(e) => onPriceChange(i, e.target.value)}
                      className={numInput}
                    />
                  </td>
                  <td className={`${cell} text-center`}>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={quantityOverrides[i] ?? String(v.quantity)}
                      disabled={disabled || gone}
                      onChange={(e) => onQuantityChange(i, e.target.value)}
                      className={numInput}
                    />
                  </td>
                  <td className={`${cell} text-center text-xs font-semibold`}>
                    {roi && !gone ? (
                      <>
                        <button
                          type="button"
                          onClick={(e) => {
                            if (openBreakdown?.index === i) return setOpenBreakdown(null);
                            const r = e.currentTarget.getBoundingClientRect();
                            // Opens below the button when there's room above the
                            // fixed footer; otherwise flips above it.
                            const POPOVER = 360;
                            const FOOTER = 72;
                            const fitsBelow = r.bottom + 6 + POPOVER < window.innerHeight - FOOTER;
                            setOpenBreakdown({
                              index: i,
                              right: window.innerWidth - r.right,
                              ...(fitsBelow ? { top: r.bottom + 6 } : { bottom: window.innerHeight - r.top + 6 }),
                            });
                          }}
                          title="How this price was worked out"
                          aria-expanded={openBreakdown?.index === i}
                          className={`inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11.5px] transition-colors ${
                            roi.roiPercent >= roi.targetRoiPercent
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-400"
                              : "border-[#fecdd3] bg-[var(--color-danger-soft)] text-[var(--color-danger)] hover:border-[var(--color-danger)]"
                          }`}
                        >
                          {roi.roiPercent.toFixed(0)}%
                          <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3 opacity-70">
                            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                            <path d="M12 11v5M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                        </button>
                        {openBreakdown?.index === i && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setOpenBreakdown(null)} aria-hidden />
                            <div className="fixed z-50 w-80 text-left" style={{ top: openBreakdown.top, bottom: openBreakdown.bottom, right: openBreakdown.right, boxShadow: "var(--shadow-pop)" }}>
                              <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1">
                                <div className="flex items-center justify-between px-3 pt-2">
                                  <p className="text-xs font-bold text-[var(--color-ink)]">
                                    {axes.map((axis) => v.aspects[axis]?.[0]).filter(Boolean).join(" · ")}
                                  </p>
                                  <button type="button" onClick={() => setOpenBreakdown(null)} aria-label="Close" className="text-[var(--color-muted)] hover:text-[var(--color-ink)]">
                                    {Icon.close}
                                  </button>
                                </div>
                                <div className="p-2">
                                  <PriceBreakdownPanel breakdown={roi} />
                                </div>
                              </div>
                            </div>
                          </>
                        )}
                      </>
                    ) : (
                      <span className="text-[var(--color-muted)]">—</span>
                    )}
                  </td>
                  <td className={`${cell} text-center`}>
                    {!disabled && splitOffered && onSplit && !gone && (
                      <button
                        type="button"
                        onClick={() => onSplit(i)}
                        disabled={splitting !== null}
                        title="Create a separate single-item draft for this variation"
                        className={`btn btn-sm mr-1 !h-6.5 !px-2 !text-[11.5px] ${variationsSupported === false ? "btn-accent" : "btn-secondary"}`}
                      >
                        {splitting === i ? "Creating…" : "List separately"}
                      </button>
                    )}
                    {!disabled &&
                      (rowRemovedDirectly ? (
                        <button type="button" onClick={() => onRestoreRow(i)} title="Restore this variation" aria-label="Restore this variation" className="btn btn-secondary btn-icon text-[var(--color-accent)]">
                          {Icon.restore}
                        </button>
                      ) : gone ? null : (
                        <button type="button" onClick={() => onRemoveRow(i)} title="Remove this variation" aria-label="Remove this variation" className="btn btn-danger-ghost btn-icon">
                          {Icon.trash}
                        </button>
                      ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pickerFor !== null && variants[pickerFor] && (
        <ImagePickerDialog
          title={photoTitle(pickerFor)}
          images={allImages}
          current={imageOverrides[pickerFor] ?? variants[pickerFor].imageUrls[0] ?? null}
          onPick={(url) => {
            onImageChange(photoRows(pickerFor), url);
            setPickerFor(null);
          }}
          onUpload={(file) => {
            onUploadImage(pickerFor, file);
            setPickerFor(null);
          }}
          onClose={() => setPickerFor(null)}
        />
      )}
    </div>
  );
}

// --- AI panel --------------------------------------------------------------

// One row of a proposal: what changes, from what, to what.
type ChangeRow = { label: string; from?: string; to: string; long?: boolean };

function AiPanel({
  scope,
  onScopeChange,
  imageLabel,
  onProposeText,
  onProposeImage,
  textProposal,
  textRows,
  imageProposal,
  onAcceptText,
  onAcceptImage,
  onDiscard,
  busy,
  currentImageUrl,
  hasVariations,
  initialInstruction,
}: {
  scope: "text" | "image";
  onScopeChange: (s: "text" | "image") => void;
  imageLabel: string;
  onProposeText: (instruction: string) => void;
  onProposeImage: (instruction: string) => void;
  textProposal: TextProposal | null;
  textRows: ChangeRow[];
  imageProposal: ImageProposal | null;
  onAcceptText: () => void;
  onAcceptImage: () => void;
  onDiscard: () => void;
  busy: boolean;
  currentImageUrl: string | null;
  hasVariations: boolean;
  initialInstruction?: string | null; // typed in for the seller (a health check's fix), not sent
}) {
  const [instruction, setInstruction] = useState(initialInstruction || "");
  const proposal = scope === "text" ? textProposal : imageProposal;

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const text = instruction.trim();
    if (!text) return;
    if (scope === "text") onProposeText(text);
    else onProposeImage(text);
  }

  const ideas =
    scope === "text"
      ? [
          "Shorten the description",
          "Add 3 bullet points of key benefits",
          hasVariations ? "Set every price to £4.99" : "Set the quantity to 10",
          "Make the title more searchable",
        ]
      : ['Add the heading "FREE UK DELIVERY"', "Add a UK flag badge"];

  return (
    <div id="ask-ai" className={`${cardClass} scroll-mt-4 border-[var(--color-primary)]/25 bg-gradient-to-b from-[var(--color-primary-soft)]/50 to-[var(--color-panel)]`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className={`${cardTitleClass} flex items-center gap-1.5`}>
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-[var(--color-primary)]">
            <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" fill="currentColor" />
          </svg>
          Ask AI
        </h3>
        <div className="flex gap-1 rounded-full bg-[var(--color-paper)] p-0.5">
          {(
            [
              ["text", "Listing"],
              ["image", imageLabel],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onScopeChange(value)}
              className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
                scope === value ? "bg-[var(--color-panel)] text-[var(--color-ink)] shadow-sm" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-muted)]">
        {scope === "text"
          ? "Change anything on this page in your own words — title, description, specifics, prices, quantities, variation names, policies. Nothing changes until you accept."
          : "Add a heading or a badge to this photo. You'll see the result before it replaces anything."}
      </p>

      <form onSubmit={submit} className="mt-2.5">
        <div className="flex items-end gap-1.5 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1.5 focus-within:border-[var(--color-primary)]">
          <textarea
            rows={2}
            className="min-h-[2.5rem] flex-1 resize-none bg-transparent px-2 py-1 text-[13px] leading-snug text-[var(--color-ink)] placeholder:text-[var(--color-muted)]/70 focus:outline-none"
            placeholder={scope === "text" ? 'e.g. "make the description shorter and set all prices to £4.49"' : 'e.g. "add the heading BUY 2 GET 1 FREE"'}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={busy}
          />
          <button type="submit" disabled={busy || !instruction.trim()} className="btn btn-primary btn-sm flex-shrink-0">
            {busy ? "Working…" : "Propose"}
          </button>
        </div>
      </form>
      {!proposal && (
        <div className="mt-2 flex flex-wrap gap-1">
          {ideas.map((idea) => (
            <button
              key={idea}
              type="button"
              disabled={busy}
              onClick={() => setInstruction(idea)}
              className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-0.5 text-[11px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
            >
              {idea}
            </button>
          ))}
        </div>
      )}

      {proposal && (
        <div className="mt-3 overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]">
          <div className="flex items-start gap-2 border-b border-[var(--color-line)] px-3 py-2">
            <span className={`mt-0.5 h-2 w-2 flex-shrink-0 rounded-full ${textProposal?.cannotDo && scope === "text" ? "bg-[var(--color-warning)]" : "bg-[var(--color-primary)]"}`} />
            <p className="text-[12.5px] leading-snug text-[var(--color-ink)]">{proposal.summary}</p>
          </div>

          {scope === "image" && imageProposal && (
            <div className="p-3">
              {imageProposal.policyWarning && (
                <div className="mb-2">
                  <Alert>{imageProposal.policyWarning}</Alert>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="mb-1 text-[10.5px] font-bold uppercase tracking-wide text-[var(--color-muted)]">Now</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {currentImageUrl && <img src={currentImageUrl} alt="" className="aspect-square w-full rounded-lg border border-[var(--color-line)] bg-white object-contain" />}
                </div>
                <div>
                  <p className="mb-1 text-[10.5px] font-bold uppercase tracking-wide text-[var(--color-primary)]">Proposed</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageProposal.previewDataUrl} alt="" className="aspect-square w-full rounded-lg border border-[var(--color-primary)] bg-white object-contain" />
                </div>
              </div>
            </div>
          )}

          {scope === "text" && textProposal && !textProposal.cannotDo && textRows.length === 0 && (
            <p className="px-3 py-2 text-[12px] leading-relaxed text-[var(--color-muted)]">Nothing to change: the listing&apos;s own facts don&apos;t say more than what&apos;s already there.</p>
          )}
          {scope === "text" && textProposal && textRows.length > 0 && (
            <ul className="max-h-72 divide-y divide-[var(--color-line)] overflow-y-auto">
              {textRows.map((row, i) => (
                <li key={i} className="px-3 py-2">
                  <p className="text-[10.5px] font-bold uppercase tracking-wide text-[var(--color-muted)]">{row.label}</p>
                  {row.long ? (
                    <div className="mt-1 grid grid-cols-2 gap-2 text-[12px] leading-snug">
                      <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--color-paper)] p-2 text-[var(--color-muted)]">{row.from}</p>
                      <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-primary-soft)]/40 p-2 text-[var(--color-ink)]">{row.to}</p>
                    </div>
                  ) : (
                    <p className="mt-0.5 text-[12.5px] leading-snug">
                      {row.from !== undefined && <span className="text-[var(--color-muted)] line-through decoration-[var(--color-muted)]/60">{row.from}</span>}
                      {row.from !== undefined && <span className="mx-1.5 text-[var(--color-muted)]">→</span>}
                      <span className="font-semibold text-[var(--color-ink)]">{row.to}</span>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-1.5 border-t border-[var(--color-line)] bg-[var(--color-paper)]/60 px-3 py-2">
            {!(scope === "text" && (textProposal?.cannotDo || textRows.length === 0)) && (
              <button type="button" onClick={scope === "text" ? onAcceptText : onAcceptImage} disabled={busy} className="btn btn-primary btn-sm">
                Accept
              </button>
            )}
            <button type="button" onClick={onDiscard} disabled={busy} className="btn btn-ghost btn-sm">
              {scope === "text" && (textProposal?.cannotDo || textRows.length === 0) ? "OK" : "Discard"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Published popup ----------------------------------------------------------

const EBAY_ITEM_HOSTS: Record<string, string> = { EBAY_GB: "www.ebay.co.uk", EBAY_US: "www.ebay.com", EBAY_DE: "www.ebay.de", EBAY_AU: "www.ebay.com.au" };

function PublishedDialog({ listing, onClose }: { listing: DraftListing; onClose: () => void }) {
  const c = listing.generated_data as DraftContent;
  const variation = isVariationDraft(c) ? c : null;
  const single = isVariationDraft(c) ? null : c;
  const title = variation ? variation.commonTitle : single!.title;
  const image = c.imageUrls?.[0];
  const prices = variation ? variation.variants.map((v) => parseFloat(v.price.value)).filter((n) => !Number.isNaN(n)) : [];
  const currency = variation ? variation.variants[0]?.price.currency || "GBP" : single!.price.currency;
  const priceText = variation
    ? prices.length
      ? `${formatPrice(Math.min(...prices), currency)}${Math.max(...prices) !== Math.min(...prices) ? ` to ${formatPrice(Math.max(...prices), currency)}` : ""}`
      : "—"
    : formatPrice(single!.price.value, currency);
  const itemId = listing.external_product_id;
  const host = EBAY_ITEM_HOSTS[c.marketplaceId || "EBAY_GB"] || "www.ebay.co.uk";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(15,23,42,0.45)] p-4" role="dialog" aria-modal="true">
      <div className="card w-full max-w-md p-6" style={{ boxShadow: "var(--shadow-pop)" }}>
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
              <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <h2 className="text-base font-bold text-[var(--color-ink)]">Your listing is live on eBay</h2>
            {itemId && <p className="text-xs text-[var(--color-muted)]">Item {itemId}</p>}
          </div>
        </div>

        <div className="mt-5 flex gap-4 rounded-2xl border border-[var(--color-line)] p-3">
          {image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className="h-20 w-20 flex-shrink-0 rounded-xl border border-[var(--color-line)] bg-white object-contain" />
          )}
          <div className="min-w-0">
            <p className="line-clamp-2 text-sm font-semibold leading-snug text-[var(--color-ink)]">{title}</p>
            <p className="mt-1.5 text-sm text-[var(--color-ink)]">
              <span className="font-bold">{priceText}</span>
              {variation && <span className="text-[var(--color-muted)]"> · {variation.variants.length} variations</span>}
            </p>
            <p className="mt-0.5 text-xs text-[var(--color-muted)]">{c.imageUrls?.length || 0} photos</p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          {itemId && (
            <a href={`https://${host}/itm/${itemId}`} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
              View on eBay
            </a>
          )}
          <button type="button" onClick={onClose} className="btn btn-primary btn-sm">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Page ------------------------------------------------------------------

// Every item specific eBay lists for the category appears as a row, filled
// or not, so the seller sees what's required and what else could help.
// Required ones sit first, then filled, then recommended, then the rest.
function withSchemaRows(rows: { name: string; value: string }[], info: DraftCategoryInfo | null) {
  if (!info?.aspects?.length) return rows;
  const byName = new Map(info.aspects.map((a) => [a.name.toLowerCase(), a]));
  const have = new Set(rows.map((r) => r.name.trim().toLowerCase()));
  const missing = info.aspects.filter((a) => !have.has(a.name.toLowerCase())).map((a) => ({ name: a.name, value: "" }));
  const merged = [...rows, ...missing];
  const rank = (r: { name: string; value: string }) => {
    const entry = byName.get(r.name.trim().toLowerCase());
    if (entry?.required) return 0;
    if (r.value.trim()) return 1;
    if (entry?.recommended) return 2;
    return 3;
  };
  return merged.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

export default function DraftEditorPage() {
  const params = useParams<{ id: string; offerId: string }>();
  const router = useRouter();
  // ?ask= is a fix from Analytics' health check ("Fill specifics with AI"):
  // once the listing is loaded, Ask AI proposes it straight away and the
  // proposal waits for the seller to Accept — nothing changes on eBay until
  // they accept and update the listing.
  // Read through Next's router, not window.location: arriving by a click
  // inside the app, the address bar may not show the new URL yet when this
  // page first renders.
  const searchParams = useSearchParams();
  const [askPrefill] = useState(() => searchParams.get("ask"));
  // With ?apply=1 (the health check's "Apply recommended changes") the
  // proposal is applied to the editor at once; ?todo= lists what only the
  // seller can do (stock, photos…), shown with what was applied.
  const [applyAsked] = useState(() => searchParams.get("apply") === "1");
  const [todoAsked] = useState(() => (searchParams.get("todo") || "").split("|").filter(Boolean));
  const [appliedNote, setAppliedNote] = useState<{ summary: string; rows: ChangeRow[]; todo: string[]; working: boolean } | null>(null);
  const askedRef = useRef(false);

  const [listing, setListing] = useState<DraftListing | null>(null);
  const [policies, setPolicies] = useState<ConnectionPolicies | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Local, unsaved edits. Everything below is diffed against `listing` to
  // build the PATCH on save, so Discard is just clearing this state.
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // "text" reads the plain description; "edit" opens the editor; "preview"
  // shows the branded eBay render (built lazily the first time).
  const [descMode, setDescMode] = useState<"text" | "edit" | "preview">("text");
  // Item specifics as an ordered list so rows can be renamed, added and
  // removed in place. Multi-value aspects are edited as "a, b".
  const [specifics, setSpecifics] = useState<{ name: string; value: string }[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [selectedImage, setSelectedImage] = useState(0);
  const [removedRows, setRemovedRows] = useState<Set<number>>(new Set());
  // Removed variations (kept on the draft until it's published) being put back.
  const [restoreQueue, setRestoreQueue] = useState<number[]>([]);
  const [removedAxisValues, setRemovedAxisValues] = useState<AxisRemoval[]>([]);
  // Renamed option and attribute names, keyed by the draft's current names.
  const [valueRenames, setValueRenames] = useState<Renames>({});
  const [axisRenames, setAxisRenames] = useState<Record<string, string>>({});
  const [addedValues, setAddedValues] = useState<{ axis: string; value: string; copyFrom: string }[]>([]);
  const [priceOverrides, setPriceOverrides] = useState<Record<number, string>>({});
  const [quantityOverrides, setQuantityOverrides] = useState<Record<number, string>>({});
  const [condition, setCondition] = useState("NEW");
  const [singlePrice, setSinglePrice] = useState("");
  const [singleQuantity, setSingleQuantity] = useState("1");
  const [policyIds, setPolicyIds] = useState<{ fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string }>({
    fulfillmentPolicyId: "",
    paymentPolicyId: "",
    returnPolicyId: "",
  });
  const [showNotes, setShowNotes] = useState(false);
  const [imageOverrides, setImageOverrides] = useState<Record<number, string>>({});
  // eBay's custom label, the second item category and Shop categories are
  // plain fields saved with everything else. The primary category is not:
  // changing it refits the whole draft, so it's applied on its own at once.
  const [sku, setSku] = useState("");
  const [secondaryCategoryId, setSecondaryCategoryId] = useState<string | null>(null);
  const [secondaryCategoryPath, setSecondaryCategoryPath] = useState<string[]>([]);
  const [storeCategoryNames, setStoreCategoryNames] = useState<string[]>([]);
  const [categoryInfo, setCategoryInfo] = useState<DraftCategoryInfo | null>(null);
  // Words eBay's hazardous-materials filter refuses (from the server), so
  // the seller sees a "lead clip" problem while typing, not at publish.
  const [policyWords, setPolicyWords] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [shopPickerOpen, setShopPickerOpen] = useState(false);
  // The Shop's departments, read once per page (cached server-side): for
  // the Shop category dialog and so the AI knows what it may file under.
  const [storeCategories, setStoreCategories] = useState<{ categories: StoreCategory[]; hasStore: boolean | null; note: string | null } | null>(null);
  const [refitting, setRefitting] = useState(false);
  const [showOptionalSpecifics, setShowOptionalSpecifics] = useState(false);
  const [splitting, setSplitting] = useState<number | null>(null);
  const [splitDone, setSplitDone] = useState<{ id: string; title: string }[]>([]);
  const [fixes, setFixes] = useState<VariationFixes | null>(null);
  const [applyingFix, setApplyingFix] = useState(false);
  const [imageCheck, setImageCheck] = useState<ImageCheck | null>(null);
  const [uploading, setUploading] = useState(false);

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [regeneratingSku, setRegeneratingSku] = useState(false);
  const [fixingWords, setFixingWords] = useState(false);
  const [policyFixNote, setPolicyFixNote] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [published, setPublished] = useState<DraftListing | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);

  const [aiScope, setAiScope] = useState<"text" | "image">("text");
  const [aiBusy, setAiBusy] = useState(false);
  const [textProposal, setTextProposal] = useState<TextProposal | null>(null);
  const [imageProposal, setImageProposal] = useState<ImageProposal | null>(null);
  const [imageProposalTarget, setImageProposalTarget] = useState<string | null>(null);
  // The branded HTML this draft will publish with — the plain description
  // above wrapped in the account's template with its live listings beneath.
  const [descriptionPreview, setDescriptionPreview] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const content = listing?.generated_data as DraftContent | undefined;
  const variation = content && isVariationDraft(content) ? content : null;
  const single = content && !isVariationDraft(content) ? content : null;
  const editable = listing?.status === "pending_review";
  // A live listing opened for editing: only two ways out, discard or push
  // the changes to eBay. No draft is kept either way.
  const isLiveEdit = Boolean(listing?.edit_of_item_id);
  // An ended listing opened from Inactive: publishing puts it back on eBay
  // (a relist, new item number), and it can go back up unchanged.
  const isRelist = isLiveEdit && Boolean(listing?.source_data?.ended);

  // The category schema in force, for resetFrom to merge unfilled rows in.
  // A ref, kept in step wherever categoryInfo is set, so a save (which also
  // resets) keeps the same rows without the callback depending on state.
  const categoryInfoRef = useRef<DraftCategoryInfo | null>(null);

  // Reads the second category's readable path once per draft load.
  const loadSecondaryPath = useCallback(
    (categoryId: string | null | undefined) => {
      if (!categoryId) {
        setSecondaryCategoryPath([]);
        return;
      }
      api
        .getCategory(params.id, categoryId)
        .then((info) => setSecondaryCategoryPath(info.path.map((p) => (typeof p === "string" ? p : p.name))))
        .catch(() => setSecondaryCategoryPath([`Category ${categoryId}`]));
    },
    [params.id]
  );

  const resetFrom = useCallback((row: DraftListing) => {
    const c = row.generated_data as DraftContent;
    setTitle(isVariationDraft(c) ? c.commonTitle : c.title);
    setDescription(isVariationDraft(c) ? c.commonDescription : c.description);
    const aspects = isVariationDraft(c) ? c.variesBy.aspects : c.aspects;
    setSpecifics(withSchemaRows(Object.entries(aspects || {}).map(([name, values]) => ({ name, value: values.join(", ") })), categoryInfoRef.current));
    setImages(c.imageUrls || []);
    setSelectedImage(0);
    setRemovedRows(new Set());
    setRemovedAxisValues([]);
    setValueRenames({});
    setAxisRenames({});
    setAddedValues([]);
    setPriceOverrides({});
    setQuantityOverrides({});
    setCondition((isVariationDraft(c) ? c.variants[0]?.condition : c.condition) || "NEW");
    setSinglePrice(isVariationDraft(c) ? "" : c.price.value);
    setSingleQuantity(isVariationDraft(c) ? "1" : String(c.quantity ?? 1));
    setPolicyIds({
      fulfillmentPolicyId: c.listingPolicies?.fulfillmentPolicyId || "",
      paymentPolicyId: c.listingPolicies?.paymentPolicyId || "",
      returnPolicyId: c.listingPolicies?.returnPolicyId || "",
    });
    setImageOverrides({});
    setSku(c.sku || "");
    setSecondaryCategoryId(c.secondaryCategoryId || null);
    setStoreCategoryNames(c.storeCategoryNames || []);
  }, []);

  // The branded eBay render of the description. Rebuilt whenever the stored
  // draft changes (initial load, save) — called from those places rather
  // than an effect, so the loading flag isn't set mid-render.
  const loadDescriptionPreview = useCallback(async (listingId: string) => {
    setLoadingPreview(true);
    try {
      const { html } = await api.previewDraftDescription(listingId);
      setDescriptionPreview(html);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't build the description preview.");
    } finally {
      setLoadingPreview(false);
    }
  }, []);

  // The branded preview is built only when the seller switches to it, and
  // again after a save while it is showing.
  function switchDescMode(mode: "text" | "edit" | "preview") {
    setDescMode(mode);
    if (mode === "preview" && descriptionPreview === null && listing && !loadingPreview) loadDescriptionPreview(listing.id);
  }
  function previewOutdated(listingId: string) {
    setDescriptionPreview(null);
    if (descMode === "preview") loadDescriptionPreview(listingId);
  }

  const loadStoreCategories = useCallback(
    (refresh = false) =>
      api
        .getStoreCategories(params.id, { refresh })
        .then((data) => {
          setStoreCategories({ categories: data.categories, hasStore: data.hasStore ?? null, note: data.unavailable || null });
        })
        .catch((err) => {
          // A failed read is said so, never shown as "no departments".
          setStoreCategories({ categories: [], hasStore: null, note: err instanceof ApiError ? err.message : "Couldn't read this account's Shop departments. Try again." });
          if (refresh) throw err;
        }),
    [params.id]
  );
  useEffect(() => {
    loadStoreCategories().catch(() => {});
  }, [loadStoreCategories]);

  useEffect(() => {
    api
      .getDraftListing(params.offerId)
      .then((data) => {
        setListing(data.listing);
        setPolicies(data.policies);
        categoryInfoRef.current = data.category;
        setCategoryInfo(data.category);
        setPolicyWords(data.policyWords || []);
        resetFrom(data.listing);
        loadSecondaryPath((data.listing.generated_data as DraftContent).secondaryCategoryId);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this draft."))
      .finally(() => setLoading(false));
  }, [params.offerId, resetFrom, loadSecondaryPath]);

  // Every item specific eBay lists for the category appears as a row, filled
  // or not, so the seller sees what's required and what else could help.
  // Required ones sit first; unfilled optional ones are tucked behind a toggle.
  const schemaByName = useMemo(() => {
    const map = new Map<string, AspectSchemaEntry>();
    for (const entry of categoryInfo?.aspects || []) map.set(entry.name.toLowerCase(), entry);
    return map;
  }, [categoryInfo]);

  const originalAspects = useMemo(
    () => (variation ? variation.variesBy.aspects : single?.aspects) || {},
    [variation, single]
  );
  const editedAspects = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const row of specifics) {
      const name = row.name.trim();
      if (!name || !row.value.trim()) continue;
      // An untouched row keeps its original array exactly — a value that
      // itself contains a comma ("Colour Day, B&W Night") must not be split
      // into two, which made every such draft look edited on load.
      const original = originalAspects[name];
      if (original && original.join(", ") === row.value) {
        out[name] = original;
        continue;
      }
      const values = row.value.split(",").map((v) => v.trim()).filter(Boolean);
      if (values.length) out[name] = values;
    }
    return out;
  }, [specifics, originalAspects]);
  // Order-insensitive: schema rows are sorted for display (required first),
  // which must not read as an edit.
  const stableAspects = (a: Record<string, string[]>) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]]));
  const aspectsChanged = stableAspects(editedAspects) !== stableAspects(originalAspects);

  // All three or none: a blank one (a draft made before the account had
  // defaults) is shown as "Choose…" and only counts as a change, and is
  // saved, once all three are picked.
  const policiesChanged =
    !!content?.listingPolicies &&
    !!(policyIds.fulfillmentPolicyId && policyIds.paymentPolicyId && policyIds.returnPolicyId) &&
    (policyIds.fulfillmentPolicyId !== content.listingPolicies.fulfillmentPolicyId ||
      policyIds.paymentPolicyId !== content.listingPolicies.paymentPolicyId ||
      policyIds.returnPolicyId !== content.listingPolicies.returnPolicyId);

  const policyTriggers = useMemo(() => {
    if (!policyWords.length) return [];
    const pattern = new RegExp(`\\b(${policyWords.map((w) => w.replace(/[-.]/g, "\\$&")).join("|")})\\b`, "gi");
    const found = new Map<string, Set<string>>();
    const scan = (where: string, text: string) => {
      for (const m of text.matchAll(pattern)) {
        const word = m[1].toLowerCase();
        if (!found.has(word)) found.set(word, new Set());
        found.get(word)!.add(where);
      }
    };
    scan("the title", title);
    scan("the description", description);
    for (const row of specifics) if (row.value.trim()) scan(`item specific “${row.name.trim()}”`, row.value);
    if (variation) {
      for (const spec of variation.variesBy.specifications) {
        const shown = spec.values.map((v) => valueRenames[spec.name]?.[v] || v).concat(addedValues.filter((a) => a.axis === spec.name).map((a) => a.value));
        scan(`the ${axisRenames[spec.name] || spec.name} options`, shown.join(" "));
      }
    }
    return [...found].map(([word, places]) => `“${word}” in ${[...places].join(", ")}`);
  }, [policyWords, title, description, specifics, variation, valueRenames, axisRenames, addedValues]);

  function buildPatch(): DraftPatch {
    const patch: DraftPatch = {};
    if (variation) {
      if (title !== variation.commonTitle) patch.commonTitle = title;
      if (description !== variation.commonDescription) patch.commonDescription = description;
    } else if (single) {
      if (title !== single.title) patch.title = title;
      if (description !== single.description) patch.description = description;
    }
    if (content && JSON.stringify(images) !== JSON.stringify(content.imageUrls)) patch.imageUrls = images;
    if (aspectsChanged) patch.aspects = editedAspects;
    if (condition !== ((variation ? variation.variants[0]?.condition : single!.condition) || "NEW")) patch.condition = condition;
    if (policiesChanged) patch.listingPolicies = policyIds;
    if (single) {
      if (singlePrice !== single.price.value) patch.price = { value: singlePrice, currency: single.price.currency };
      if (singleQuantity !== String(single.quantity ?? 1)) patch.quantity = Math.max(0, parseInt(singleQuantity, 10) || 0);
    }

    const variantChanges: DraftPatch["variants"] = {};
    for (const [index, value] of Object.entries(priceOverrides)) {
      const v = variation?.variants[Number(index)];
      if (v && value !== v.price.value) {
        variantChanges[index] = { ...(variantChanges[index] || {}), price: { value, currency: v.price.currency } };
      }
    }
    for (const [index, value] of Object.entries(quantityOverrides)) {
      const v = variation?.variants[Number(index)];
      const qty = Math.max(0, parseInt(value, 10) || 0);
      if (v && qty !== v.quantity) variantChanges[index] = { ...(variantChanges[index] || {}), quantity: qty };
    }
    for (const [index, url] of Object.entries(imageOverrides)) {
      variantChanges[index] = { ...(variantChanges[index] || {}), imageUrls: [url] };
    }
    if (Object.keys(variantChanges).length) patch.variants = variantChanges;
    if (removedRows.size) patch.variantSkusToRemove = [...removedRows].map(String);
    if (restoreQueue.length) patch.restoreVariants = restoreQueue;
    // Renames are applied first on the server, so removals are expressed in
    // the renamed names.
    const renameAxisValues = Object.entries(valueRenames).flatMap(([axis, map]) => Object.entries(map).map(([from, to]) => ({ axis, from, to })));
    const renameAxes = Object.entries(axisRenames).map(([from, to]) => ({ from, to }));
    if (renameAxisValues.length) patch.renameAxisValues = renameAxisValues;
    if (renameAxes.length) patch.renameAxes = renameAxes;
    // Added options refer to renamed names too (renames apply first).
    if (addedValues.length) {
      patch.addAxisValues = addedValues.map((a) => ({
        axis: axisRenames[a.axis] || a.axis,
        value: a.value,
        copyFrom: valueRenames[a.axis]?.[a.copyFrom] || a.copyFrom,
      }));
    }
    if (removedAxisValues.length) {
      patch.removeAxisValues = removedAxisValues.map((r) => ({
        axis: axisRenames[r.axis] || r.axis,
        value: valueRenames[r.axis]?.[r.value] || r.value,
      }));
    }
    if (content && sku.trim() && sku.trim() !== (content.sku || "")) patch.sku = sku.trim();
    if (content && (secondaryCategoryId || null) !== (content.secondaryCategoryId || null)) patch.secondaryCategoryId = secondaryCategoryId;
    if (content && JSON.stringify(storeCategoryNames) !== JSON.stringify(content.storeCategoryNames || [])) patch.storeCategoryNames = storeCategoryNames;
    return patch;
  }
  // Unsaved means the save would carry something. Judged on the patch
  // itself: a price typed and put back is an override but no change, and
  // counting it sent an empty save the server refused ("Nothing to update"),
  // which also stopped the publish behind it.
  const dirty = Boolean(content) && Object.keys(buildPatch()).length > 0;


  // The primary category is applied immediately: the server refits title,
  // specifics and description to it, which is a change the seller should see
  // right away rather than at the next Save. Pending edits are saved first so
  // nothing typed is lost under the refit.
  async function applyCategory(next: CategorySelection) {
    if (!listing || !content) return;
    setPickerOpen(false);
    setSecondaryCategoryId(next.secondaryCategoryId);
    setSecondaryCategoryPath(next.secondaryCategoryPath);
    setStoreCategoryNames(next.storeCategoryNames);
    if (next.categoryId === content.categoryId) return;

    setRefitting(true);
    setError(null);
    try {
      const pending = buildPatch();
      delete pending.aspects; // the refit replaces specifics wholesale
      if (Object.keys(pending).length) await api.updateDraftListing(listing.id, pending);
      const data = await api.updateDraftListing(listing.id, { categoryId: next.categoryId });
      const detail = await api.getDraftListing(listing.id);
      setListing(detail.listing);
      categoryInfoRef.current = detail.category;
      setCategoryInfo(detail.category);
      setImageCheck(data.imageCheck);
      resetFrom(detail.listing);
      previewOutdated(detail.listing.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change the category. Try again.");
    } finally {
      setRefitting(false);
    }
  }

  // When the category refuses the variation attribute, ask the server for
  // the ways out (categories to switch to, names accepted here).
  const needsFixes = Boolean(
    variation &&
      categoryInfo?.blockedVariationAspects?.length &&
      variation.variesBy.specifications.some((spec) => categoryInfo.blockedVariationAspects!.some((a) => a.toLowerCase() === spec.name.toLowerCase()))
  );
  const fixesFor = useRef<string | null>(null);
  useEffect(() => {
    if (!listing || !needsFixes) return;
    const key = `${listing.id}:${content?.categoryId}`;
    if (fixesFor.current === key) return;
    fixesFor.current = key;
    api
      .getVariationFixes(listing.id)
      .then(setFixes)
      .catch(() => setFixes({ axes: [], allowedHere: [], categories: [] }));
  }, [listing, needsFixes, content?.categoryId]);

  async function handleApplyFix(fix: VariationFixes["categories"][number]) {
    if (!listing) return;
    setApplyingFix(true);
    setError(null);
    try {
      const pending = buildPatch();
      delete pending.aspects;
      if (Object.keys(pending).length) await api.updateDraftListing(listing.id, pending);
      const data = await api.applyVariationFix(listing.id, { categoryId: fix.id, axisNames: fix.axisNames });
      const detail = await api.getDraftListing(listing.id);
      setListing(detail.listing);
      categoryInfoRef.current = detail.category;
      setCategoryInfo(detail.category);
      setImageCheck(data.imageCheck);
      setFixes(null);
      resetFrom(detail.listing);
      previewOutdated(detail.listing.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't switch the category. Try again.");
    } finally {
      setApplyingFix(false);
    }
  }

  async function handleSplitAll() {
    if (!listing || !variation) return;
    for (let i = 0; i < variation.variants.length; i += 1) {
      if (removedRows.has(i)) continue;
      await handleSplit(i);
    }
  }

  async function handleSplit(index: number) {
    if (!listing) return;
    setSplitting(index);
    setError(null);
    try {
      const { listing: created } = await api.splitDraftVariant(listing.id, index);
      const c = created.generated_data as DraftContent;
      setSplitDone((list) => [...list, { id: created.id, title: isVariationDraft(c) ? c.commonTitle : c.title }]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create a listing for that variation.");
    } finally {
      setSplitting(null);
    }
  }

  // Edits save themselves. Text is saved a moment after typing stops; row
  // and option changes go with it. On success only the RELATIVE edits
  // (removals, renames, per-row overrides — all indexed against the draft
  // as it was) are cleared, since the server has applied them; anything
  // typed while the request was in flight stays and goes in the next save.
  async function handleSave() {
    if (!listing) return false;
    const patch = buildPatch();
    const signature = JSON.stringify(patch);
    setSaving(true);
    setError(null);
    try {
      const data = await api.updateDraftListing(listing.id, patch);
      setListing(data.listing);
      setImageCheck(data.imageCheck);
      setRemovedRows(new Set());
      setRestoreQueue([]);
      setRemovedAxisValues([]);
      setValueRenames({});
      setAxisRenames({});
      setAddedValues([]);
      setPriceOverrides({});
      setQuantityOverrides({});
      setImageOverrides({});
      previewOutdated(data.listing.id);
      failedSaveRef.current = null;
      return true;
    } catch (err) {
      failedSaveRef.current = signature;
      setError(err instanceof ApiError ? err.message : "Couldn't save your changes. Try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  // What would be saved right now — the trigger for the autosave below.
  const patchSignature = editable && !isLiveEdit && dirty ? JSON.stringify(buildPatch()) : "";
  const failedSaveRef = useRef<string | null>(null);
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  // Other server round-trips (a category refit, a split, a publish) save the
  // pending edits themselves and then reset from the result; an autosave
  // landing in the middle of one would race it.
  const otherRequestBusy = publishing || deleting || refitting || applyingFix || splitting !== null || regeneratingSku || fixingWords;
  useEffect(() => {
    if (!patchSignature || saving || otherRequestBusy) return;
    // A save eBay's rules rejected (a clashing option name, say) is not
    // retried until the seller changes something.
    if (failedSaveRef.current === patchSignature) return;
    if (title.length > TITLE_MAX) return;
    const timer = window.setTimeout(() => void handleSaveRef.current(), 900);
    return () => window.clearTimeout(timer);
  }, [patchSignature, saving, otherRequestBusy, title.length]);

  // Leaving with a save still pending would lose it.
  useEffect(() => {
    if (!patchSignature && !saving) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [patchSignature, saving]);

  // Rewords the filter's words on the server (AI, then fixed replacements)
  // and reloads the draft; anything typed but not yet saved goes up first so
  // nothing is lost.
  async function handleFixPolicyWords() {
    if (!listing) return;
    setFixingWords(true);
    setError(null);
    try {
      if (dirty) {
        const saved = await api.updateDraftListing(listing.id, buildPatch());
        setListing(saved.listing);
        resetFrom(saved.listing);
      }
      const result = await api.fixDraftPolicyWords(listing.id);
      setListing(result.listing);
      resetFrom(result.listing);
      previewOutdated(result.listing.id);
      setPolicyFixNote(
        result.remaining.length
          ? `Reworded, but ${result.remaining.join("; ")} still need${result.remaining.length === 1 ? "s" : ""} a manual edit.`
          : result.changed
            ? `Reworded: ${result.before.join("; ")} — gone. Read the text over, then publish.`
            : result.summary
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reword the draft. Try again.");
    } finally {
      setFixingWords(false);
    }
  }

  async function handleRegenerateSku() {
    if (!listing) return;
    setRegeneratingSku(true);
    setError(null);
    try {
      const data = await api.regenerateDraftSku(listing.id);
      setListing(data.listing);
      setSku(data.sku);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't generate a new SKU. Try again.");
    } finally {
      setRegeneratingSku(false);
    }
  }

  async function handlePublish() {
    if (!listing) return;
    setConfirmPublish(false);
    setPublishing(true);
    setError(null);
    try {
      // Whatever hasn't been saved yet goes up with the publish.
      if (dirty) {
        const saved = await api.updateDraftListing(listing.id, buildPatch());
        setListing(saved.listing);
        resetFrom(saved.listing);
      }
      const data = await api.publishDraftListing(listing.id);
      if (data.listing.relisted) {
        const warning = data.warnings?.length ? `&warning=${encodeURIComponent(data.warnings.join(" "))}` : "";
        router.push(`/accounts/${params.id}/listings?relisted=${data.listing.external_product_id}&from=${data.listing.relistedFrom}${warning}`);
        return;
      }
      if (isLiveEdit) {
        // eBay may have applied only part of the revision; say so on the way out.
        const warning = data.warnings?.length ? `&warning=${encodeURIComponent(data.warnings.join(" "))}` : "";
        router.push(`/accounts/${params.id}/listings?updated=${listing.edit_of_item_id}${warning}`);
        return;
      }
      setListing(data.listing);
      setPublished(data.listing);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't publish this listing. Try again.");
      // A failed publish can change the draft server-side (a renewed SKU,
      // the recorded reason): show what's stored now.
      try {
        const detail = await api.getDraftListing(listing.id);
        setListing(detail.listing);
        resetFrom(detail.listing);
      } catch {
        /* the error above is what matters */
      }
    } finally {
      setPublishing(false);
    }
  }

  // Ends the live listing this working copy edits; the copy goes with it.
  async function handleEndListing() {
    if (!listing?.edit_of_item_id) return;
    setEnding(true);
    setError(null);
    try {
      await api.endLiveListing(params.id, listing.edit_of_item_id);
      router.push(`/accounts/${params.id}/listings?filter=inactive&ended=${listing.edit_of_item_id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't end this listing. Try again.");
      setEnding(false);
      setConfirmEnd(false);
    }
  }

  async function handleDelete() {
    if (!listing) return;
    setDeleting(true);
    try {
      await api.deleteDraftListing(listing.id);
      router.push(`/accounts/${params.id}/listings${isRelist ? "?filter=inactive" : isLiveEdit ? "" : "?filter=draft"}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this draft.");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  // --- gallery edits ---
  // Uploads land on the server immediately (they need an eBay-hosted URL),
  // so the listing is refreshed from the response; local gallery state
  // follows it. Unsaved text edits are untouched.
  async function uploadFiles(files: File[], target: { replaces?: string; variantIndex?: number } = {}) {
    if (!listing) return;
    setUploading(true);
    setError(null);
    try {
      let latest = listing;
      for (const file of files) {
        const data = await api.uploadDraftImage(latest.id, file, target);
        latest = data.listing;
        if (target.replaces) {
          setImages((imgs) => imgs.map((u) => (u === target.replaces ? data.imageUrl : u)));
          target = {}; // only the first file can replace; the rest append
        } else if (target.variantIndex === undefined) {
          setImages((imgs) => [...imgs, data.imageUrl]);
        }
      }
      setListing(latest);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't upload that image.");
    } finally {
      setUploading(false);
    }
  }
  async function downloadImage(index: number) {
    if (!listing) return;
    try {
      await api.downloadDraftImage(listing.id, images[index], index + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't download that image.");
    }
  }
  async function downloadAll() {
    for (let i = 0; i < images.length; i++) await downloadImage(i);
  }

  function setMain(index: number) {
    moveImage(index, 0);
  }
  // Drag-and-drop reorder, the way eBay's photo grid does it: the dragged
  // photo takes the target slot and the ones in between shift by one.
  function moveImage(from: number, to: number) {
    if (from === to) return;
    setImages((imgs) => {
      const next = [...imgs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setSelectedImage(to);
  }
  function deleteImage(index: number) {
    setImages((imgs) => imgs.filter((_, i) => i !== index));
    setSelectedImage((s) => Math.max(0, Math.min(s, images.length - 2)));
  }

  // --- AI ---
  // The editor's state, unsaved edits included, is what the model works from.
  function currentStateForAi(): RevisionCurrentState {
    const axes = variation ? variation.variesBy.specifications.map((s) => s.name) : [];
    const showAxis = (a: string) => axisRenames[a] || a;
    const showValue = (a: string, v: string) => valueRenames[a]?.[v] || v;
    const policyLabel = (key: "fulfillmentPolicyId" | "paymentPolicyId" | "returnPolicyId") => policyName(policies, key, policyIds[key]);
    return {
      title,
      description,
      aspects: editedAspects,
      condition,
      sku,
      currency: (variation ? variation.variants[0]?.price.currency : single?.price.currency) || "GBP",
      price: single ? singlePrice : undefined,
      quantity: single ? Math.max(0, parseInt(singleQuantity, 10) || 0) : undefined,
      specifications: variation
        ? variation.variesBy.specifications.map((spec) => ({
            name: showAxis(spec.name),
            values: [...spec.values.filter((v) => !removedAxisValues.some((r) => r.axis === spec.name && r.value === v)).map((v) => showValue(spec.name, v)), ...addedValues.filter((a) => a.axis === spec.name).map((a) => a.value)],
          }))
        : [],
      variants: variation
        ? variation.variants
            .map((v, index) => ({ v, index }))
            .filter(({ v, index }) => !removedRows.has(index) && !Object.entries(v.aspects).some(([axis, values]) => removedAxisValues.some((r) => r.axis === axis && r.value === values[0])))
            .map(({ v, index }) => ({
              index,
              options: axes.map((a) => (v.aspects[a]?.[0] ? showValue(a, v.aspects[a][0]) : "")).filter(Boolean).join(" · "),
              price: priceOverrides[index] ?? v.price.value,
              quantity: Math.max(0, parseInt(quantityOverrides[index] ?? String(v.quantity), 10) || 0),
            }))
        : [],
      policies: content?.listingPolicies ? { postage: policyLabel("fulfillmentPolicyId"), payment: policyLabel("paymentPolicyId"), returns: policyLabel("returnPolicyId") } : undefined,
      storeCategoryNames,
      storeCategories: flattenStorePaths(storeCategories?.categories || []),
    };
  }

  async function proposeText(instruction: string) {
    if (!listing) return;
    setAiBusy(true);
    setError(null);
    try {
      const proposal = await api.reviseDraftText(listing.id, instruction, currentStateForAi());
      setTextProposal(proposal);
      return proposal;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The AI couldn't make that change.");
      return null;
    } finally {
      setAiBusy(false);
    }
  }
  // The health check's fix, asked once the editor holds this listing (its
  // title state matches the loaded draft); ?ask= is then dropped so a reload
  // doesn't ask again.
  const editorReady = Boolean(content) && title === (content ? (isVariationDraft(content) ? content.commonTitle : content.title) : null);
  // Only a to-do (nothing the AI can change): shown as it opens.
  useEffect(() => {
    if (askPrefill || !applyAsked || !todoAsked.length || askedRef.current || !editorReady) return;
    askedRef.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    setAppliedNote({ summary: "Nothing here can be changed automatically; the list below is for you.", rows: [], todo: todoAsked, working: false });
  }, [askPrefill, applyAsked, todoAsked, editorReady]);

  useEffect(() => {
    if (!askPrefill || askedRef.current || !editable || !editorReady || !listing) return;
    askedRef.current = true;
    setAiScope("text");
    window.history.replaceState(null, "", window.location.pathname);
    if (applyAsked) {
      // Applied straight into the editor; the note at the top says what.
      setAppliedNote({ summary: "", rows: [], todo: todoAsked, working: true });
      proposeText(askPrefill).then((proposal) => {
        if (!proposal || proposal.cannotDo) {
          setAppliedNote({ summary: proposal?.summary || "", rows: [], todo: todoAsked, working: false });
          return;
        }
        const rows = changeRowsFor(proposal);
        if (rows.length) applyTextChanges(proposal.changes);
        setTextProposal(null);
        setAppliedNote({ summary: proposal.summary, rows, todo: todoAsked, working: false });
      });
      return;
    }
    const show = () => document.getElementById("ask-ai")?.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(show, 150);
    proposeText(askPrefill).then(() => setTimeout(show, 50));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the editor is ready
  }, [askPrefill, editable, editorReady, listing]);

  async function proposeImage(instruction: string) {
    if (!listing || !images[selectedImage]) return;
    setAiBusy(true);
    setError(null);
    try {
      const target = images[selectedImage];
      setImageProposalTarget(target);
      setImageProposal(await api.reviseDraftImage(listing.id, target, instruction));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The AI couldn't make that change.");
    } finally {
      setAiBusy(false);
    }
  }

  // The model names options and attributes as the editor shows them (i.e.
  // after any unsaved rename); local state is keyed by the draft's
  // original names, so map back.
  const originalAxis = (shown: string) => {
    const hit = variation?.variesBy.specifications.find((s) => (axisRenames[s.name] || s.name).toLowerCase() === shown.toLowerCase());
    return hit?.name ?? shown;
  };
  const originalValue = (axis: string, shown: string) => {
    const spec = variation?.variesBy.specifications.find((s) => s.name === axis);
    const hit = spec?.values.find((v) => (valueRenames[axis]?.[v] || v).toLowerCase() === shown.toLowerCase());
    return hit ?? shown;
  };

  // The proposal, as rows the panel can show: field, before, after.
  // What a text proposal would change, against the editor as it is now.
  function changeRowsFor(proposal: TextProposal): ChangeRow[] {
    const c = proposal.changes;
    const rows: ChangeRow[] = [];
    const newTitle = c.title ?? c.commonTitle;
    const newDesc = c.description ?? c.commonDescription;
    if (newTitle !== undefined && newTitle !== title) rows.push({ label: "Title", from: title, to: newTitle });
    if (newDesc !== undefined && newDesc !== description) rows.push({ label: "Description", from: description, to: newDesc, long: true });
    for (const [name, values] of Object.entries(c.aspects || {})) {
      const from = editedAspects[name]?.join(", ");
      const to = values.join(", ");
      // The same value again isn't a change (the model sometimes repeats what's there).
      if ((from ?? "").trim().toLowerCase() === to.trim().toLowerCase()) continue;
      rows.push({ label: `Specific · ${name}`, from, to });
    }
    for (const name of c.removeAspects || []) if (editedAspects[name]) rows.push({ label: `Specific · ${name}`, from: editedAspects[name].join(", "), to: "removed" });
    if (c.condition && c.condition !== condition) rows.push({ label: "Condition", from: CONDITIONS.find((x) => x.value === condition)?.label, to: CONDITIONS.find((x) => x.value === c.condition)?.label || c.condition });
    if (c.price && single) rows.push({ label: "Price", from: formatPrice(singlePrice, single.price.currency), to: formatPrice(c.price.value, c.price.currency) });
    if (c.quantity !== undefined && single) rows.push({ label: "Quantity", from: singleQuantity, to: String(c.quantity) });
    if (c.sku !== undefined) rows.push({ label: "SKU", from: sku || "—", to: c.sku });
    if (c.allVariants?.price) rows.push({ label: "Every variation · price", to: formatPrice(c.allVariants.price.value, c.allVariants.price.currency) });
    if (c.allVariants?.quantity !== undefined) rows.push({ label: "Every variation · quantity", to: String(c.allVariants.quantity) });
    for (const v of c.variants || []) {
      const cur = variation?.variants[v.index];
      if (!cur) continue;
      const name = Object.values(cur.aspects).map((x) => x[0]).join(" · ") || `Variation ${v.index + 1}`;
      if (v.price) rows.push({ label: `${name} · price`, from: formatPrice(priceOverrides[v.index] ?? cur.price.value, cur.price.currency), to: formatPrice(v.price.value, v.price.currency) });
      if (v.quantity !== undefined) rows.push({ label: `${name} · quantity`, from: quantityOverrides[v.index] ?? String(cur.quantity), to: String(v.quantity) });
    }
    for (const r of c.renameAxes || []) rows.push({ label: "Attribute", from: r.from, to: r.to });
    for (const r of c.renameAxisValues || []) rows.push({ label: `${r.axis} option`, from: r.from, to: r.to });
    for (const r of c.removeAxisValues || []) rows.push({ label: `${r.axis} option`, from: r.value, to: "removed with its variations" });
    for (const r of c.addAxisValues || []) rows.push({ label: `${r.axis} option`, to: `${r.value} (new)` });
    for (const i of c.removeVariants || []) {
      const cur = variation?.variants[i];
      if (cur) rows.push({ label: "Variation", from: Object.values(cur.aspects).map((x) => x[0]).join(" · "), to: "removed" });
    }
    if (c.listingPolicies) {
      const labels = { fulfillmentPolicyId: "Postage", paymentPolicyId: "Payment", returnPolicyId: "Returns" } as const;
      for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
        const id = c.listingPolicies[key];
        if (id) rows.push({ label: labels[key], from: policyName(policies, key, policyIds[key]), to: policyName(policies, key, id) });
      }
    }
    if (c.storeCategoryNames) rows.push({ label: "Shop categories", from: storeCategoryNames.join(", ") || "—", to: c.storeCategoryNames.join(", ") || "none" });
    return rows;
  }
  const textRows = textProposal ? changeRowsFor(textProposal) : [];

  function acceptText() {
    if (!textProposal || !content) return;
    applyTextChanges(textProposal.changes);
    setTextProposal(null);
  }

  // Puts a proposal's changes into the editor (saved as a draft; nothing
  // reaches eBay until Publish).
  function applyTextChanges(c: TextProposal["changes"]) {
    if (!content) return;
    const newTitle = c.title ?? c.commonTitle;
    const newDesc = c.description ?? c.commonDescription;
    if (newTitle !== undefined) setTitle(newTitle);
    if (newDesc !== undefined) setDescription(newDesc);
    if (c.aspects || c.removeAspects) {
      setSpecifics((rows) => {
        let next = [...rows];
        for (const [name, values] of Object.entries(c.aspects || {})) {
          const i = next.findIndex((r) => r.name.trim().toLowerCase() === name.toLowerCase());
          const row = { name: i >= 0 ? next[i].name : name, value: values.join(", ") };
          if (i >= 0) next[i] = row;
          else next.push(row);
        }
        for (const name of c.removeAspects || []) {
          next = next.map((r) => (r.name.trim().toLowerCase() === name.toLowerCase() ? { ...r, value: "" } : r));
        }
        return next;
      });
    }
    if (c.condition) setCondition(c.condition);
    if (c.price && single) setSinglePrice(c.price.value);
    if (c.quantity !== undefined && single) setSingleQuantity(String(c.quantity));
    if (c.sku !== undefined) setSku(c.sku);
    if (c.allVariants?.price) applyToAllVariants("price", c.allVariants.price.value);
    if (c.allVariants?.quantity !== undefined) applyToAllVariants("quantity", String(c.allVariants.quantity));
    if (c.variants?.length) {
      const prices: Record<number, string> = {};
      const qtys: Record<number, string> = {};
      for (const v of c.variants) {
        if (v.price) prices[v.index] = v.price.value;
        if (v.quantity !== undefined) qtys[v.index] = String(v.quantity);
      }
      if (Object.keys(prices).length) setPriceOverrides((p) => ({ ...p, ...prices }));
      if (Object.keys(qtys).length) setQuantityOverrides((p) => ({ ...p, ...qtys }));
    }
    if (c.renameAxes?.length) setAxisRenames((r) => ({ ...r, ...Object.fromEntries(c.renameAxes!.map((x) => [originalAxis(x.from), x.to])) }));
    if (c.renameAxisValues?.length) {
      setValueRenames((r) => {
        const next = { ...r };
        for (const x of c.renameAxisValues!) {
          const axis = originalAxis(x.axis);
          next[axis] = { ...(next[axis] || {}), [originalValue(axis, x.from)]: x.to };
        }
        return next;
      });
    }
    if (c.removeAxisValues?.length) {
      setRemovedAxisValues((list) => [...list, ...c.removeAxisValues!.map((x) => ({ axis: originalAxis(x.axis), value: originalValue(originalAxis(x.axis), x.value) }))]);
    }
    if (c.addAxisValues?.length) {
      setAddedValues((list) => [
        ...list,
        ...c.addAxisValues!.map((x) => {
          const axis = originalAxis(x.axis);
          const spec = variation?.variesBy.specifications.find((s) => s.name === axis);
          return { axis, value: x.value, copyFrom: x.copyFrom ? originalValue(axis, x.copyFrom) : spec?.values[0] || "" };
        }),
      ]);
    }
    if (c.removeVariants?.length) setRemovedRows((s) => new Set([...s, ...c.removeVariants!]));
    if (c.listingPolicies) setPolicyIds((p) => ({ ...p, ...c.listingPolicies }));
    if (c.storeCategoryNames) setStoreCategoryNames(c.storeCategoryNames);
  }
  async function acceptImage() {
    if (!listing || !imageProposal || !imageProposalTarget) return;
    setAiBusy(true);
    setError(null);
    try {
      // Accepting uploads the image to eBay Picture Services and swaps it in
      // server-side; the local gallery follows so the carousel updates.
      const data = await api.acceptDraftImage(listing.id, imageProposal.proposalId, imageProposalTarget);
      setImages((imgs) => imgs.map((u) => (u === imageProposalTarget ? data.imageUrl : u)));
      setListing(data.listing);
      setImageProposal(null);
      setImageProposalTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't apply that image change.");
    } finally {
      setAiBusy(false);
    }
  }

  function applyToAllVariants(field: "price" | "quantity", value: string) {
    if (!variation) return;
    const next: Record<number, string> = {};
    variation.variants.forEach((_, i) => {
      next[i] = value;
    });
    if (field === "price") setPriceOverrides(next);
    else setQuantityOverrides(next);
  }

  if (loading) {
    return <EditorSkeleton />;
  }

  if (!listing || !content) {
    return (
      <main className="flex h-screen items-center justify-center px-6">
        <Alert>{error || "This draft doesn't exist, or isn't yours."}</Alert>
      </main>
    );
  }

  const busy = saving || publishing || deleting || aiBusy || refitting || splitting !== null || applyingFix;
  const canPublish = editable && !busy && title.length <= TITLE_MAX;
  const conditionLabel = CONDITIONS.find((c) => c.value === condition)?.label || condition;
  const notes = content.warnings || [];

  return (
    <main className="flex h-screen flex-col bg-[var(--color-paper)]">
      <EditorHeader
        backHref={`/accounts/${params.id}/listings${isRelist ? "?filter=inactive" : isLiveEdit ? "" : "?filter=draft"}`}
        backLabel={isLiveEdit ? "Back to listings" : "Back to drafts"}
        title={isRelist ? "Relist listing" : isLiveEdit ? "Edit live listing" : editable ? "Edit listing" : "Listing"}
        chips={
          notes.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowNotes((v) => !v)}
              title={`${notes.length} drafting ${notes.length === 1 ? "note" : "notes"}`}
              aria-label="Drafting notes"
              className="relative flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-warning)] transition-colors hover:bg-[var(--color-warning-soft)]"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
                <path d="M12 11v5M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-[var(--color-warning)] px-[2px] text-[8px] font-bold leading-none text-white ring-2 ring-[var(--color-panel)]">
                {notes.length}
              </span>
            </button>
          ) : null
        }
        actions={
          isLiveEdit ? (
            <span className="chip font-medium" title={isRelist ? "The ended eBay item; relisting gives it a new number" : "eBay item number"}>
              {isRelist ? "Ended" : "Live"} · #{listing.edit_of_item_id}
            </span>
          ) : editable ? (
            <span className="chip text-xs font-medium text-[var(--color-muted)]" aria-live="polite">
              {saving ? "Saving…" : title.length > TITLE_MAX ? "Shorten the title to save" : dirty ? "Saving soon…" : "All changes saved"}
            </span>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1360px] px-5 py-4">
          {appliedNote && (
            <div className="mb-3 overflow-hidden rounded-2xl border border-[var(--color-primary)]/30 bg-[var(--color-panel)] shadow-[var(--shadow-card)]">
              <div className="flex items-start gap-3 bg-[var(--color-primary-soft)]/60 px-4 py-3">
                <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-white">
                  {appliedNote.working ? (
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
                  ) : (
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
                      <path d="M4 8.5l2.5 2.5L12 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-[var(--color-ink)]">
                    {appliedNote.working
                      ? "Applying the recommended changes…"
                      : appliedNote.rows.length
                        ? `${appliedNote.rows.length} recommended change${appliedNote.rows.length === 1 ? "" : "s"} applied`
                        : "Nothing to change automatically"}
                  </p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
                    {appliedNote.working
                      ? "The AI is working through the health check's recommendations."
                      : appliedNote.rows.length
                        ? "Not on eBay yet: review them below, then Publish changes. Discard changes drops them all."
                        : appliedNote.summary}
                  </p>
                </div>
                {!appliedNote.working && (
                  <button type="button" onClick={() => setAppliedNote(null)} aria-label="Dismiss" className="text-[var(--color-muted)] hover:text-[var(--color-ink)]">
                    {Icon.close}
                  </button>
                )}
              </div>
              {!appliedNote.working && (appliedNote.rows.length > 0 || appliedNote.todo.length > 0) && (
                <div className="grid gap-4 px-4 py-3 md:grid-cols-2">
                  {appliedNote.rows.length > 0 && (
                    <ul className="space-y-1.5">
                      {appliedNote.rows.map((row, i) => (
                        <li key={i} className="text-[12px] leading-snug">
                          <span className="font-semibold text-[var(--color-ink)]">{row.label}</span>
                          <span className="text-[var(--color-muted)]"> · </span>
                          {row.long ? (
                            <span className="text-[var(--color-ink)]">rewritten</span>
                          ) : (
                            <>
                              {row.from && <span className="text-[var(--color-muted)] line-through decoration-[var(--color-muted)]/60">{row.from}</span>}
                              {row.from && <span className="mx-1 text-[var(--color-muted)]">→</span>}
                              <span className="font-medium text-[var(--color-ink)]">{row.to}</span>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {appliedNote.todo.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">For you to do</p>
                      <ul className="mt-1 space-y-1">
                        {appliedNote.todo.map((t) => (
                          <li key={t} className="flex gap-1.5 text-[12px] leading-snug text-[var(--color-ink)]">
                            <span className="text-[var(--color-muted)]">•</span>
                            {t}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {(error || policyFixNote || (listing.error_message && listing.status === "pending_review") || (imageCheck && !imageCheck.ok) || listing.status === "published" || (editable && policyTriggers.length > 0)) && (
            <div className="mb-3 space-y-2">
              {editable && policyTriggers.length > 0 && (
                <div className="notice notice-warning">
                  <span className="flex-1">
                    eBay&apos;s hazardous-materials filter blocks listings with certain words, and this draft has {policyTriggers.join("; ")}. Reword before publishing (e.g. “lead clip” → “weight clip”, “lead-free” → “eco-friendly”), or let the AI do it.
                  </span>
                  <button type="button" onClick={handleFixPolicyWords} disabled={busy || fixingWords} className="btn btn-primary btn-sm whitespace-nowrap">
                    {fixingWords ? "Rewording…" : "Fix it for me"}
                  </button>
                </div>
              )}
              {policyFixNote && (
                <div className="notice notice-success">
                  <span className="flex-1">{policyFixNote}</span>
                  <button type="button" onClick={() => setPolicyFixNote(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
                    {Icon.close}
                  </button>
                </div>
              )}
              {error && (
                <div className="notice notice-danger">
                  <span className="flex-1">{error}</span>
                  <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
                    {Icon.close}
                  </button>
                </div>
              )}
              {listing.error_message && listing.status === "pending_review" && (
                <div className="notice notice-danger">
                  <span className="flex-1">Last publish attempt failed: {listing.error_message}</span>
                </div>
              )}
              {imageCheck && !imageCheck.ok && (
                <div className="notice notice-warning">
                  <span className="flex-1">{imageCheck.errors.join(" ")}</span>
                </div>
              )}
              {listing.status === "published" && (
                <div className="notice notice-success">
                  <span className="flex-1">Live on eBay{listing.external_product_id ? `, item ${listing.external_product_id}` : ""}.</span>
                </div>
              )}
            </div>
          )}
          {showNotes && notes.length > 0 && (
            <div className="mb-3 rounded-2xl border border-amber-200 bg-[var(--color-warning-soft)] px-4 py-2.5">
              <div className="flex items-baseline justify-between">
                <p className="text-[11px] font-bold uppercase tracking-wider text-amber-800">Drafting notes</p>
                <button type="button" onClick={() => setShowNotes(false)} className="text-xs text-amber-800 hover:underline">
                  Hide
                </button>
              </div>
              <ul className="mt-1 space-y-0.5">
                {notes.map((w) => (
                  <li key={w} className="text-[12.5px] leading-relaxed text-amber-900">
                    • {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Photos and the AI box stay in view on the left while the details
              scroll on the right, so there is never a blank column. */}
          <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
            <div className="space-y-4 lg:sticky lg:top-0 lg:max-h-[calc(100vh-7.5rem)] lg:self-start lg:overflow-y-auto lg:pb-1 lg:pr-0.5">
              <GalleryGrid
                images={images}
                selected={selectedImage}
                onSelect={setSelectedImage}
                onSetMain={setMain}
                onMove={moveImage}
                onDelete={deleteImage}
                onUpload={(files) => uploadFiles(files)}
                onReplace={(i, file) => uploadFiles([file], { replaces: images[i] })}
                onDownloadAll={downloadAll}
                uploading={uploading}
                disabled={!editable || busy}
              />
              {editable && (
                <AiPanel
                  scope={aiScope}
                  onScopeChange={setAiScope}
                  imageLabel={`Photo ${selectedImage + 1}`}
                  onProposeText={proposeText}
                  onProposeImage={proposeImage}
                  textProposal={textProposal}
                  textRows={textRows}
                  imageProposal={imageProposal}
                  onAcceptText={acceptText}
                  onAcceptImage={acceptImage}
                  onDiscard={() => {
                    setTextProposal(null);
                    setImageProposal(null);
                  }}
                  busy={aiBusy}
                  currentImageUrl={imageProposalTarget}
                  hasVariations={Boolean(variation)}
                  initialInstruction={askPrefill}
                />
              )}
            </div>

            {/* ---- Right: details ---- */}
            <div className="min-w-0 space-y-4">
              <div className={cardClass}>
                <div className="flex items-baseline justify-between">
                  <label className={labelClass}>Title</label>
                  <span className={`text-[11px] ${title.length > TITLE_MAX ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}>
                    {title.length} / {TITLE_MAX}
                  </span>
                </div>
                <input
                  className={`${inputClass} mt-1 font-semibold ${title.length > TITLE_MAX ? "!border-[var(--color-danger)]" : ""}`}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={!editable || busy}
                />
                {title.length > TITLE_MAX && (
                  <p className="mt-1 text-xs font-semibold text-[var(--color-danger)]">
                    {title.length - TITLE_MAX} characters over eBay&apos;s 80-character limit. Shorten it to save.
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-1 rounded-xl bg-[var(--color-paper)] px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className={labelClass}>Category</p>
                    <p className="mt-0.5 truncate text-[13px] text-[var(--color-ink)]" title={content.categoryPath?.join(" › ")}>
                      {content.categoryPath?.length ? content.categoryPath.join(" › ") : `Category ${content.categoryId}`}
                    </p>
                    <p className="text-[11.5px] text-[var(--color-muted)]">
                      #{content.categoryId}
                      {secondaryCategoryId ? ` · also in ${secondaryCategoryPath.join(" › ") || secondaryCategoryId}` : ""}
                    </p>
                    {refitting && <p className="mt-1 text-xs font-semibold text-[var(--color-primary)]">Refitting the title, item specifics and description to the new category…</p>}
                    {variation && categoryInfo?.variationsSupported === false && (
                      <p className="mt-1 text-xs text-[var(--color-danger)]">eBay doesn&apos;t allow multi-variation listings in this category. Change it, or list each variation separately below.</p>
                    )}
                    {editable && (content.categorySuggestions || []).some((sg) => sg.id !== content.categoryId) && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <span className="text-[11px] text-[var(--color-muted)]">eBay also suggests:</span>
                        {(content.categorySuggestions || [])
                          .filter((sg) => sg.id !== content.categoryId)
                          .slice(0, 3)
                          .map((sg) => (
                            <button
                              key={sg.id}
                              type="button"
                              disabled={busy}
                              title={sg.path.join(" › ")}
                              onClick={() => applyCategory({ categoryId: sg.id, categoryPath: sg.path, secondaryCategoryId, secondaryCategoryPath, storeCategoryNames })}
                              className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-ink)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] disabled:opacity-50"
                            >
                              {sg.name}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                  {editable && (
                    <button type="button" onClick={() => setPickerOpen(true)} disabled={busy} className={smallButton}>
                      {refitting ? "Refitting…" : "Edit"}
                    </button>
                  )}
                </div>

                {/* The seller's own Shop departments: a different thing from
                    eBay's category, so its own row and its own dialog. */}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl bg-[var(--color-paper)] px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className={labelClass}>Shop category</p>
                    {storeCategoryNames.length ? (
                      <p className="mt-0.5 truncate text-[13px] text-[var(--color-ink)]">{storeCategoryNames.map(shopCategoryLabel).join(" · ")}</p>
                    ) : (
                      <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">
                        {storeCategories?.note
                          ? storeCategories.note
                          : storeCategories?.hasStore === false
                            ? "No eBay Shop on this account."
                            : storeCategories && storeCategories.categories.length === 0
                              ? "No Shop departments yet — add one."
                              : "Not filed under a Shop department."}
                      </p>
                    )}
                  </div>
                  {editable && (
                    <button type="button" onClick={() => setShopPickerOpen(true)} disabled={busy || !storeCategories} className={smallButton}>
                      {storeCategoryNames.length ? "Edit" : "Add"}
                    </button>
                  )}
                </div>

                <div className={`mt-3 grid gap-3 ${single ? "sm:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)]" : "sm:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)]"}`}>
                  <div>
                    <label className={labelClass}>SKU (custom label)</label>
                    <div className="relative mt-1">
                      <input className={`${inputClass} font-mono text-[12.5px] ${editable ? "pr-10" : ""}`} value={sku} maxLength={50} placeholder="e.g. Liston-1005006" onChange={(e) => setSku(e.target.value)} disabled={!editable || busy} />
                      {editable && (
                        <button
                          type="button"
                          onClick={handleRegenerateSku}
                          disabled={busy || regeneratingSku}
                          title="Generate a new SKU that nothing else on this account uses"
                          aria-label="Generate a new SKU"
                          className={`absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-primary-soft)] hover:text-[var(--color-primary)] disabled:opacity-50 ${regeneratingSku ? "animate-spin" : ""}`}
                        >
                          {Icon.refresh}
                        </button>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                      {variation && sku.trim() ? `Variations publish as ${sku.trim()}-1, -2, … · ` : ""}
                      Kept unique across the account; a label already in use is replaced at publish.
                    </p>
                  </div>
                  <div>
                    <label className={labelClass}>Condition</label>
                    {editable ? (
                      <select className={`${inputClass} mt-1`} value={condition} onChange={(e) => setCondition(e.target.value)} disabled={busy}>
                        {CONDITIONS.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="mt-1 text-[13px] text-[var(--color-ink)]">{conditionLabel}</p>
                    )}
                  </div>
                  {single && (
                    <>
                      <div>
                        <label className={labelClass}>Price ({currencySymbol(single.price.currency)})</label>
                        <input type="number" step="0.01" min="0" className={`${inputClass} mt-1`} value={singlePrice} onChange={(e) => setSinglePrice(e.target.value)} disabled={!editable || busy} />
                      </div>
                      <div>
                        <label className={labelClass}>Qty</label>
                        <input type="number" step="1" min="0" className={`${inputClass} mt-1`} value={singleQuantity} onChange={(e) => setSingleQuantity(e.target.value)} disabled={!editable || busy} />
                      </div>
                    </>
                  )}
                </div>

                {single?.priceBreakdown && (
                  <details className="mt-2.5 rounded-xl border border-[var(--color-line)]">
                    <summary className="cursor-pointer px-3 py-1.5 text-[12px] font-semibold text-[var(--color-ink)]">
                      How this price was worked out · {repriceBreakdown(single.priceBreakdown, singlePrice).roiPercent.toFixed(0)}% ROI
                    </summary>
                    <div className="border-t border-[var(--color-line)] p-3">
                      <PriceBreakdownPanel breakdown={repriceBreakdown(single.priceBreakdown, singlePrice)} />
                    </div>
                  </details>
                )}

                {content.listingPolicies && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    {(
                      [
                        ["fulfillmentPolicyId", "Postage policy", policies?.fulfillmentPolicies || []],
                        ["paymentPolicyId", "Payment policy", policies?.paymentPolicies || []],
                        ["returnPolicyId", "Returns policy", policies?.returnPolicies || []],
                      ] as const
                    ).map(([key, label, list]) => (
                      <div key={key}>
                        <label className={labelClass}>{label}</label>
                        {editable && list.length > 0 ? (
                          <select
                            className={`input input-sm mt-1 ${policyIds[key] ? "" : "!border-[var(--color-danger)] text-[var(--color-muted)]"}`}
                            value={policyIds[key]}
                            onChange={(e) => setPolicyIds((p) => ({ ...p, [key]: e.target.value }))}
                            disabled={busy}
                            aria-invalid={!policyIds[key]}
                          >
                            {/* Without this, a blank policy would show the first option as if chosen. */}
                            {!policyIds[key] && (
                              <option value="" disabled>
                                Choose a {label.toLowerCase()}…
                              </option>
                            )}
                            {!list.some((p) => p[key] === policyIds[key]) && policyIds[key] && <option value={policyIds[key]}>{policyIds[key]} (no longer on account)</option>}
                            {list.map((p) => (
                              <option key={p[key]} value={p[key]}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <p className="mt-1 truncate text-[13px] text-[var(--color-ink)]" title={policyName(policies, key, policyIds[key])}>
                            {policyName(policies, key, policyIds[key])}
                          </p>
                        )}
                        {editable && list.length > 0 && !policyIds[key] && <p className="mt-1 text-[11.5px] text-[var(--color-danger)]">Not set on this draft. Choose one to publish.</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Item specifics */}
              <div className={cardClass}>
                <div className="flex items-baseline justify-between">
                  <h3 className={cardTitleClass}>
                    Item specifics <span className="font-medium text-[var(--color-muted)]">· {specifics.filter((r) => r.value.trim()).length}</span>
                  </h3>
                  {editable && (
                    <button type="button" onClick={() => setSpecifics((rows) => [...rows, { name: "", value: "" }])} disabled={busy} className={smallButton}>
                      + Add
                    </button>
                  )}
                </div>
                {specifics.length === 0 ? (
                  <p className="mt-2 text-[13px] text-[var(--color-muted)]">No item specifics yet.</p>
                ) : (
                  <div className="mt-2 grid gap-x-5 md:grid-cols-2">
                    {specifics.map((row, i) => {
                      const entry = schemaByName.get(row.name.trim().toLowerCase());
                      const unfilled = !row.value.trim();
                      const optionalHidden = unfilled && !entry?.required && !showOptionalSpecifics;
                      if (optionalHidden) return null;
                      const listId = entry?.allowedValues.length ? `aspect-values-${i}` : undefined;
                      return (
                        <div key={i} className="flex items-center gap-1 border-b border-[var(--color-line)] py-px text-[12.5px]">
                          <input
                            className="h-7 w-[40%] min-w-0 rounded-full border border-transparent bg-transparent px-2 text-[var(--color-muted)] hover:border-[var(--color-line)] focus:border-[var(--color-primary)] focus:outline-none disabled:opacity-100"
                            value={row.name}
                            placeholder="Name"
                            onChange={(e) => setSpecifics((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                            disabled={!editable || busy}
                          />
                          {entry?.required && unfilled && (
                            <span className="shrink-0 rounded-full bg-[var(--color-danger-soft)] px-1.5 text-[9.5px] font-bold uppercase tracking-wide text-[var(--color-danger)]">Required</span>
                          )}
                          <input
                            className={`h-7 min-w-0 flex-1 rounded-full border border-transparent bg-transparent px-2 font-medium text-[var(--color-ink)] hover:border-[var(--color-line)] focus:border-[var(--color-primary)] focus:outline-none disabled:opacity-100 ${unfilled ? "placeholder:italic" : ""}`}
                            value={row.value}
                            list={listId}
                            placeholder={entry ? (entry.required ? "Required by eBay" : "Optional") : "Value"}
                            onChange={(e) => setSpecifics((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                            disabled={!editable || busy}
                          />
                          {listId && (
                            <datalist id={listId}>
                              {entry!.allowedValues.map((v) => (
                                <option key={v} value={v} />
                              ))}
                            </datalist>
                          )}
                          {editable && (
                            <button
                              type="button"
                              aria-label={`Remove ${row.name || "specific"}`}
                              onClick={() => setSpecifics((rows) => rows.filter((_, j) => j !== i))}
                              disabled={busy}
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] disabled:opacity-40"
                            >
                              {Icon.close}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {(() => {
                  const hiddenCount = specifics.filter((r) => !r.value.trim() && !schemaByName.get(r.name.trim().toLowerCase())?.required).length;
                  if (!hiddenCount && !showOptionalSpecifics) return null;
                  return (
                    <button type="button" onClick={() => setShowOptionalSpecifics((v) => !v)} className="mt-2 text-[12px] font-semibold text-[var(--color-primary)] hover:underline">
                      {showOptionalSpecifics ? "Hide empty optional specifics" : `Show ${hiddenCount} more optional specific${hiddenCount === 1 ? "" : "s"} eBay lists for this category`}
                    </button>
                  );
                })()}
              </div>

              {/* Description: the text by default; the branded eBay render on request. */}
              <div className={cardClass}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className={cardTitleClass}>Description</h3>
                  <div className="flex gap-1 rounded-full bg-[var(--color-paper)] p-0.5">
                    {(
                      [
                        ["text", "Text"],
                        ...(editable ? ([["edit", "Edit"]] as const) : []),
                        ["preview", "eBay preview"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => switchDescMode(value)}
                        className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
                          descMode === value ? "bg-[var(--color-panel)] text-[var(--color-ink)] shadow-sm" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {descMode === "edit" && <RichTextEditor value={description} onChange={setDescription} disabled={!editable || busy} />}
                {descMode === "text" && (
                  <div
                    className="mt-2 max-h-[22rem] cursor-text overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)]/60 px-3.5 py-3 text-[13px] leading-relaxed text-[var(--color-ink)]"
                    onClick={() => editable && switchDescMode("edit")}
                    title={editable ? "Click to edit" : undefined}
                  >
                    {description.trim() ? (
                      <div dangerouslySetInnerHTML={{ __html: markersToHtml(description) }} />
                    ) : (
                      <span className="italic text-[var(--color-muted)]">No description yet.</span>
                    )}
                  </div>
                )}
                {descMode === "preview" && (
                  <div className="mt-2">
                    <p className="mb-1.5 text-[11.5px] text-[var(--color-muted)]">
                      {loadingPreview ? "Building the preview…" : dirty ? "Shows the last saved version — save to refresh it." : "As buyers will see it on eBay, in this account's template."}
                    </p>
                    {descriptionPreview !== null ? (
                      <iframe
                        title="Description preview"
                        sandbox=""
                        srcDoc={`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;padding:12px;background:#f3f3f3">${descriptionPreview}</body>`}
                        className={`h-[32rem] w-full rounded-xl border border-[var(--color-line)] bg-white ${dirty ? "opacity-60" : ""}`}
                      />
                    ) : (
                      <div className="h-[32rem] w-full animate-pulse rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)]" />
                    )}
                  </div>
                )}
              </div>

              {variation && (
                <VariationsTable
                  variants={variation.variants}
                  specifications={variation.variesBy.specifications}
                  galleryImages={images}
                  removedIndexes={removedRows}
                  removedAxisValues={removedAxisValues}
                  priceOverrides={priceOverrides}
                  quantityOverrides={quantityOverrides}
                  imageOverrides={imageOverrides}
                  imageAxis={variation.variesBy.aspectsImageVariesBy?.[0]}
                  onRemoveRow={(i) => setRemovedRows((s) => new Set([...s, i]))}
                  onRestoreRow={(i) =>
                    setRemovedRows((s) => {
                      const n = new Set(s);
                      n.delete(i);
                      return n;
                    })
                  }
                  onRemoveAxisValue={(r) => setRemovedAxisValues((list) => [...list, r])}
                  onRestoreAxisValue={(r) => setRemovedAxisValues((list) => list.filter((x) => !(x.axis === r.axis && x.value === r.value)))}
                  onPriceChange={(i, value) => setPriceOverrides((p) => ({ ...p, [i]: value }))}
                  onQuantityChange={(i, value) => setQuantityOverrides((p) => ({ ...p, [i]: value }))}
                  onImageChange={(rows, url) => setImageOverrides((p) => ({ ...p, ...Object.fromEntries(rows.map((i) => [i, url])) }))}
                  onUploadImage={(i, file) => uploadFiles([file], { variantIndex: i })}
                  valueRenames={valueRenames}
                  axisRenames={axisRenames}
                  onRenameValue={(axis, from, to) => setValueRenames((r) => ({ ...r, [axis]: { ...(r[axis] || {}), [from]: to } }))}
                  onRenameAxis={(from, to) => setAxisRenames((r) => ({ ...r, [from]: to }))}
                  addedValues={addedValues}
                  onAddValue={(axis, value, copyFrom) => setAddedValues((list) => [...list, { axis, value, copyFrom }])}
                  onUndoAddValue={(axis, value) => setAddedValues((list) => list.filter((a) => !(a.axis === axis && a.value === value)))}
                  allowedAxes={categoryInfo?.variationAspects ?? null}
                  blockedAxes={categoryInfo?.blockedVariationAspects ?? null}
                  fixes={fixes}
                  onApplyFix={editable ? handleApplyFix : undefined}
                  applyingFix={applyingFix}
                  onSplitAll={editable ? handleSplitAll : undefined}
                  variationsSupported={categoryInfo?.variationsSupported ?? null}
                  onSplit={editable ? handleSplit : undefined}
                  splitting={splitting}
                  splitDone={splitDone}
                  accountId={params.id}
                  onApplyAll={applyToAllVariants}
                  disabled={!editable || busy}
                />
              )}
              {variation && editable && (variation.removedVariants?.length ?? 0) > 0 && (
                <RemovedVariations
                  removed={variation.removedVariants!}
                  restoring={restoreQueue}
                  onRestore={(indexes) => setRestoreQueue((q) => [...new Set([...q, ...indexes])])}
                  disabled={busy}
                />
              )}
            </div>
          </div>
          <div className="h-4" />
        </div>
      </div>

      {editable && (
        <footer className="z-40 flex-shrink-0 border-t border-[var(--color-line)] bg-[var(--color-panel)]">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setConfirmDelete(true)} disabled={busy} className="btn btn-danger-ghost">
                {Icon.trash}
                <span>{isRelist ? "Cancel" : isLiveEdit ? "Discard changes" : "Delete draft"}</span>
              </button>
              {isLiveEdit && !isRelist && (
                <button type="button" onClick={() => setConfirmEnd(true)} disabled={busy || ending} className="btn btn-danger-ghost" title="Take this listing off eBay now">
                  <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <span>{ending ? "Ending…" : "End listing"}</span>
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              {isRelist ? (
                <>
                  <span className="text-xs text-[var(--color-muted)]">{dirty ? "Relisted with your changes" : "Change anything first, or relist it as it was"}</span>
                  <button
                    type="button"
                    onClick={() => setConfirmPublish(true)}
                    disabled={!editable || busy || title.length > TITLE_MAX}
                    title={title.length > TITLE_MAX ? "Shorten the title first" : undefined}
                    className="btn btn-primary"
                  >
                    {publishing ? "Relisting…" : "Relist on eBay"}
                  </button>
                </>
              ) : isLiveEdit ? (
                <>
                  {dirty && <span className="text-xs text-[var(--color-muted)]">Changes go live on eBay when you publish</span>}
                  <button
                    type="button"
                    onClick={() => setConfirmPublish(true)}
                    disabled={!editable || busy || !dirty || title.length > TITLE_MAX}
                    title={!dirty ? "Nothing has changed yet" : title.length > TITLE_MAX ? "Shorten the title first" : undefined}
                    className="btn btn-primary"
                  >
                    {publishing ? "Updating…" : "Publish changes"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmPublish(true)}
                    disabled={!canPublish}
                    title={title.length > TITLE_MAX ? "Shorten the title first" : undefined}
                    className="btn btn-primary"
                  >
                    {publishing ? "Publishing…" : "Publish to eBay"}
                  </button>
                </>
              )}
            </div>
          </div>
        </footer>
      )}

      {published && <PublishedDialog listing={published} onClose={() => router.push(`/accounts/${params.id}/listings`)} />}

      {listing && content && pickerOpen && (
        <CategoryPicker
          connectionId={params.id}
          value={{
            categoryId: content.categoryId,
            categoryPath: content.categoryPath || [],
            secondaryCategoryId,
            secondaryCategoryPath,
            storeCategoryNames,
          }}
          suggestions={content.categorySuggestions || []}
          onApply={applyCategory}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {shopPickerOpen && storeCategories && (
        <ShopCategoryPicker
          value={storeCategoryNames}
          categories={storeCategories.categories}
          hasStore={storeCategories.hasStore}
          note={storeCategories.note}
          onApply={(names) => {
            setStoreCategoryNames(names);
            setShopPickerOpen(false);
          }}
          onClose={() => setShopPickerOpen(false)}
          onRefresh={() => loadStoreCategories(true)}
          onCreate={async (input) => {
            const data = await api.addStoreCategory(params.id, input);
            setStoreCategories({ categories: data.categories, hasStore: data.hasStore ?? true, note: data.unavailable || null });
            return data.created ?? null;
          }}
        />
      )}
      <ConfirmDialog
        open={confirmPublish}
        title={isRelist ? "Relist this on eBay?" : isLiveEdit ? "Publish these changes?" : "Publish this listing?"}
        description={
          isRelist
            ? "It goes back on sale on eBay now as a new listing with a new item number. eBay charges its usual listing fees, if any. The ended listing stays ended."
            : isLiveEdit
            ? "The live eBay listing is updated in place. Buyers see the new title, photos, price, stock and description straight away."
            : `It goes live on eBay immediately${variation ? `, with ${variation.variants.length} variations` : ""}. Publishing creates the listing on eBay now, so this can take a minute or two for large variation sets.`
        }
        confirmLabel={isRelist ? "Relist" : isLiveEdit ? "Publish changes" : "Publish"}
        loading={publishing}
        onCancel={() => setConfirmPublish(false)}
        onConfirm={handlePublish}
      />
      <ConfirmDialog
        open={confirmEnd}
        title="End this listing on eBay?"
        description="It comes off eBay straight away and moves to Inactive. Buyers can no longer purchase it, and the changes you were making here are dropped. You can relist it from the Inactive tab later."
        confirmLabel="End listing"
        danger
        loading={ending}
        onCancel={() => setConfirmEnd(false)}
        onConfirm={handleEndListing}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={isLiveEdit ? "Discard your changes?" : "Delete this draft?"}
        description={
          isLiveEdit
            ? "The listing on eBay stays exactly as it is. Nothing you changed here is kept."
            : "This removes the draft from Liston. Nothing has been created on eBay, so there's nothing to undo there."
        }
        confirmLabel={isLiveEdit ? "Discard" : "Delete"}
        danger
        loading={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
      />
    </main>
  );
}
