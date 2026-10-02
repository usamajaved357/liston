"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Cropper, { Area, Point } from "react-easy-crop";

// Fitting a new profile photo before it's saved: the photo under a round
// frame, dragged to position, zoomed with the slider (or a scroll or pinch)
// and turned a quarter at a time; a preview at the sizes Liston shows it;
// Save makes the square inside the frame, OUTPUT_SIZE across, and hands it
// back as a JPEG data URL (transparent parts on white).

const OUTPUT_SIZE = 256;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file isn't a valid image."));
    img.src = src;
  });
}

/** The square inside the frame, turned as shown, OUTPUT_SIZE across. */
export async function cropToDataUrl(src: string, area: Area, rotation: number, size = OUTPUT_SIZE): Promise<string> {
  const image = await loadImage(src);
  const rad = (rotation * Math.PI) / 180;
  // The whole photo turned, on a canvas big enough for it; the crop is measured on that.
  const turnedW = Math.abs(Math.cos(rad) * image.width) + Math.abs(Math.sin(rad) * image.height);
  const turnedH = Math.abs(Math.sin(rad) * image.width) + Math.abs(Math.cos(rad) * image.height);
  const turned = document.createElement("canvas");
  turned.width = Math.round(turnedW);
  turned.height = Math.round(turnedH);
  const tctx = turned.getContext("2d");
  if (!tctx) throw new Error("Couldn't process that image.");
  tctx.translate(turned.width / 2, turned.height / 2);
  tctx.rotate(rad);
  tctx.drawImage(image, -image.width / 2, -image.height / 2);

  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Couldn't process that image.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(turned, area.x, area.y, area.width, area.height, 0, 0, size, size);
  return out.toDataURL("image/jpeg", 0.9);
}

export function AvatarCropDialog({ src, saving, error, onCancel, onChooseAnother, onSave }: {
  src: string;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onChooseAnother: () => void;
  onSave: (dataUrl: string) => void;
}) {
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [area, setArea] = useState<Area | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The preview follows each move, a moment after it stops.
  const onCropComplete = useCallback(
    (_: Area, pixels: Area) => {
      setArea(pixels);
      if (previewTimer.current) clearTimeout(previewTimer.current);
      previewTimer.current = setTimeout(() => {
        cropToDataUrl(src, pixels, rotation, 128)
          .then(setPreview)
          .catch(() => {});
      }, 120);
    },
    [src, rotation]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !saving && onCancel();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [onCancel, saving]);

  async function save() {
    if (!area) return;
    setMaking(true);
    try {
      onSave(await cropToDataUrl(src, area, rotation));
    } finally {
      setMaking(false);
    }
  }

  function reset() {
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setRotation(0);
  }

  const busy = saving || making;
  const step = (by: number) => setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((z + by) * 100) / 100)));

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 px-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div role="dialog" aria-modal="true" aria-labelledby="avatar-crop-title" className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[460px] flex-col overflow-hidden rounded-2xl bg-[var(--color-panel)] shadow-2xl">
        <div className="px-5 pb-3 pt-5">
          <h2 id="avatar-crop-title" className="text-[17px] font-semibold text-[var(--color-ink)]">
            Adjust your photo
          </h2>
          <p className="mt-0.5 text-[13px] text-[var(--color-muted)]">Drag to position it in the circle and zoom to fit.</p>
        </div>

        <div className="relative mx-5 h-[300px] overflow-hidden rounded-xl bg-slate-900 sm:h-[320px]">
          <Cropper
            image={src}
            crop={crop}
            zoom={zoom}
            rotation={rotation}
            aspect={1}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            cropShape="round"
            showGrid={false}
            zoomSpeed={0.25}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onRotationChange={setRotation}
            onCropComplete={onCropComplete}
            style={{ cropAreaStyle: { border: "2px solid rgba(255,255,255,0.9)", boxShadow: "0 0 0 9999px rgba(15,23,42,0.6)" } }}
          />
        </div>

        <div className="space-y-4 px-5 pb-5 pt-4">
          {/* Zoom, a quarter turn, and back to the start. */}
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => step(-0.2)} disabled={busy || zoom <= MIN_ZOOM} aria-label="Zoom out" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] disabled:opacity-40">
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                <path d="M16 16l4 4M8.5 11h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              disabled={busy}
              aria-label="Zoom"
              className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--color-primary)]"
            />
            <button type="button" onClick={() => step(0.2)} disabled={busy || zoom >= MAX_ZOOM} aria-label="Zoom in" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] disabled:opacity-40">
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                <path d="M16 16l4 4M8.5 11h5M11 8.5v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <span className="h-5 w-px flex-shrink-0 bg-[var(--color-line)]" aria-hidden />
            <button type="button" onClick={() => setRotation((r) => (r + 90) % 360)} disabled={busy} aria-label="Turn a quarter" title="Turn a quarter" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] disabled:opacity-40">
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
                <path d="M19.5 12A7.5 7.5 0 1112 4.5c2.3 0 4.3 1 5.7 2.6M18.5 3.5v4h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button type="button" onClick={reset} disabled={busy || (zoom === 1 && rotation === 0 && crop.x === 0 && crop.y === 0)} className="flex-shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] disabled:opacity-40">
              Reset
            </button>
          </div>

          {/* How it will look, at the sizes Liston shows it. */}
          <div className="flex items-center gap-4 rounded-xl bg-[var(--color-paper)] px-4 py-3">
            <p className="flex-1 text-[12px] leading-snug text-[var(--color-muted)]">How it looks on your profile and beside your messages.</p>
            {[56, 32].map((size) => (
              <span key={size} style={{ width: size, height: size }} className="flex-shrink-0 overflow-hidden rounded-full bg-[var(--color-line)] ring-2 ring-[var(--color-panel)] shadow-sm">
                {preview && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="" className="h-full w-full object-cover" />
                )}
              </span>
            ))}
          </div>

          {error && <p className="text-[12.5px] text-[var(--color-danger)]">{error}</p>}

          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={onChooseAnother} disabled={busy} className="text-[13px] font-medium text-[var(--color-primary)] hover:underline disabled:opacity-50">
              Choose another
            </button>
            <div className="flex gap-2">
              <button type="button" onClick={onCancel} disabled={busy} className="btn btn-ghost btn-sm">
                Cancel
              </button>
              <button type="button" onClick={save} disabled={busy || !area} className="btn btn-primary btn-sm">
                {busy ? "Saving…" : "Save photo"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
