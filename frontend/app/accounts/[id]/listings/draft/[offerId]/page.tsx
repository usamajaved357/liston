"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
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
  TextProposal,
  VariationDraftVariant,
  isVariationDraft,
} from "@/lib/api";
import { Alert } from "@/components/Alert";
import { EditorHeader } from "@/components/EditorHeader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CategoryPicker, CategorySelection } from "@/components/CategoryPicker";
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
const cardClass = "card p-5";
const cardTitleClass = "text-[15px] font-bold text-[var(--color-ink)]";
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

const CONDITIONS = [
  { value: "NEW", label: "New" },
  { value: "USED_EXCELLENT", label: "Used, excellent" },
  { value: "USED_GOOD", label: "Used, good" },
  { value: "USED_ACCEPTABLE", label: "Used, acceptable" },
];

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
      {breakdown.basis === "competitor" ? (
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

const TEXT_COLOURS = ["#e11d48", "#d97706", "#059669", "#2563eb", "#7c3aed", "#0f172a"];

// Each marker kind knows how to detect itself around (or inside) a selection,
// so a second click toggles it off and a different colour/size REPLACES the
// current one rather than nesting another wrapper.
const MARKERS = {
  bold: { open: /\*\*$/, close: /^\*\*/, inner: /^\*\*([\s\S]*)\*\*$/ },
  highlight: { open: /==$/, close: /^==/, inner: /^==([\s\S]*)==$/ },
  color: { open: /\[color=#[0-9a-fA-F]{6}\]$/, close: /^\[\/color\]/, inner: /^\[color=#[0-9a-fA-F]{6}\]([\s\S]*)\[\/color\]$/ },
  size: { open: /\[size=(?:sm|lg|xl)\]$/, close: /^\[\/size\]/, inner: /^\[size=(?:sm|lg|xl)\]([\s\S]*)\[\/size\]$/ },
} as const;
type MarkerKind = keyof typeof MARKERS;

function applyMarker(value: string, start: number, end: number, kind: MarkerKind, open: string, close: string, toggle: boolean) {
  const m = MARKERS[kind];
  let before = value.slice(0, start);
  let selected = value.slice(start, end);
  let after = value.slice(end);

  // Already wrapped: either the wrapper sits just outside the selection, or
  // the selection includes it. Strip it first.
  let wasWrapped = false;
  const outsideOpen = before.match(m.open);
  const outsideClose = after.match(m.close);
  if (outsideOpen && outsideClose) {
    before = before.slice(0, before.length - outsideOpen[0].length);
    after = after.slice(outsideClose[0].length);
    wasWrapped = true;
  } else {
    const inside = selected.match(m.inner);
    if (inside) {
      selected = inside[1];
      wasWrapped = true;
    }
  }
  if (!selected) selected = "text";
  // Toggle kinds (bold, highlight) come off on a second click; replace kinds
  // (colour, size) swap to the new value.
  const wrapNow = !(toggle && wasWrapped);
  const next = before + (wrapNow ? open : "") + selected + (wrapNow ? close : "") + after;
  const selStart = before.length + (wrapNow ? open.length : 0);
  return { next, selStart, selEnd: selStart + selected.length };
}

function FormatToolbar({
  textarea,
  value,
  onChange,
  disabled,
}: {
  textarea: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  const [showColours, setShowColours] = useState(false);

  function apply(kind: MarkerKind, open: string, close: string, toggle: boolean) {
    const el = textarea.current;
    if (!el) return;
    const { next, selStart, selEnd } = applyMarker(value, el.selectionStart, el.selectionEnd, kind, open, close, toggle);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(selStart, selEnd);
    });
  }

  const tool =
    "flex h-8 min-w-8 items-center justify-center px-2 text-[var(--color-ink)] transition-colors hover:bg-[var(--color-paper)] disabled:opacity-40";
  const divider = <span className="mx-0.5 h-5 w-px bg-[var(--color-line)]" />;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <div className="inline-flex items-center rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
        <button type="button" disabled={disabled} title="Bold (click again to remove)" aria-label="Bold" onClick={() => apply("bold", "**", "**", true)} className={`${tool} rounded-full font-extrabold`}>
          B
        </button>
        <button type="button" disabled={disabled} title="Highlight (click again to remove)" aria-label="Highlight" onClick={() => apply("highlight", "==", "==", true)} className={`${tool} rounded-full`}>
          <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]">
            <rect x="3" y="18.5" width="18" height="3" rx="1.5" fill="#fde047" />
            <path d="M14.5 4.5l5 5-8 8H6.5v-5l8-8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" fill="#fef3c7" />
            <path d="M12 7l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        {divider}
        <button type="button" disabled={disabled} title="Normal size" aria-label="Normal size" onClick={() => apply("size", "", "", true)} className={`${tool} rounded-full text-[12px] font-semibold`}>
          T
        </button>
        <button type="button" disabled={disabled} title="Large" aria-label="Large text" onClick={() => apply("size", "[size=lg]", "[/size]", false)} className={`${tool} rounded-full text-[15px] font-semibold`}>
          T
        </button>
        <button type="button" disabled={disabled} title="Extra large" aria-label="Extra large text" onClick={() => apply("size", "[size=xl]", "[/size]", false)} className={`${tool} rounded-full text-[18px] font-bold`}>
          T
        </button>
        {divider}
        <div className="relative">
          <button type="button" disabled={disabled} title="Text colour" aria-label="Text colour" onClick={() => setShowColours((v) => !v)} className={`${tool} gap-1 rounded-full`}>
            <span className="flex flex-col items-center leading-none">
              <span className="text-[13px] font-bold">A</span>
              <span className="mt-0.5 h-[3px] w-4 rounded-sm bg-gradient-to-r from-[#e11d48] via-[#059669] to-[#2563eb]" />
            </span>
            <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3 text-[var(--color-muted)]">
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {showColours && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowColours(false)} aria-hidden />
              <div className="absolute left-0 top-full z-50 mt-2 flex items-center gap-1.5 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-1.5" style={{ boxShadow: "var(--shadow-pop)" }}>
                {TEXT_COLOURS.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    aria-label={`Colour ${hex}`}
                    title={hex}
                    onClick={() => {
                      apply("color", `[color=${hex}]`, "[/color]", false);
                      setShowColours(false);
                    }}
                    className="h-6 w-6 rounded-full ring-2 ring-white transition-transform hover:scale-110"
                    style={{ background: hex, boxShadow: "0 0 0 1px var(--color-line)" }}
                  />
                ))}
                <span className="mx-0.5 h-5 w-px bg-[var(--color-line)]" />
                <button
                  type="button"
                  title="Remove colour"
                  aria-label="Remove colour"
                  onClick={() => {
                    apply("color", "", "", true);
                    setShowColours(false);
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
                >
                  {Icon.close}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <span className="text-xs text-[var(--color-muted)]">Select text, then apply. Click again to remove. Shows in the preview after saving.</span>
    </div>
  );
}

// --- Gallery ----------------------------------------------------------------
//
// Every image at once, not a carousel: the seller is deciding what to keep,
// which needs the whole set in view. The first tile is the main image (the
// search thumbnail).

const IMAGE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";

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
  onDelete,
  onUpload,
  onReplace,
  onDownload,
  onDownloadAll,
  onEditWithAi,
  uploading,
  disabled,
}: {
  images: string[];
  selected: number;
  onSelect: (index: number) => void;
  onSetMain: (index: number) => void;
  onDelete: (index: number) => void;
  onUpload: (files: File[]) => void;
  onReplace: (index: number, file: File) => void;
  onDownload: (index: number) => void;
  onDownloadAll: () => void;
  onEditWithAi: (index: number) => void;
  uploading: boolean;
  disabled: boolean;
}) {
  const count = images.length;
  const current = images[selected];

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
          Photos <span className="font-medium text-[var(--color-muted)]">· {count} of 24</span>
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
          {/* Selected image, large */}
          <div className="relative mt-4 aspect-square rounded-xl border border-[var(--color-line)] bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={current} alt="" className="h-full w-full rounded-xl object-contain" />
            {selected === 0 && (
              <span className="chip chip-primary absolute left-3 top-3">
                Main photo
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
                  className="absolute -left-4 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--color-line)] bg-white text-[var(--color-ink)] shadow-md transition-colors hover:border-[var(--color-line-strong)]"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                    <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => onSelect((selected + 1) % count)}
                  aria-label="Next photo"
                  className="absolute -right-4 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--color-line)] bg-white text-[var(--color-ink)] shadow-md transition-colors hover:border-[var(--color-line-strong)]"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
                    <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </>
            )}
          </div>

          {/* Actions for the selected image — icons only, labels on hover */}
          <div className="mt-3 flex items-center gap-1.5">
            <button type="button" onClick={() => onSetMain(selected)} disabled={disabled || selected === 0} title="Set as main photo" aria-label="Set as main photo" className="btn btn-secondary btn-icon">
              {Icon.star}
            </button>
            <FileButton label={Icon.swap} disabled={disabled || uploading} onFiles={(f) => onReplace(selected, f[0])} className="btn btn-secondary btn-icon" title="Replace this photo" />
            <button type="button" onClick={() => onDownload(selected)} title="Download this photo" aria-label="Download this photo" className="btn btn-secondary btn-icon">
              {Icon.download}
            </button>
            <button type="button" onClick={() => onEditWithAi(selected)} disabled={disabled} title="Add text or a badge" aria-label="Add text or a badge" className="btn btn-secondary btn-icon">
              {Icon.text}
            </button>
            <span className="ml-auto text-xs text-[var(--color-muted)]">Photo {selected + 1}</span>
            <button
              type="button"
              onClick={() => onDelete(selected)}
              disabled={disabled || count === 1}
              title={count === 1 ? "A listing needs at least one photo" : "Remove this photo"}
              aria-label="Remove this photo"
              className="btn btn-danger-ghost btn-icon"
            >
              {Icon.trash}
            </button>
          </div>

          {/* Every image */}
          <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-5">
            {images.map((url, i) => (
              <button
                key={`${url}-${i}`}
                type="button"
                onClick={() => onSelect(i)}
                className={`group relative aspect-square overflow-hidden rounded-lg border-2 bg-white transition-all ${
                  i === selected ? "border-[var(--color-primary)] shadow-sm" : "border-[var(--color-line)] hover:border-[var(--color-muted)]"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="h-full w-full object-contain" />
                <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-bold text-white">{i + 1}</span>
                {i === 0 && (
                  <span className="absolute left-0 right-0 top-0 bg-[var(--color-primary)] py-0.5 text-center text-[9px] font-bold uppercase tracking-wide text-white">
                    Main
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
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
  maxLength?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (editing && !disabled) {
    return (
      <input
        autoFocus
        className="h-6 min-w-[6rem] rounded-md border border-[var(--color-primary)] bg-[var(--color-panel)] px-1.5 text-[13px] text-[var(--color-ink)] focus:outline-none"
        value={draft}
        maxLength={maxLength}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft.trim() && draft.trim() !== value) onChange(draft.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
      />
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
}: {
  variants: VariationDraftVariant[];
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
  onRemoveRow: (index: number) => void;
  onRestoreRow: (index: number) => void;
  onRemoveAxisValue: (r: AxisRemoval) => void;
  onRestoreAxisValue: (r: AxisRemoval) => void;
  onPriceChange: (index: number, value: string) => void;
  onQuantityChange: (index: number, value: string) => void;
  onImageChange: (index: number, url: string) => void;
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
  const currency = variants[0]?.price.currency || "GBP";
  const cell = "px-3 py-1.5 align-middle";
  const numInput = "input input-sm text-center";

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
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-[var(--color-muted)]">Apply to all:</span>
            <div className="flex items-center gap-1">
              <span className="text-[var(--color-muted)]">{currencySymbol(currency)}</span>
              <input type="number" step="0.01" min="0" placeholder="price" value={bulkPrice} onChange={(e) => setBulkPrice(e.target.value)} className={`${numInput} w-24`} />
              <button type="button" disabled={!bulkPrice} onClick={() => { onApplyAll("price", bulkPrice); setBulkPrice(""); }} className={smallButton}>
                Set
              </button>
            </div>
            <div className="flex items-center gap-1">
              <input type="number" step="1" min="0" placeholder="qty" value={bulkQty} onChange={(e) => setBulkQty(e.target.value)} className={`${numInput} w-20`} />
              <button type="button" disabled={!bulkQty} onClick={() => { onApplyAll("quantity", bulkQty); setBulkQty(""); }} className={smallButton}>
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

      {!disabled && (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Click an attribute or option name to rename it, or press &ldquo;+ Add option&rdquo; to add one (it copies the first option&apos;s price, quantity and photo; edit them after saving). Click a photo in the table to change it. Bin an option to drop it.
        </p>
      )}

      {/* Attribute values — remove a whole colour or size at once */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {specifications.map((spec) => (
          <div key={spec.name} className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-paper)] px-3.5 py-3">
            <div className={labelClass}>
              <InlineName value={showAxis(spec.name)} onChange={(to) => onRenameAxis(spec.name, to)} disabled={disabled} maxLength={65} className="px-1 -ml-1" />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {spec.values.map((value) => {
                const gone = axisRemoved(spec.name, value);
                const count = variants.filter((v) => v.aspects[spec.name]?.[0] === value).length;
                return (
                  <span
                    key={value}
                    className={`inline-flex h-8 items-center gap-2 rounded-full border pl-3 pr-1 text-[13px] ${
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
                    <span className="rounded-full bg-[var(--color-paper)] px-1.5 text-[11px] font-semibold text-[var(--color-muted)]">{count}</span>
                    {!disabled && (
                      <button
                        type="button"
                        aria-label={gone ? `Restore ${value}` : `Remove ${value}`}
                        title={gone ? "Restore" : `Remove all ${count} combination${count === 1 ? "" : "s"}`}
                        onClick={() => (gone ? onRestoreAxisValue({ axis: spec.name, value }) : onRemoveAxisValue({ axis: spec.name, value }))}
                        className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
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
                  <span key={`new-${a.value}`} className="inline-flex h-8 items-center gap-2 rounded-full border border-dashed border-[var(--color-primary)] bg-[var(--color-primary-soft)] pl-3 pr-1 text-[13px] text-[var(--color-ink)]">
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
                    className="inline-flex h-8 items-center gap-1"
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
                      className="h-8 w-32 rounded-full border border-[var(--color-primary)] bg-[var(--color-panel)] px-3 text-[13px] focus:outline-none"
                      placeholder={`New ${showAxis(spec.name).toLowerCase()}`}
                      value={adding.value}
                      maxLength={50}
                      onChange={(e) => setAdding({ axis: spec.name, value: e.target.value })}
                      onKeyDown={(e) => e.key === "Escape" && setAdding(null)}
                    />
                    <button type="submit" className="btn btn-primary btn-sm !h-8">
                      Add
                    </button>
                    <button type="button" onClick={() => setAdding(null)} className="btn btn-ghost btn-sm !h-8">
                      Cancel
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAdding({ axis: spec.name, value: "" })}
                    className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-[var(--color-line-strong)] px-3 text-[13px] font-medium text-[var(--color-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                  >
                    + Add option
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 overflow-x-auto rounded-2xl border border-[var(--color-line)]">
        <table className="w-full min-w-[720px] border-collapse text-[13px]">
          <thead className="bg-[var(--color-paper)] text-left">
            <tr className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-muted)]">
              <th className={`${cell} w-20`}>Photo</th>
              {axes.map((axis) => (
                <th key={axis} className={cell}>
                  {showAxis(axis)}
                </th>
              ))}
              <th className={`${cell} w-36 text-center`}>Price ({currencySymbol(currency)})</th>
              <th className={`${cell} w-24 text-center`}>Qty</th>
              <th className={`${cell} w-24 text-center`}>ROI</th>
              <th className={`${cell} ${onSplit ? "w-44" : "w-14"}`} />
            </tr>
          </thead>
          <tbody>
            {variants.map((v, i) => {
              const gone = isRowGone(v, i);
              const rowRemovedDirectly = removedIndexes.has(i);
              const image = imageOverrides[i] ?? v.imageUrls[0];
              const roi = v.priceBreakdown;
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
                      title={disabled || gone ? undefined : "Change this variation's photo"}
                      className="group relative block h-11 w-11 rounded-lg disabled:cursor-default"
                    >
                      {image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={image} alt="" className={`h-11 w-11 rounded-lg border border-[var(--color-line)] bg-white object-contain ${gone ? "opacity-40" : ""}`} />
                      ) : (
                        <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-dashed border-[var(--color-danger)] text-[10px] text-[var(--color-danger)]">
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
                          className={`inline-flex h-7 items-center gap-1 rounded-full border px-2.5 transition-colors ${
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
                    {!disabled && onSplit && !gone && (
                      <button
                        type="button"
                        onClick={() => onSplit(i)}
                        disabled={splitting !== null}
                        title="Create a separate single-item draft for this variation"
                        className={`btn btn-sm mr-1 !h-7 !px-2.5 !text-[12px] ${variationsSupported === false ? "btn-accent" : "btn-secondary"}`}
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
          title={`Photo for ${axes.map((axis) => showValue(axis, variants[pickerFor].aspects[axis]?.[0] || "")).filter(Boolean).join(" · ") || `variation ${pickerFor + 1}`}`}
          images={allImages}
          current={imageOverrides[pickerFor] ?? variants[pickerFor].imageUrls[0] ?? null}
          onPick={(url) => {
            onImageChange(pickerFor, url);
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

function AiPanel({
  scope,
  onScopeChange,
  imageLabel,
  onProposeText,
  onProposeImage,
  textProposal,
  imageProposal,
  onAcceptText,
  onAcceptImage,
  onDiscard,
  busy,
  currentImageUrl,
  currentTitle,
  currentDescription,
}: {
  scope: "text" | "image";
  onScopeChange: (s: "text" | "image") => void;
  imageLabel: string;
  onProposeText: (instruction: string) => void;
  onProposeImage: (instruction: string) => void;
  textProposal: TextProposal | null;
  imageProposal: ImageProposal | null;
  onAcceptText: () => void;
  onAcceptImage: () => void;
  onDiscard: () => void;
  busy: boolean;
  currentImageUrl: string | null;
  currentTitle: string;
  currentDescription: string;
}) {
  const [instruction, setInstruction] = useState("");
  const proposal = scope === "text" ? textProposal : imageProposal;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!instruction.trim()) return;
    if (scope === "text") onProposeText(instruction.trim());
    else onProposeImage(instruction.trim());
  }

  const chip = (value: "text" | "image", label: string) => (
    <button
      type="button"
      onClick={() => onScopeChange(value)}
      className={`chip ${scope === value ? "chip-primary" : ""}`}
    >
      {label}
    </button>
  );

  return (
    <div className={cardClass}>
      <h3 className={cardTitleClass}>Ask AI to change something</h3>
      <p className="mt-1 text-xs text-[var(--color-muted)] leading-relaxed">
        Describe the change in your own words. You&apos;ll see the result next to what you have now, and nothing
        changes until you accept it.
      </p>
      <div className="mt-3 flex gap-2">
        {chip("text", "Title & description")}
        {chip("image", imageLabel)}
      </div>
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <input
          className={inputClass}
          placeholder={
            scope === "text"
              ? 'e.g. "make the description shorter" or "mention it fits in a pocket"'
              : 'e.g. "add the heading BUY 2 GET 1 FREE" or "add the UK flag badge"'
          }
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !instruction.trim()}
          className="btn btn-primary flex-shrink-0"
        >
          {busy ? "Working…" : "Propose"}
        </button>
      </form>

      {proposal && (
        <div className="mt-4 rounded-xl border border-[var(--color-primary)]/30 bg-[var(--color-primary-soft)]/60 p-4">
          <p className="label text-[var(--color-primary)]">Proposed change</p>
          <p className="mt-1 text-sm text-[var(--color-ink)]">{proposal.summary}</p>

          {scope === "image" && imageProposal && (
            <>
              {imageProposal.policyWarning && (
                <div className="mt-3">
                  <Alert>{imageProposal.policyWarning}</Alert>
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <p className="mb-1 text-xs text-[var(--color-muted)]">Now</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {currentImageUrl && <img src={currentImageUrl} alt="" className="aspect-square w-full rounded-lg border border-[var(--color-line)] object-contain bg-white" />}
                </div>
                <div>
                  <p className="mb-1 text-xs text-[var(--color-muted)]">Proposed</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageProposal.previewDataUrl} alt="" className="aspect-square w-full rounded-lg border border-[var(--color-accent)] object-contain bg-white" />
                </div>
              </div>
            </>
          )}

          {scope === "text" && textProposal && (
            <div className="mt-3 space-y-3 text-sm">
              {(textProposal.changes.title ?? textProposal.changes.commonTitle) !== undefined && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="mb-1 text-xs text-[var(--color-muted)]">Title now</p>
                    <p className="rounded-lg border border-[var(--color-line)] bg-white p-2 text-[var(--color-ink)]">{currentTitle}</p>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-[var(--color-muted)]">Proposed</p>
                    <p className="rounded-lg border border-[var(--color-accent)] bg-white p-2 text-[var(--color-ink)]">
                      {textProposal.changes.title ?? textProposal.changes.commonTitle}
                    </p>
                  </div>
                </div>
              )}
              {(textProposal.changes.description ?? textProposal.changes.commonDescription) !== undefined && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="mb-1 text-xs text-[var(--color-muted)]">Description now</p>
                    <p className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--color-line)] bg-white p-2 text-[var(--color-ink)]">{currentDescription}</p>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-[var(--color-muted)]">Proposed</p>
                    <p className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--color-accent)] bg-white p-2 text-[var(--color-ink)]">
                      {textProposal.changes.description ?? textProposal.changes.commonDescription}
                    </p>
                  </div>
                </div>
              )}
              {textProposal.changes.aspects && (
                <p className="text-xs text-[var(--color-muted)]">
                  Also updates item specifics: {Object.keys(textProposal.changes.aspects).join(", ")}
                </p>
              )}
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={scope === "text" ? onAcceptText : onAcceptImage}
              disabled={busy}
              className="btn btn-primary"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={onDiscard}
              disabled={busy}
              className="btn btn-secondary"
            >
              Discard
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

  const [listing, setListing] = useState<DraftListing | null>(null);
  const [policies, setPolicies] = useState<ConnectionPolicies | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Local, unsaved edits. Everything below is diffed against `listing` to
  // build the PATCH on save, so Discard is just clearing this state.
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  // Item specifics as an ordered list so rows can be renamed, added and
  // removed in place. Multi-value aspects are edited as "a, b".
  const [specifics, setSpecifics] = useState<{ name: string; value: string }[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [selectedImage, setSelectedImage] = useState(0);
  const [removedRows, setRemovedRows] = useState<Set<number>>(new Set());
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [refitting, setRefitting] = useState(false);
  const [showOptionalSpecifics, setShowOptionalSpecifics] = useState(false);
  const [splitting, setSplitting] = useState<number | null>(null);
  const [splitDone, setSplitDone] = useState<{ id: string; title: string }[]>([]);
  const [imageCheck, setImageCheck] = useState<ImageCheck | null>(null);
  const [uploading, setUploading] = useState(false);

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [published, setPublished] = useState<DraftListing | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    setEditingDescription(false);
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

  useEffect(() => {
    api
      .getDraftListing(params.offerId)
      .then((data) => {
        setListing(data.listing);
        setPolicies(data.policies);
        categoryInfoRef.current = data.category;
        setCategoryInfo(data.category);
        resetFrom(data.listing);
        loadSecondaryPath((data.listing.generated_data as DraftContent).secondaryCategoryId);
        loadDescriptionPreview(data.listing.id);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this draft."))
      .finally(() => setLoading(false));
  }, [params.offerId, resetFrom, loadDescriptionPreview, loadSecondaryPath]);

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

  const policiesChanged =
    !!content?.listingPolicies &&
    (policyIds.fulfillmentPolicyId !== content.listingPolicies.fulfillmentPolicyId ||
      policyIds.paymentPolicyId !== content.listingPolicies.paymentPolicyId ||
      policyIds.returnPolicyId !== content.listingPolicies.returnPolicyId);

  const dirty = useMemo(() => {
    if (!content) return false;
    const origTitle = variation ? variation.commonTitle : single!.title;
    const origDesc = variation ? variation.commonDescription : single!.description;
    return (
      title !== origTitle ||
      description !== origDesc ||
      aspectsChanged ||
      condition !== ((variation ? variation.variants[0]?.condition : single!.condition) || "NEW") ||
      (single ? singlePrice !== single.price.value || singleQuantity !== String(single.quantity ?? 1) : false) ||
      policiesChanged ||
      JSON.stringify(images) !== JSON.stringify(content.imageUrls) ||
      removedRows.size > 0 ||
      removedAxisValues.length > 0 ||
      Object.keys(priceOverrides).length > 0 ||
      Object.keys(quantityOverrides).length > 0 ||
      Object.keys(imageOverrides).length > 0 ||
      Object.keys(valueRenames).length > 0 ||
      Object.keys(axisRenames).length > 0 ||
      addedValues.length > 0 ||
      sku !== (content.sku || "") ||
      (secondaryCategoryId || null) !== (content.secondaryCategoryId || null) ||
      JSON.stringify(storeCategoryNames) !== JSON.stringify(content.storeCategoryNames || [])
    );
  }, [content, variation, single, title, description, aspectsChanged, condition, singlePrice, singleQuantity, policiesChanged, images, removedRows, removedAxisValues, priceOverrides, quantityOverrides, imageOverrides, valueRenames, axisRenames, addedValues, sku, secondaryCategoryId, storeCategoryNames]);

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
      loadDescriptionPreview(detail.listing.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change the category. Try again.");
    } finally {
      setRefitting(false);
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

  async function handleSave() {
    if (!listing) return;
    setSaving(true);
    setError(null);
    try {
      const data = await api.updateDraftListing(listing.id, buildPatch());
      setListing(data.listing);
      setImageCheck(data.imageCheck);
      resetFrom(data.listing);
      loadDescriptionPreview(data.listing.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save your changes. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    if (!listing) return;
    setConfirmPublish(false);
    setPublishing(true);
    setError(null);
    try {
      // Editing a live listing is one step: unsaved changes go up with it.
      if (isLiveEdit && dirty) {
        const saved = await api.updateDraftListing(listing.id, buildPatch());
        setListing(saved.listing);
        resetFrom(saved.listing);
      }
      const data = await api.publishDraftListing(listing.id);
      if (isLiveEdit) {
        router.push(`/accounts/${params.id}/listings?updated=${listing.edit_of_item_id}`);
        return;
      }
      setListing(data.listing);
      setPublished(data.listing);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't publish this listing. Try again.");
    } finally {
      setPublishing(false);
    }
  }

  async function handleDelete() {
    if (!listing) return;
    setDeleting(true);
    try {
      await api.deleteDraftListing(listing.id);
      router.push(`/accounts/${params.id}/listings${isLiveEdit ? "" : "?filter=draft"}`);
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
    setImages((imgs) => [imgs[index], ...imgs.filter((_, i) => i !== index)]);
    setSelectedImage(0);
  }
  function deleteImage(index: number) {
    setImages((imgs) => imgs.filter((_, i) => i !== index));
    setSelectedImage((s) => Math.max(0, Math.min(s, images.length - 2)));
  }

  // --- AI ---
  async function proposeText(instruction: string) {
    if (!listing) return;
    setAiBusy(true);
    setError(null);
    try {
      setTextProposal(await api.reviseDraftText(listing.id, instruction));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The AI couldn't make that change.");
    } finally {
      setAiBusy(false);
    }
  }
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
  function acceptText() {
    if (!textProposal) return;
    const c = textProposal.changes;
    const newTitle = c.title ?? c.commonTitle;
    const newDesc = c.description ?? c.commonDescription;
    if (newTitle !== undefined) setTitle(newTitle);
    if (newDesc !== undefined) setDescription(newDesc);
    if (c.aspects) {
      setSpecifics((rows) => {
        const next = [...rows];
        for (const [name, values] of Object.entries(c.aspects!)) {
          const i = next.findIndex((r) => r.name === name);
          const row = { name, value: values.join(", ") };
          if (i >= 0) next[i] = row;
          else next.push(row);
        }
        return next;
      });
    }
    setTextProposal(null);
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
    return (
      <main className="flex h-screen items-center justify-center">
        <p className="text-sm text-[var(--color-muted)]">Loading…</p>
      </main>
    );
  }

  if (!listing || !content) {
    return (
      <main className="flex h-screen items-center justify-center px-6">
        <Alert>{error || "This draft doesn't exist, or isn't yours."}</Alert>
      </main>
    );
  }

  const busy = saving || publishing || deleting || aiBusy || refitting || splitting !== null;
  const canPublish = editable && !dirty && !busy;
  const conditionLabel = CONDITIONS.find((c) => c.value === condition)?.label || condition;
  const notes = content.warnings || [];

  return (
    <main className="flex h-screen flex-col bg-[var(--color-paper)]">
      <EditorHeader
        backHref={`/accounts/${params.id}/listings${isLiveEdit ? "" : "?filter=draft"}`}
        backLabel={isLiveEdit ? "Back to listings" : "Back to drafts"}
        title={isLiveEdit ? "Edit live listing" : editable ? "Edit listing" : "Listing"}
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
            <span className="chip font-medium" title="eBay item number">
              Live · #{listing.edit_of_item_id}
            </span>
          ) : editable ? (
            <>
              <span className="mr-1 hidden text-xs text-[var(--color-muted)] md:inline">{dirty ? "Unsaved changes" : "All changes saved"}</span>
              {dirty && (
                <button type="button" onClick={() => resetFrom(listing)} disabled={busy} className="btn btn-ghost btn-sm">
                  Discard
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={!dirty || busy || title.length > TITLE_MAX}
                title={title.length > TITLE_MAX ? "Shorten the title first" : undefined}
                className="btn btn-primary btn-sm"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-6">
          {(error || (listing.error_message && listing.status === "pending_review") || (imageCheck && !imageCheck.ok) || listing.status === "published") && (
            <div className="mb-4 space-y-2">
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
            <div className="mb-4 rounded-2xl border border-amber-200 bg-[var(--color-warning-soft)] px-4 py-3">
              <div className="flex items-baseline justify-between">
                <p className="text-[11px] font-bold uppercase tracking-wider text-amber-800">Drafting notes</p>
                <button type="button" onClick={() => setShowNotes(false)} className="text-xs text-amber-800 hover:underline">
                  Hide
                </button>
              </div>
              <ul className="mt-1.5 space-y-0.5">
                {notes.map((w) => (
                  <li key={w} className="text-[13px] leading-relaxed text-amber-900">
                    • {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            {/* ---- Left: photos + AI ---- */}
            <div className="space-y-6">
              <GalleryGrid
                images={images}
                selected={selectedImage}
                onSelect={setSelectedImage}
                onSetMain={setMain}
                onDelete={deleteImage}
                onUpload={(files) => uploadFiles(files)}
                onReplace={(i, file) => uploadFiles([file], { replaces: images[i] })}
                onDownload={downloadImage}
                onDownloadAll={downloadAll}
                onEditWithAi={(i) => {
                  setSelectedImage(i);
                  setAiScope("image");
                }}
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
                  imageProposal={imageProposal}
                  onAcceptText={acceptText}
                  onAcceptImage={acceptImage}
                  onDiscard={() => {
                    setTextProposal(null);
                    setImageProposal(null);
                  }}
                  busy={aiBusy}
                  currentImageUrl={imageProposalTarget}
                  currentTitle={title}
                  currentDescription={description}
                />
              )}
            </div>

            {/* ---- Right: details ---- */}
            <div className="space-y-6">
              <div className={cardClass}>
                <h3 className={cardTitleClass}>Listing details</h3>

                <div className="mt-4">
                  <div className="flex items-baseline justify-between">
                    <label className={labelClass}>Title</label>
                    <span className={`text-xs ${title.length > TITLE_MAX ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}>
                      {title.length} / {TITLE_MAX}
                    </span>
                  </div>
                  <input
                    className={`${inputClass} mt-1.5 font-semibold ${title.length > TITLE_MAX ? "!border-[var(--color-danger)]" : ""}`}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={!editable || busy}
                  />
                  {title.length > TITLE_MAX && (
                    <p className="mt-1.5 text-xs font-semibold text-[var(--color-danger)]">
                      {title.length - TITLE_MAX} characters over eBay&apos;s 80-character limit. Shorten it to save.
                    </p>
                  )}
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className={labelClass}>Category</p>
                      {editable && (
                        <button type="button" onClick={() => setPickerOpen(true)} disabled={busy} className={smallButton}>
                          {refitting ? "Refitting…" : "Change"}
                        </button>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm text-[var(--color-ink)]">
                      {content.categoryPath?.length ? content.categoryPath.join(" › ") : `Category ${content.categoryId}`}
                    </p>
                    <p className="text-xs text-[var(--color-muted)]">
                      eBay category {content.categoryId}
                      {secondaryCategoryId ? ` · also in ${secondaryCategoryPath.join(" › ") || secondaryCategoryId}` : ""}
                      {storeCategoryNames.length ? ` · Shop: ${storeCategoryNames.map((n) => n.replace(/^\//, "").replace(/\//g, " › ")).join(", ")}` : ""}
                    </p>
                    {refitting && (
                      <p className="mt-2 text-xs font-semibold text-[var(--color-primary)]">
                        Refitting the title, item specifics and description to the new category…
                      </p>
                    )}
                    {variation && categoryInfo?.variationsSupported === false && (
                      <div className="mt-2 rounded-xl border border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-ink)]">
                        <p>
                          eBay doesn&apos;t allow multi-variation listings in this category. Change the category, or list each variation
                          separately from the variations table below.
                        </p>
                      </div>
                    )}
                    {editable && (content.categorySuggestions || []).some((sg) => sg.id !== content.categoryId) && (
                      <div className="mt-2">
                        <p className="text-xs text-[var(--color-muted)]">eBay also suggests:</p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {(content.categorySuggestions || [])
                            .filter((sg) => sg.id !== content.categoryId)
                            .slice(0, 3)
                            .map((sg) => (
                              <button
                                key={sg.id}
                                type="button"
                                disabled={busy}
                                title={sg.path.join(" › ")}
                                onClick={() =>
                                  applyCategory({
                                    categoryId: sg.id,
                                    categoryPath: sg.path,
                                    secondaryCategoryId,
                                    secondaryCategoryPath,
                                    storeCategoryNames,
                                  })
                                }
                                className="chip hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] disabled:opacity-50"
                              >
                                {sg.name}
                              </button>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="sm:col-span-3">
                    <label className={labelClass}>SKU (custom label)</label>
                    <input
                      className={`${inputClass} mt-1.5 font-mono text-[13px]`}
                      value={sku}
                      maxLength={50}
                      placeholder="e.g. Liston-1005006"
                      onChange={(e) => setSku(e.target.value)}
                      disabled={!editable || busy}
                    />
                    {variation && sku.trim() && (
                      <p className="mt-1 text-xs text-[var(--color-muted)]">Variations publish as {sku.trim()}-1, {sku.trim()}-2, …</p>
                    )}
                  </div>
                  <div>
                    <label className={labelClass}>Condition</label>
                    {editable ? (
                      <select className={`${inputClass} mt-1.5`} value={condition} onChange={(e) => setCondition(e.target.value)} disabled={busy}>
                        {CONDITIONS.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="mt-1.5 text-sm text-[var(--color-ink)]">{conditionLabel}</p>
                    )}
                  </div>
                  {single ? (
                    <>
                      <div>
                        <label className={labelClass}>Price ({currencySymbol(single.price.currency)})</label>
                        <input type="number" step="0.01" min="0" className={`${inputClass} mt-1.5`} value={singlePrice} onChange={(e) => setSinglePrice(e.target.value)} disabled={!editable || busy} />
                      </div>
                      <div>
                        <label className={labelClass}>Quantity</label>
                        <input type="number" step="1" min="0" className={`${inputClass} mt-1.5`} value={singleQuantity} onChange={(e) => setSingleQuantity(e.target.value)} disabled={!editable || busy} />
                      </div>
                    </>
                  ) : (
                    <div className="sm:col-span-2">
                      <p className={labelClass}>Pricing</p>
                      <p className="mt-1.5 text-sm text-[var(--color-ink)]">Per variation, edit in the table below.</p>
                    </div>
                  )}
                </div>

                {single?.priceBreakdown && (
                  <details className="mt-3 rounded-2xl border border-[var(--color-line)]">
                    <summary className="cursor-pointer px-4 py-2 text-xs font-semibold text-[var(--color-ink)]">
                      How this price was worked out · {single.priceBreakdown.roiPercent.toFixed(0)}% ROI
                    </summary>
                    <div className="border-t border-[var(--color-line)] p-3">
                      <PriceBreakdownPanel breakdown={single.priceBreakdown} />
                    </div>
                  </details>
                )}

                {content.listingPolicies && (
                  <div className="mt-4">
                    <div className="flex items-baseline justify-between">
                      <p className={labelClass}>Business policies</p>
                      <span className="text-xs text-[var(--color-muted)]">Defaults come from Settings; change them for this listing only.</span>
                    </div>
                    <div className="mt-2 grid gap-3 sm:grid-cols-3">
                      {(
                        [
                          ["fulfillmentPolicyId", "Postage", policies?.fulfillmentPolicies || []],
                          ["paymentPolicyId", "Payment", policies?.paymentPolicies || []],
                          ["returnPolicyId", "Returns", policies?.returnPolicies || []],
                        ] as const
                      ).map(([key, label, list]) => (
                        <div key={key}>
                          <label className="text-xs font-semibold text-[var(--color-muted)]">{label}</label>
                          {editable && list.length > 0 ? (
                            <select
                              className="input input-sm mt-1"
                              value={policyIds[key]}
                              onChange={(e) => setPolicyIds((p) => ({ ...p, [key]: e.target.value }))}
                              disabled={busy}
                            >
                              {!list.some((p) => p[key] === policyIds[key]) && policyIds[key] && (
                                <option value={policyIds[key]}>{policyIds[key]} (no longer on account)</option>
                              )}
                              {list.map((p) => (
                                <option key={p[key]} value={p[key]}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <p className="mt-1 truncate text-sm text-[var(--color-ink)]" title={policyName(policies, key, policyIds[key])}>
                              {policyName(policies, key, policyIds[key])}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
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
                    <button type="button" onClick={() => setSpecifics((rows) => [...rows, { name: "", value: "" }])} disabled={busy} className="btn btn-secondary btn-sm">
                      + Add
                    </button>
                  )}
                </div>
                {specifics.length === 0 ? (
                  <p className="mt-3 text-sm text-[var(--color-muted)]">No item specifics yet.</p>
                ) : (
                  <div className="mt-3 grid gap-x-6 md:grid-cols-2">
                    {specifics.map((row, i) => {
                      const entry = schemaByName.get(row.name.trim().toLowerCase());
                      const unfilled = !row.value.trim();
                      const optionalHidden = unfilled && !entry?.required && !showOptionalSpecifics;
                      if (optionalHidden) return null;
                      const listId = entry?.allowedValues.length ? `aspect-values-${i}` : undefined;
                      return (
                      <div key={i} className="flex items-center gap-1 border-b border-[var(--color-line)] py-0.5 text-[13px]">
                        <input
                          className="h-7 w-[42%] min-w-0 rounded-full border border-transparent bg-transparent px-2 text-[var(--color-muted)] hover:border-[var(--color-line)] focus:border-[var(--color-primary)] focus:outline-none disabled:opacity-100"
                          value={row.name}
                          placeholder="Name"
                          onChange={(e) => setSpecifics((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                          disabled={!editable || busy}
                        />
                        {entry?.required && unfilled && (
                          <span className="shrink-0 rounded-full bg-[var(--color-danger-soft)] px-1.5 text-[10px] font-bold uppercase tracking-wide text-[var(--color-danger)]">
                            Required
                          </span>
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
                    <button type="button" onClick={() => setShowOptionalSpecifics((v) => !v)} className="mt-3 text-xs font-semibold text-[var(--color-primary)] hover:underline">
                      {showOptionalSpecifics ? "Hide empty optional specifics" : `Show ${hiddenCount} more optional specific${hiddenCount === 1 ? "" : "s"} eBay lists for this category`}
                    </button>
                  );
                })()}
              </div>

              {/* Description */}
              <div className={cardClass}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className={cardTitleClass}>Description</h3>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-[var(--color-muted)]">
                      {loadingPreview ? "Building preview…" : dirty ? "Save to refresh the preview" : "As it will appear on eBay"}
                    </span>
                    {editable && (
                      <button type="button" onClick={() => setEditingDescription((v) => !v)} className={smallButton}>
                        {editingDescription ? "Hide text editor" : "Edit text"}
                      </button>
                    )}
                  </div>
                </div>
                {editingDescription && (
                  <>
                    <FormatToolbar textarea={descriptionRef} value={description} onChange={setDescription} disabled={!editable || busy} />
                    <textarea
                      ref={descriptionRef}
                      className={`${inputClass} mt-2 min-h-[14rem] leading-relaxed`}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      disabled={!editable || busy}
                    />
                  </>
                )}
                {descriptionPreview !== null ? (
                  <iframe
                    title="Description preview"
                    sandbox=""
                    srcDoc={`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;padding:16px;background:#f3f3f3">${descriptionPreview}</body>`}
                    className={`mt-3 h-[48rem] w-full rounded-xl border border-[var(--color-line)] bg-white ${dirty ? "opacity-60" : ""}`}
                  />
                ) : (
                  <div className="mt-3 h-[48rem] w-full animate-pulse rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)]" />
                )}
              </div>
            </div>
          </div>

          {/* ---- Full width: variations ---- */}
          {variation && (
            <div className="mt-6">
              <VariationsTable
                variants={variation.variants}
                specifications={variation.variesBy.specifications}
                galleryImages={images}
                removedIndexes={removedRows}
                removedAxisValues={removedAxisValues}
                priceOverrides={priceOverrides}
                quantityOverrides={quantityOverrides}
                imageOverrides={imageOverrides}
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
                onImageChange={(i, url) => setImageOverrides((p) => ({ ...p, [i]: url }))}
                onUploadImage={(i, file) => uploadFiles([file], { variantIndex: i })}
                valueRenames={valueRenames}
                axisRenames={axisRenames}
                onRenameValue={(axis, from, to) => setValueRenames((r) => ({ ...r, [axis]: { ...(r[axis] || {}), [from]: to } }))}
                onRenameAxis={(from, to) => setAxisRenames((r) => ({ ...r, [from]: to }))}
                addedValues={addedValues}
                onAddValue={(axis, value, copyFrom) => setAddedValues((list) => [...list, { axis, value, copyFrom }])}
                onUndoAddValue={(axis, value) => setAddedValues((list) => list.filter((a) => !(a.axis === axis && a.value === value)))}
                variationsSupported={categoryInfo?.variationsSupported ?? null}
                onSplit={editable ? handleSplit : undefined}
                splitting={splitting}
                splitDone={splitDone}
                accountId={params.id}
                onApplyAll={applyToAllVariants}
                disabled={!editable || busy}
              />
            </div>
          )}
          <div className="h-6" />
        </div>
      </div>

      {editable && (
        <footer className="z-40 flex-shrink-0 border-t border-[var(--color-line)] bg-[var(--color-panel)]">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
            <button type="button" onClick={() => setConfirmDelete(true)} disabled={busy} className="btn btn-danger-ghost">
              {Icon.trash}
              <span>{isLiveEdit ? "Discard changes" : "Delete draft"}</span>
            </button>
            <div className="flex items-center gap-3">
              {isLiveEdit ? (
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
                  {dirty && <span className="text-xs text-[var(--color-muted)]">Save your changes to publish</span>}
                  <button
                    type="button"
                    onClick={() => setConfirmPublish(true)}
                    disabled={!canPublish}
                    title={dirty ? "Save your changes first" : undefined}
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
      <ConfirmDialog
        open={confirmPublish}
        title={isLiveEdit ? "Publish these changes?" : "Publish this listing?"}
        description={
          isLiveEdit
            ? "The live eBay listing is updated in place. Buyers see the new title, photos, price, stock and description straight away."
            : `It goes live on eBay immediately${variation ? `, with ${variation.variants.length} variations` : ""}. Publishing creates the listing on eBay now, so this can take a minute or two for large variation sets.`
        }
        confirmLabel={isLiveEdit ? "Publish changes" : "Publish"}
        loading={publishing}
        onCancel={() => setConfirmPublish(false)}
        onConfirm={handlePublish}
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
