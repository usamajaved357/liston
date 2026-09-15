"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  api,
  ApiError,
  ConnectionPolicies,
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
import { BackHeader } from "@/components/BackHeader";
import { ConfirmDialog } from "@/components/ConfirmDialog";

// The draft editor. A draft lives only in Liston until Publish, so every
// change here is a local edit saved with one PATCH — nothing touches eBay
// until the seller decides to go live. AI revisions are proposals: they're
// shown beside the current version and change nothing until accepted.

const inputClass =
  "w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-ink)]";
const labelClass = "text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]";
const TITLE_MAX = 80;

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
        <span className="text-xl font-extrabold text-[var(--color-ink)]">
          {breakdown.currency} {breakdown.sellPrice.toFixed(2)}
        </span>
      </div>
      <div className="mt-3 space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between text-sm text-[var(--color-muted)]">
            <span>{row.label}</span>
            <span>
              −{breakdown.currency} {row.value.toFixed(2)}
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
        {breakdown.roiPercent.toFixed(0)}% ROI {hitTarget ? "— at or above" : "— BELOW"} your{" "}
        {breakdown.targetRoiPercent}% target
      </p>
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
  return list.find((p) => p[kind] === id)?.name || id;
}

// --- Carousel ---------------------------------------------------------------

function ImageCarousel({
  images,
  selected,
  onSelect,
  onSetMain,
  onDelete,
  onEditWithAi,
  disabled,
}: {
  images: string[];
  selected: number;
  onSelect: (index: number) => void;
  onSetMain: (index: number) => void;
  onDelete: (index: number) => void;
  onEditWithAi: (index: number) => void;
  disabled: boolean;
}) {
  const count = images.length;
  const prev = useCallback(() => onSelect((selected - 1 + count) % count), [selected, count, onSelect]);
  const next = useCallback(() => onSelect((selected + 1) % count), [selected, count, onSelect]);

  // Arrow keys move through the gallery, unless the seller is typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next]);

  if (!count) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-2xl border border-dashed border-[var(--color-line)]">
        <p className="text-sm text-[var(--color-muted)]">No images — eBay needs at least one.</p>
      </div>
    );
  }

  const arrowClass =
    "absolute top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-white/90 shadow flex items-center justify-center text-[var(--color-ink)] hover:bg-white transition-colors";

  return (
    <div>
      <div className="relative aspect-square overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-paper)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={images[selected]} alt="" className="h-full w-full object-contain" />
        {selected === 0 && (
          <span className="absolute left-3 top-3 rounded-full bg-[var(--color-primary)] px-2.5 py-1 text-xs font-bold text-white">
            Main image
          </span>
        )}
        <span className="absolute right-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white">
          {selected + 1} / {count}
        </span>
        {count > 1 && (
          <>
            <button type="button" onClick={prev} aria-label="Previous image" className={`${arrowClass} left-3`}>
              ‹
            </button>
            <button type="button" onClick={next} aria-label="Next image" className={`${arrowClass} right-3`}>
              ›
            </button>
          </>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSetMain(selected)}
          disabled={disabled || selected === 0}
          className="rounded-md border border-[var(--color-line)] px-3 py-1.5 text-xs font-semibold text-[var(--color-ink)] hover:border-[var(--color-accent)]/50 disabled:opacity-40"
        >
          Set as main
        </button>
        <button
          type="button"
          onClick={() => onEditWithAi(selected)}
          disabled={disabled}
          className="rounded-md border border-[var(--color-line)] px-3 py-1.5 text-xs font-semibold text-[var(--color-ink)] hover:border-[var(--color-accent)]/50 disabled:opacity-40"
        >
          Edit with AI
        </button>
        <button
          type="button"
          onClick={() => onDelete(selected)}
          disabled={disabled || count === 1}
          title={count === 1 ? "A listing needs at least one image" : undefined}
          className="ml-auto text-xs font-semibold text-[var(--color-danger)] hover:underline disabled:opacity-40"
        >
          Delete image
        </button>
      </div>

      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {images.map((url, i) => (
          <button
            key={`${url}-${i}`}
            type="button"
            onClick={() => onSelect(i)}
            className={`relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border-2 ${
              i === selected ? "border-[var(--color-primary)]" : "border-[var(--color-line)]"
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="h-full w-full object-cover" />
            {i === 0 && <span className="absolute bottom-0 left-0 right-0 bg-[var(--color-primary)] text-[9px] font-bold text-white">MAIN</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Variations ------------------------------------------------------------

type AxisRemoval = { axis: string; value: string };

function VariationsEditor({
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
  disabled,
}: {
  variants: VariationDraftVariant[];
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
  disabled: boolean;
}) {
  const axisRemoved = (axis: string, value: string) => removedAxisValues.some((r) => r.axis === axis && r.value === value);
  const isRowGone = (variant: VariationDraftVariant, index: number) =>
    removedIndexes.has(index) ||
    Object.entries(variant.aspects).some(([axis, values]) => axisRemoved(axis, values[0]));

  const remaining = variants.filter((v, i) => !isRowGone(v, i)).length;

  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between">
        <h3 className={labelClass}>Variations</h3>
        <span className="text-xs text-[var(--color-muted)]">
          {remaining} of {variants.length} will be listed
        </span>
      </div>

      {/* One chip per option value. Removing a chip drops every combination
          using it — dropping "Pink" on a 6-colour x 27-model product removes
          27 rows at once, which is the only practical way to curate a matrix
          that size. */}
      <div className="mt-3 space-y-2">
        {specifications.map((spec) => (
          <div key={spec.name} className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs font-semibold text-[var(--color-muted)]">{spec.name}:</span>
            {spec.values.map((value) => {
              const gone = axisRemoved(spec.name, value);
              const count = variants.filter((v) => v.aspects[spec.name]?.[0] === value).length;
              return (
                <button
                  key={value}
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    gone ? onRestoreAxisValue({ axis: spec.name, value }) : onRemoveAxisValue({ axis: spec.name, value })
                  }
                  title={gone ? "Click to restore" : `Remove all ${count} variation${count === 1 ? "" : "s"} with this ${spec.name.toLowerCase()}`}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                    gone
                      ? "border-dashed border-[var(--color-line)] text-[var(--color-muted)] line-through"
                      : "border-[var(--color-line)] text-[var(--color-ink)] hover:border-[var(--color-danger)]/60"
                  }`}
                >
                  {value}
                  <span className="text-[var(--color-muted)]">{gone ? "↺" : "×"}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-3 max-h-[28rem] overflow-y-auto rounded-lg border border-[var(--color-line)]">
        {variants.map((v, i) => {
          const gone = isRowGone(v, i);
          const rowRemovedDirectly = removedIndexes.has(i);
          const image = imageOverrides[i] ?? v.imageUrls[0];
          return (
            <div
              key={i}
              className={`flex items-center gap-3 border-b border-[var(--color-line)] px-3 py-2 last:border-b-0 ${
                gone ? "bg-[var(--color-paper)] opacity-50" : ""
              }`}
            >
              <select
                value={image || ""}
                disabled={disabled || gone}
                onChange={(e) => onImageChange(i, e.target.value)}
                title="Which photo shows for this variation"
                className="h-10 w-10 flex-shrink-0 cursor-pointer appearance-none rounded-md border border-[var(--color-line)] bg-cover bg-center text-transparent"
                style={{ backgroundImage: image ? `url(${image})` : undefined }}
              >
                {galleryImages.map((url, gi) => (
                  <option key={url} value={url} className="text-[var(--color-ink)]">
                    Image {gi + 1}{gi === 0 ? " (main)" : ""}
                  </option>
                ))}
                {image && !galleryImages.includes(image) && (
                  <option value={image} className="text-[var(--color-ink)]">
                    Own photo
                  </option>
                )}
              </select>
              <div className={`min-w-0 flex-1 text-sm text-[var(--color-ink)] ${gone ? "line-through" : ""}`}>
                {Object.entries(v.aspects)
                  .map(([name, values]) => `${name}: ${values.join(", ")}`)
                  .join(" · ")}
              </div>
              <div className="flex flex-shrink-0 items-center gap-1 text-sm">
                <span className="text-[var(--color-muted)]">{v.price.currency}</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={priceOverrides[i] ?? v.price.value}
                  disabled={disabled || gone}
                  onChange={(e) => onPriceChange(i, e.target.value)}
                  className="w-20 rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-1 text-right text-sm text-[var(--color-ink)]"
                />
              </div>
              <div className="flex flex-shrink-0 items-center gap-1 text-sm" title="Quantity">
                <span className="text-xs text-[var(--color-muted)]">Qty</span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={quantityOverrides[i] ?? String(v.quantity)}
                  disabled={disabled || gone}
                  onChange={(e) => onQuantityChange(i, e.target.value)}
                  className="w-14 rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] px-2 py-1 text-right text-sm text-[var(--color-ink)]"
                />
              </div>
              {v.priceBreakdown && !gone && (
                <span
                  className={`w-16 flex-shrink-0 text-right text-xs ${
                    v.priceBreakdown.roiPercent >= v.priceBreakdown.targetRoiPercent ? "text-emerald-700" : "text-[var(--color-danger)]"
                  }`}
                >
                  {v.priceBreakdown.roiPercent.toFixed(0)}% ROI
                </span>
              )}
              <button
                type="button"
                disabled={disabled}
                onClick={() => (rowRemovedDirectly ? onRestoreRow(i) : onRemoveRow(i))}
                className="w-14 flex-shrink-0 text-right text-xs font-semibold text-[var(--color-danger)] hover:underline disabled:opacity-40"
              >
                {rowRemovedDirectly ? "Restore" : gone ? "" : "Remove"}
              </button>
            </div>
          );
        })}
      </div>
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
      className={`rounded-full border px-3 py-1 text-xs font-semibold ${
        scope === value
          ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
          : "border-[var(--color-line)] text-[var(--color-muted)]"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
      <h3 className="text-sm font-bold text-[var(--color-ink)]">Ask AI to change something</h3>
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
              : 'e.g. "put it on a wooden desk" or "add the heading BUY 2 GET 1 FREE"'
          }
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !instruction.trim()}
          className="flex-shrink-0 rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
        >
          {busy ? "Working…" : "Propose"}
        </button>
      </form>

      {proposal && (
        <div className="mt-4 rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-paper)] p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-accent)]">Proposed change</p>
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
              className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={onDiscard}
              disabled={busy}
              className="rounded-md border border-[var(--color-line)] px-4 py-2 text-sm font-medium text-[var(--color-ink)] disabled:opacity-40"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Page ------------------------------------------------------------------

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
  // Item specifics as an ordered list so rows can be renamed, added and
  // removed in place. Multi-value aspects are edited as "a, b".
  const [specifics, setSpecifics] = useState<{ name: string; value: string }[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [selectedImage, setSelectedImage] = useState(0);
  const [removedRows, setRemovedRows] = useState<Set<number>>(new Set());
  const [removedAxisValues, setRemovedAxisValues] = useState<AxisRemoval[]>([]);
  const [priceOverrides, setPriceOverrides] = useState<Record<number, string>>({});
  const [quantityOverrides, setQuantityOverrides] = useState<Record<number, string>>({});
  const [condition, setCondition] = useState("NEW");
  const [singlePrice, setSinglePrice] = useState("");
  const [singleQuantity, setSingleQuantity] = useState("1");
  const [showNotes, setShowNotes] = useState(false);
  const [imageOverrides, setImageOverrides] = useState<Record<number, string>>({});
  const [imageCheck, setImageCheck] = useState<ImageCheck | null>(null);

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
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

  const resetFrom = useCallback((row: DraftListing) => {
    const c = row.generated_data as DraftContent;
    setTitle(isVariationDraft(c) ? c.commonTitle : c.title);
    setDescription(isVariationDraft(c) ? c.commonDescription : c.description);
    setEditingDescription(false);
    const aspects = isVariationDraft(c) ? c.variesBy.aspects : c.aspects;
    setSpecifics(Object.entries(aspects || {}).map(([name, values]) => ({ name, value: values.join(", ") })));
    setImages(c.imageUrls || []);
    setSelectedImage(0);
    setRemovedRows(new Set());
    setRemovedAxisValues([]);
    setPriceOverrides({});
    setQuantityOverrides({});
    setCondition((isVariationDraft(c) ? c.variants[0]?.condition : c.condition) || "NEW");
    setSinglePrice(isVariationDraft(c) ? "" : c.price.value);
    setSingleQuantity(isVariationDraft(c) ? "1" : String(c.quantity ?? 1));
    setImageOverrides({});
  }, []);

  useEffect(() => {
    api
      .getDraftListing(params.offerId)
      .then((data) => {
        setListing(data.listing);
        setPolicies(data.policies);
        resetFrom(data.listing);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this draft."))
      .finally(() => setLoading(false));
  }, [params.offerId, resetFrom]);

  const originalAspects = useMemo(
    () => (variation ? variation.variesBy.aspects : single?.aspects) || {},
    [variation, single]
  );
  const editedAspects = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const row of specifics) {
      const name = row.name.trim();
      const values = row.value.split(",").map((v) => v.trim()).filter(Boolean);
      if (name && values.length) out[name] = values;
    }
    return out;
  }, [specifics]);
  const aspectsChanged = JSON.stringify(editedAspects) !== JSON.stringify(originalAspects);

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
      JSON.stringify(images) !== JSON.stringify(content.imageUrls) ||
      removedRows.size > 0 ||
      removedAxisValues.length > 0 ||
      Object.keys(priceOverrides).length > 0 ||
      Object.keys(quantityOverrides).length > 0 ||
      Object.keys(imageOverrides).length > 0
    );
  }, [content, variation, single, title, description, aspectsChanged, condition, singlePrice, singleQuantity, images, removedRows, removedAxisValues, priceOverrides, quantityOverrides, imageOverrides]);

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
    if (removedAxisValues.length) patch.removeAxisValues = removedAxisValues;
    return patch;
  }

  // Shown by default: the plain textarea alone made it look as though the
  // account's branded template wasn't being applied. Rebuilt after every
  // save so the preview always matches what Publish would send.
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
    if (listing?.id) loadDescriptionPreview(listing.id);
  }, [listing?.id, listing?.updated_at, loadDescriptionPreview]);

  async function handleSave() {
    if (!listing) return;
    setSaving(true);
    setError(null);
    try {
      const data = await api.updateDraftListing(listing.id, buildPatch());
      setListing(data.listing);
      setImageCheck(data.imageCheck);
      resetFrom(data.listing);
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
      const data = await api.publishDraftListing(listing.id);
      setListing(data.listing);
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
      router.push(`/accounts/${params.id}/listings?filter=draft`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this draft.");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  // --- gallery edits ---
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

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-[var(--color-muted)]">Loading…</p>
      </main>
    );
  }

  if (!listing || !content) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <Alert>{error || "This draft doesn't exist, or isn't yours."}</Alert>
      </main>
    );
  }

  const busy = saving || publishing || deleting || aiBusy;
  const canPublish = editable && !dirty && !busy;

  return (
    <main className="min-h-screen pb-28">
      <BackHeader backHref={`/accounts/${params.id}/listings?filter=draft`} backLabel="Back to drafts" />

      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold text-[var(--color-ink)]">{editable ? "Edit draft" : "Listing"}</h1>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {variation && (
                <span className="rounded-full bg-[var(--color-paper)] px-3 py-1 text-xs font-bold text-[var(--color-muted)]">
                  {variation.variants.length} variations
                </span>
              )}
              <span className="rounded-full bg-[var(--color-accent)]/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-[var(--color-accent)]">
                {listing.status.replace("_", " ")}
              </span>
              {content.warnings && content.warnings.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowNotes((v) => !v)}
                  className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800 hover:bg-amber-200"
                >
                  {content.warnings.length} {content.warnings.length === 1 ? "note" : "notes"}
                </button>
              )}
            </div>
          </div>
          {editable && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="text-sm font-medium text-[var(--color-danger)] hover:underline disabled:opacity-40"
            >
              Delete draft
            </button>
          )}
        </div>

        {error && (
          <div className="mt-4">
            <Alert>{error}</Alert>
          </div>
        )}
        {listing.error_message && listing.status === "pending_review" && (
          <div className="mt-4">
            <Alert>Last publish attempt failed: {listing.error_message}</Alert>
          </div>
        )}
        {imageCheck && !imageCheck.ok && (
          <div className="mt-4">
            <Alert>{imageCheck.errors.join(" ")}</Alert>
          </div>
        )}

        {showNotes && content.warnings && content.warnings.length > 0 && (
          <div className="mt-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4">
            <div className="flex items-baseline justify-between">
              <p className="text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">Drafting notes</p>
              <button type="button" onClick={() => setShowNotes(false)} className="text-xs text-[var(--color-muted)] hover:underline">
                Hide
              </button>
            </div>
            <ul className="mt-2 space-y-1">
              {content.warnings.map((w) => (
                <li key={w} className="text-sm leading-relaxed text-[var(--color-ink)]">• {w}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          {/* Left: images */}
          <div className="space-y-5">
            <ImageCarousel
              images={images}
              selected={selectedImage}
              onSelect={setSelectedImage}
              onSetMain={setMain}
              onDelete={deleteImage}
              onEditWithAi={(i) => {
                setSelectedImage(i);
                setAiScope("image");
              }}
              disabled={!editable || busy}
            />
            {editable && (
              <AiPanel
                scope={aiScope}
                onScopeChange={setAiScope}
                imageLabel={`Image ${selectedImage + 1}`}
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

          {/* Right: content */}
          <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6">
            <div>
              <div className="flex items-baseline justify-between">
                <label className={labelClass}>Title</label>
                <span className={`text-xs ${title.length > TITLE_MAX ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}>
                  {title.length} / {TITLE_MAX}
                </span>
              </div>
              <input
                className={`${inputClass} mt-1.5 font-semibold`}
                value={title}
                maxLength={TITLE_MAX}
                onChange={(e) => setTitle(e.target.value)}
                disabled={!editable || busy}
              />
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <p className={labelClass}>Category</p>
                <p className="mt-1.5 text-sm text-[var(--color-ink)]">
                  {content.categoryPath?.length ? content.categoryPath.join(" › ") : `Category ${content.categoryId}`}
                </p>
                {content.categoryPath?.length ? (
                  <p className="text-xs text-[var(--color-muted)]">eBay category {content.categoryId}</p>
                ) : null}
              </div>
              <div>
                <label className={labelClass}>Condition</label>
                <select
                  className={`${inputClass} mt-1.5`}
                  value={condition}
                  onChange={(e) => setCondition(e.target.value)}
                  disabled={!editable || busy}
                >
                  <option value="NEW">New</option>
                  <option value="USED_EXCELLENT">Used — excellent</option>
                  <option value="USED_GOOD">Used — good</option>
                  <option value="USED_ACCEPTABLE">Used — acceptable</option>
                </select>
              </div>
              {single && (
                <>
                  <div>
                    <label className={labelClass}>Price ({single.price.currency})</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className={`${inputClass} mt-1.5`}
                      value={singlePrice}
                      onChange={(e) => setSinglePrice(e.target.value)}
                      disabled={!editable || busy}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Quantity</label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      className={`${inputClass} mt-1.5`}
                      value={singleQuantity}
                      onChange={(e) => setSingleQuantity(e.target.value)}
                      disabled={!editable || busy}
                    />
                  </div>
                </>
              )}
            </div>

            {single?.priceBreakdown && (
              <div className="mt-5">
                <PriceBreakdownPanel breakdown={single.priceBreakdown} />
              </div>
            )}

            {/* Item specifics — editable in place. Buyers filter on these, so
                they sit above the description rather than below it. */}
            <div className="mt-6">
              <div className="flex items-baseline justify-between">
                <h3 className={labelClass}>Item specifics ({specifics.length})</h3>
                {editable && (
                  <button
                    type="button"
                    onClick={() => setSpecifics((rows) => [...rows, { name: "", value: "" }])}
                    disabled={busy}
                    className="text-xs font-semibold text-[var(--color-accent)] hover:underline disabled:opacity-40"
                  >
                    + Add specific
                  </button>
                )}
              </div>
              {specifics.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--color-muted)]">No item specifics yet.</p>
              ) : (
                <div className="mt-2 grid gap-x-6 gap-y-1.5 md:grid-cols-2">
                  {specifics.map((row, i) => (
                    <div key={i} className="flex items-center gap-2 border-b border-[var(--color-line)] py-1 text-sm">
                      <input
                        className="w-[42%] min-w-0 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[var(--color-muted)] hover:border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none"
                        value={row.name}
                        placeholder="Name"
                        onChange={(e) => setSpecifics((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
                        disabled={!editable || busy}
                      />
                      <input
                        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 font-medium text-[var(--color-ink)] hover:border-[var(--color-line)] focus:border-[var(--color-accent)] focus:outline-none"
                        value={row.value}
                        placeholder="Value"
                        onChange={(e) => setSpecifics((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                        disabled={!editable || busy}
                      />
                      {editable && (
                        <button
                          type="button"
                          aria-label={`Remove ${row.name || "specific"}`}
                          onClick={() => setSpecifics((rows) => rows.filter((_, j) => j !== i))}
                          disabled={busy}
                          className="shrink-0 rounded-md px-1.5 text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-danger)] disabled:opacity-40"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Description — shown as it will appear on eBay (the account's
                branded template around the text). The raw text is only
                exposed when the seller asks to edit it. */}
            <div className="mt-6">
              <div className="flex items-baseline justify-between">
                <h3 className={labelClass}>Description</h3>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-[var(--color-muted)]">
                    {loadingPreview ? "Building preview…" : dirty ? "Save to refresh the preview" : "As it will appear on eBay"}
                  </span>
                  {editable && (
                    <button
                      type="button"
                      onClick={() => setEditingDescription((v) => !v)}
                      className="font-semibold text-[var(--color-accent)] hover:underline"
                    >
                      {editingDescription ? "Hide text editor" : "Edit text"}
                    </button>
                  )}
                </div>
              </div>
              {editingDescription && (
                <textarea
                  className={`${inputClass} mt-2 min-h-[12rem] leading-relaxed`}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={!editable || busy}
                />
              )}
              {descriptionPreview !== null ? (
                <iframe
                  title="Description preview"
                  sandbox=""
                  srcDoc={`<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;padding:12px;background:#f3f3f3">${descriptionPreview}</body>`}
                  className={`mt-2 h-[40rem] w-full rounded-xl border border-[var(--color-line)] bg-white ${dirty ? "opacity-60" : ""}`}
                />
              ) : (
                <div className="mt-2 h-[40rem] w-full animate-pulse rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]" />
              )}
            </div>

            {variation && (
              <VariationsEditor
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
                onRestoreAxisValue={(r) =>
                  setRemovedAxisValues((list) => list.filter((x) => !(x.axis === r.axis && x.value === r.value)))
                }
                onPriceChange={(i, value) => setPriceOverrides((p) => ({ ...p, [i]: value }))}
                onQuantityChange={(i, value) => setQuantityOverrides((p) => ({ ...p, [i]: value }))}
                onImageChange={(i, url) => setImageOverrides((p) => ({ ...p, [i]: url }))}
                disabled={!editable || busy}
              />
            )}

            {content.listingPolicies && (
              <div className="mt-6">
                <h3 className={labelClass}>Listing policies</h3>
                <div className="mt-2 space-y-1 text-sm">
                  {(["fulfillmentPolicyId", "paymentPolicyId", "returnPolicyId"] as const).map((kind) => (
                    <div key={kind} className="flex justify-between border-b border-[var(--color-line)] py-1">
                      <span className="text-[var(--color-muted)]">{kind.replace("PolicyId", "")}</span>
                      <span className="text-[var(--color-ink)]">{policyName(policies, kind, content.listingPolicies![kind])}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {listing.status === "published" && (
              <div className="mt-6">
                <Alert variant="success">
                  Live on eBay{listing.external_product_id ? ` — item ${listing.external_product_id}` : ""}.
                </Alert>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sticky action bar: unsaved edits must be saved before publishing, so
          what goes live is exactly what's on screen. */}
      {editable && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-line)] bg-[var(--color-panel)]/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-3">
            <p className="text-sm text-[var(--color-muted)]">
              {dirty ? "You have unsaved changes." : "All changes saved."}
            </p>
            <div className="flex items-center gap-2">
              {dirty && (
                <button
                  type="button"
                  onClick={() => resetFrom(listing)}
                  disabled={busy}
                  className="rounded-md border border-[var(--color-line)] px-4 py-2 text-sm font-medium text-[var(--color-ink)] disabled:opacity-40"
                >
                  Discard
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={!dirty || busy || title.length > TITLE_MAX}
                className="rounded-md border border-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary)]/5 disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmPublish(true)}
                disabled={!canPublish}
                title={dirty ? "Save your changes first" : undefined}
                className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
              >
                {publishing ? "Publishing…" : "Publish to eBay"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmPublish}
        title="Publish this listing?"
        description={`It goes live on eBay immediately${variation ? `, with ${variation.variants.length} variations` : ""}. Publishing creates the listing on eBay now, so this can take a minute or two for large variation sets.`}
        confirmLabel="Publish"
        loading={publishing}
        onCancel={() => setConfirmPublish(false)}
        onConfirm={handlePublish}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this draft?"
        description="This removes the draft from Liston. Nothing has been created on eBay, so there's nothing to undo there."
        confirmLabel="Delete"
        danger
        loading={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
      />
    </main>
  );
}
