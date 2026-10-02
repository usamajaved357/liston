"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { DescriptionTemplatePhotos } from "@/lib/api";

// The draft editor's "Photos in the description": the photos the account's
// description template shows in its gallery (the Showcase layouts, up to 8).
// They follow the listing's own photos until the seller changes them here:
// dragged into another order, taken out, added from the listing's photos
// (gallery or variations) or uploaded for the description only. "Same as
// the listing" goes back to following. A template that shows no photos
// (Classic, or the seller's own HTML) says so instead.

export const DESCRIPTION_PHOTOS = 8;

export function DescriptionPhotos({
  chosen,
  listingPhotos,
  otherPhotos,
  template,
  settingsHref,
  editable,
  uploading,
  onChange,
  onUpload,
}: {
  // The description's own choice; null: the listing's photos.
  chosen: string[] | null;
  listingPhotos: string[];
  // The variations' photos and any other the draft has, to add from.
  otherPhotos: string[];
  template: DescriptionTemplatePhotos | null;
  settingsHref: string;
  editable: boolean;
  uploading: boolean;
  onChange: (next: string[] | null) => void;
  onUpload: (file: File) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const shown = chosen ?? listingPhotos.slice(0, DESCRIPTION_PHOTOS);
  const full = shown.length >= DESCRIPTION_PHOTOS;
  const candidates = [...new Set([...listingPhotos, ...otherPhotos, ...(chosen || [])])];

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...shown];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };
  const remove = (index: number) => onChange(shown.filter((_, i) => i !== index));
  const toggle = (url: string) => {
    if (shown.includes(url)) onChange(shown.filter((u) => u !== url));
    else if (!full) onChange([...shown, url]);
  };
  const endDrag = () => {
    setDragFrom(null);
    setDragOver(null);
  };

  if (template && !template.photos) {
    return (
      <div className="mt-3 border-t border-[var(--color-line)] pt-3">
        <p className="text-[12.5px] font-semibold text-[var(--color-ink)]">Photos in the description</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-muted)]">
          This account&apos;s template ({template.name}) doesn&apos;t show photos. The Showcase, Minimal, Bold and Boutique layouts show a gallery of them:{" "}
          <Link href={settingsHref} className="font-medium text-[var(--color-primary)] hover:underline">
            change the template
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-[var(--color-line)] pt-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold text-[var(--color-ink)]">Photos in the description</p>
          <p className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">
            {chosen
              ? `Chosen for the description: ${shown.length} of up to ${DESCRIPTION_PHOTOS}${editable ? ", drag to reorder" : ""}.`
              : `The listing's ${shown.length === 1 ? "photo" : `first ${shown.length} photos`}, in its order. Change them to show different ones.`}
          </p>
        </div>
        {editable && chosen && (
          <button type="button" onClick={() => onChange(null)} className="text-[12px] font-medium text-[var(--color-primary)] hover:underline">
            Same as the listing
          </button>
        )}
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1.5 sm:grid-cols-8">
        {shown.map((url, i) => (
          <div
            key={`${url}-${i}`}
            draggable={editable}
            title={editable ? "Drag to reorder" : undefined}
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
              if (dragFrom !== null) move(dragFrom, i);
              endDrag();
            }}
            onDragEnd={endDrag}
            className={`group relative aspect-square overflow-hidden rounded-lg border-2 bg-white transition-all ${editable ? "cursor-grab active:cursor-grabbing" : ""} ${
              dragOver === i && dragFrom !== i ? "scale-105 border-dashed border-[var(--color-primary)]" : "border-[var(--color-line)]"
            } ${dragFrom === i ? "opacity-40" : ""}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" draggable={false} className="pointer-events-none h-full w-full object-contain" />
            <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-bold text-white">{i + 1}</span>
            {editable && (
              <span className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                {i > 0 && (
                  <button type="button" onClick={() => move(i, i - 1)} aria-label={`Move photo ${i + 1} earlier`} title="Move earlier" className="flex h-5 w-5 items-center justify-center rounded-full bg-white/95 text-[var(--color-ink)] shadow-sm hover:bg-white">
                    <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden>
                      <path d="M10 3.5L5.5 8 10 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
                <button type="button" onClick={() => remove(i)} aria-label={`Take photo ${i + 1} out of the description`} title="Take out of the description" className="flex h-5 w-5 items-center justify-center rounded-full bg-white/95 text-[var(--color-ink)] shadow-sm hover:bg-rose-50 hover:text-rose-600">
                  <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden>
                    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            )}
          </div>
        ))}
        {editable && !full && (
          <button
            type="button"
            onClick={() => setPicking(true)}
            disabled={uploading}
            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-[var(--color-line)] text-[11px] font-medium text-[var(--color-muted)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] disabled:opacity-50"
          >
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
              <path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            {uploading ? "Uploading…" : "Add"}
          </button>
        )}
        {!shown.length && !editable && <p className="col-span-full text-[12px] text-[var(--color-muted)]">No photos in the description.</p>}
      </div>

      {picking && (
        <PhotoPicker
          candidates={candidates}
          shown={shown}
          full={full}
          uploading={uploading}
          onToggle={toggle}
          onUpload={onUpload}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function PhotoPicker({
  candidates,
  shown,
  full,
  uploading,
  onToggle,
  onUpload,
  onClose,
}: {
  candidates: string[];
  shown: string[];
  full: boolean;
  uploading: boolean;
  onToggle: (url: string) => void;
  onUpload: (file: File) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Photos in the description" className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col rounded-2xl bg-[var(--color-panel)] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Photos in the description</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
          Pick from this listing&apos;s photos, or upload one for the description only. Up to {DESCRIPTION_PHOTOS} show, in the order picked.
        </p>
        <div className="mt-3 grid min-h-0 grid-cols-4 gap-2 overflow-y-auto p-0.5">
          {candidates.map((url) => {
            const at = shown.indexOf(url);
            const on = at >= 0;
            return (
              <button
                key={url}
                type="button"
                onClick={() => onToggle(url)}
                disabled={!on && full}
                aria-pressed={on}
                aria-label={on ? `Photo ${at + 1} in the description: take it out` : "Add to the description"}
                className={`relative aspect-square overflow-hidden rounded-lg border-2 bg-white transition-all disabled:opacity-40 ${on ? "border-[var(--color-primary)] ring-2 ring-[var(--color-primary-soft)]" : "border-[var(--color-line)] hover:border-[var(--color-muted)]"}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="h-full w-full object-contain" />
                {on && <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-primary)] text-[10.5px] font-bold text-white shadow-sm">{at + 1}</span>}
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <input
            ref={input}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onUpload(file);
            }}
          />
          <button type="button" onClick={() => input.current?.click()} disabled={uploading || full} className="btn btn-secondary btn-sm" title={full ? `The description shows up to ${DESCRIPTION_PHOTOS} photos` : undefined}>
            {uploading ? "Uploading…" : "Upload a photo"}
          </button>
          <span className="flex items-center gap-3">
            <span className="text-[12px] tabular-nums text-[var(--color-muted)]">
              {shown.length} of {DESCRIPTION_PHOTOS}
            </span>
            <button type="button" onClick={onClose} className="btn btn-primary btn-sm">
              Done
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
