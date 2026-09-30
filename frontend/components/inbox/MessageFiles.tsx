"use client";

import { useState } from "react";
import Lightbox from "yet-another-react-lightbox";
import Thumbnails from "yet-another-react-lightbox/plugins/thumbnails";
import Download from "yet-another-react-lightbox/plugins/download";
import Counter from "yet-another-react-lightbox/plugins/counter";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/thumbnails.css";
import "yet-another-react-lightbox/plugins/counter.css";
import { SharedFile } from "@/lib/api";
import { fileSize } from "./inbox-format";

// A message's files: photos sent together as one stack with its count, the
// way eBay shows a buyer's photos ("5 photos"), opening a full-size viewer
// with arrows, thumbnails and download; any other file as a row to open or
// download.

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

/** Photos: one shown as it is; several as a stack with their count. */
export function PhotoStack({ photos, align = "left", size = 220 }: { photos: ViewablePhoto[]; align?: "left" | "right"; size?: number }) {
  const [open, setOpen] = useState<number | null>(null);
  // A photo whose file is gone from the store shows as a quiet tile, not a broken image.
  const [missing, setMissing] = useState(false);
  if (!photos.length) return null;
  const first = photos[0];
  const ratio = first.width && first.height ? first.width / first.height : 1;
  const w = ratio >= 1 ? size : Math.max(Math.round(size * 0.6), Math.round(size * ratio));
  const h = ratio >= 1 ? Math.max(Math.round(size / 2), Math.round(size / ratio)) : size;
  if (missing)
    return (
      <div className={`flex ${align === "right" ? "justify-end" : "justify-start"}`}>
        <span className="flex items-center gap-2 rounded-xl border border-dashed border-[var(--color-line)] px-3 py-2 text-[11.5px] text-[var(--color-muted)]" title={first.name || undefined}>
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
            <rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
            <path d="M3.5 16l5-5 4 4 3-3 5 5M4 4l16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Photo unavailable
        </span>
      </div>
    );
  return (
    <div className={`flex flex-col ${align === "right" ? "items-end" : "items-start"}`}>
      {photos.length > 1 && <p className="mb-1 px-1 text-[11px] font-medium text-[var(--color-muted)]">{photos.length} photos</p>}
      <button type="button" onClick={() => setOpen(0)} className="group relative block" style={{ width: w + (photos.length > 1 ? 18 : 0), height: h + (photos.length > 1 ? 10 : 0) }} aria-label={photos.length > 1 ? `Open ${photos.length} photos` : "Open photo"}>
        {photos.length > 2 && <span className="absolute rounded-xl border-2 border-[var(--color-panel)] bg-slate-300 shadow-sm" style={{ width: w, height: h, left: 16, top: 8, transform: "rotate(6deg)" }} aria-hidden />}
        {photos.length > 1 && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photos[1].thumb || photos[1].src} alt="" className="absolute rounded-xl border-2 border-[var(--color-panel)] object-cover shadow-sm" style={{ width: w, height: h, left: 9, top: 4, transform: "rotate(3deg)" }} aria-hidden />
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={first.thumb || first.src} alt={first.name || ""} loading="lazy" onError={() => setMissing(true)} className="absolute left-0 top-0 rounded-xl border-2 border-[var(--color-panel)] object-cover shadow-md transition-transform group-hover:-translate-y-0.5" style={{ width: w, height: h }} />
      </button>
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

export function FileRow({ file }: { file: SharedFile }) {
  return (
    <a href={file.url} target="_blank" rel="noopener" className="flex w-full max-w-[320px] items-center gap-2.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-2 text-left transition-colors hover:border-[var(--color-primary)]/50">
      <FileIcon mime={file.mime} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-[var(--color-ink)]">{file.name}</span>
        <span className="block text-[11px] text-[var(--color-muted)]">{fileSize(file.size)}</span>
      </span>
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 flex-shrink-0 text-[var(--color-muted)]" aria-hidden>
        <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}

/** Everything attached to a message: the photos as a stack, the rest as rows. */
export function MessageFiles({ files, align = "left" }: { files: SharedFile[]; align?: "left" | "right" }) {
  const photos = files.filter((f) => f.image);
  const others = files.filter((f) => !f.image);
  if (!files.length) return null;
  return (
    <div className={`flex flex-col gap-1.5 ${align === "right" ? "items-end" : "items-start"}`}>
      {photos.length > 0 && <PhotoStack align={align} photos={photos.map((f) => ({ src: f.url, thumb: f.thumbUrl, width: f.width, height: f.height, name: f.name, download: f.url }))} />}
      {others.map((f) => (
        <FileRow key={f.id} file={f} />
      ))}
    </div>
  );
}
