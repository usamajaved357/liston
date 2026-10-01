"use client";

import { ReactNode, useState } from "react";
import Lightbox from "yet-another-react-lightbox";
import Thumbnails from "yet-another-react-lightbox/plugins/thumbnails";
import Download from "yet-another-react-lightbox/plugins/download";
import Counter from "yet-another-react-lightbox/plugins/counter";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/thumbnails.css";
import "yet-another-react-lightbox/plugins/counter.css";
import { SharedFile } from "@/lib/api";
import { fileSize } from "./inbox-format";

// A message's files as WhatsApp shows them inside a bubble: one photo as
// it is (its shape kept within limits), several as an album (two side by
// side, three as one wide and two below, four or more as a square of four
// with "+3" on the last), opening a full-size viewer with arrows,
// thumbnails and download; any other file as a row to open or download.

export type ViewablePhoto = { src: string; thumb?: string | null; width?: number | null; height?: number | null; name?: string; download?: string };

export function PhotoViewer({ photos, index, onClose }: { photos: ViewablePhoto[]; index: number | null; onClose: () => void }) {
  return (
    <Lightbox
      open={index !== null}
      close={onClose}
      index={index ?? 0}
      slides={photos.map((p) => ({ src: p.src, width: p.width ?? undefined, height: p.height ?? undefined, alt: p.name, download: p.download ? { url: p.download, filename: p.name || "photo" } : undefined }))}
      plugins={photos.length > 1 ? [Thumbnails, Counter, Download] : [Download]}
      carousel={{ finite: photos.length <= 1 }}
      controller={{ closeOnBackdropClick: true }}
      thumbnails={{ width: 72, height: 56, border: 0, padding: 0, gap: 8 }}
      styles={{ container: { backgroundColor: "rgba(15, 23, 42, 0.92)" } }}
    />
  );
}

function Missing({ name }: { name?: string }) {
  return (
    <span className="flex h-full w-full flex-col items-center justify-center gap-1 bg-black/[0.04] text-[11px] text-[var(--color-muted)]" title={name || undefined}>
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
        <rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M3.5 16l5-5 4 4 3-3 5 5M4 4l16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Photo unavailable
    </span>
  );
}

/**
 * Photos in a bubble: one as it is, several as an album. `overlay` (the
 * time, when no text follows) sits in the bottom corner over a soft shade.
 */
export function PhotoGrid({ photos, width = 280, overlay }: { photos: ViewablePhoto[]; width?: number; overlay?: ReactNode }) {
  const [open, setOpen] = useState<number | null>(null);
  // A photo whose file is gone from the store shows as a quiet tile, not a broken image.
  const [missing, setMissing] = useState<Set<number>>(() => new Set());
  if (!photos.length) return null;
  const shown = photos.slice(0, 4);
  const extra = photos.length - shown.length;
  const gap = 3;
  const half = Math.floor((width - gap) / 2);
  // One photo keeps its shape, from a little taller than square to a wide strip.
  const first = photos[0];
  const ratio = first.width && first.height ? Math.min(1.8, Math.max(0.75, first.width / first.height)) : 4 / 3;
  const box = (i: number): { w: number; h: number; span?: boolean } => {
    if (shown.length === 1) return { w: width, h: Math.round(width / ratio) };
    if (shown.length === 3 && i === 0) return { w: width, h: half, span: true };
    return { w: half, h: half };
  };
  const cell = (p: ViewablePhoto, i: number) => {
    const { w, h, span } = box(i);
    return (
      <button key={i} type="button" onClick={() => setOpen(i)} className={`relative block overflow-hidden rounded-md bg-black/[0.04] ${span ? "col-span-2" : ""}`} style={{ width: w, height: h }} aria-label={photos.length > 1 ? `Open photo ${i + 1} of ${photos.length}` : "Open photo"}>
        {missing.has(i) ? (
          <Missing name={p.name} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.thumb || p.src} alt={p.name || ""} loading="lazy" onError={() => setMissing((m) => new Set(m).add(i))} className="h-full w-full object-cover transition-transform duration-300 hover:scale-[1.02]" />
        )}
        {i === 3 && extra > 0 && <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-[22px] font-semibold text-white">+{extra}</span>}
      </button>
    );
  };
  return (
    <div className="relative">
      {shown.length === 1 ? cell(first, 0) : <div className="grid grid-cols-2" style={{ gap, width }}>{shown.map(cell)}</div>}
      {overlay && (
        <>
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-md bg-gradient-to-t from-black/40 to-transparent" aria-hidden />
          <span className="pointer-events-none absolute bottom-[5px] right-[7px]">{overlay}</span>
        </>
      )}
      <PhotoViewer photos={photos} index={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function FileIcon({ mime }: { mime: string }) {
  const pdf = mime === "application/pdf";
  return (
    <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg ${pdf ? "bg-rose-50 text-rose-600" : "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"}`}>
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
        <path d="M7 3h7l5 5v12a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** A document in a bubble: its icon, name and size, opening (or downloading) it. */
export function FileRow({ file }: { file: Pick<SharedFile, "url" | "name" | "mime"> & { size?: number | null } }) {
  return (
    <a href={file.url} target="_blank" rel="noopener" className="flex w-[260px] max-w-full items-center gap-2.5 rounded-md bg-black/[0.045] p-2 text-left transition-colors hover:bg-black/[0.07]">
      <FileIcon mime={file.mime} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-[var(--color-ink)]">{file.name}</span>
        {file.size ? <span className="block text-[11px] text-[var(--color-muted)]">{fileSize(file.size)}</span> : null}
      </span>
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 flex-shrink-0 text-[var(--color-muted)]" aria-hidden>
        <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}
