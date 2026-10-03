"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Avatar } from "@/components/Avatar";
import { AvatarCropDialog } from "@/components/AvatarCropDialog";

// A chosen photo opens AvatarCropDialog to be positioned, zoomed and turned
// in a round frame; only the square inside it is saved (256 across, JPEG).
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

interface AvatarUploaderProps {
  avatarUrl?: string | null;
  onChange: (avatarUrl: string | null) => void;
}

export function AvatarUploader({ avatarUrl, onChange }: AvatarUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The photo being fitted (an object URL), and what went wrong saving it.
  const [cropping, setCropping] = useState<string | null>(null);
  const [cropError, setCropError] = useState<string | null>(null);

  // The chosen file's URL is let go once it's done with.
  useEffect(() => () => {
    if (cropping) URL.revokeObjectURL(cropping);
  }, [cropping]);

  function handleFile(file: File) {
    setError(null);
    setCropError(null);
    if (inputRef.current) inputRef.current.value = "";

    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("Choose a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setError("That image is over 8 MB. Choose a smaller one.");
      return;
    }
    setCropping(URL.createObjectURL(file));
  }

  async function saveCropped(dataUrl: string) {
    setUploading(true);
    setCropError(null);
    try {
      await api.updateAvatar(dataUrl);
      onChange(dataUrl);
      setCropping(null);
    } catch (err) {
      setCropError(err instanceof ApiError ? err.message : "Couldn't save your photo. Try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove() {
    setError(null);
    setUploading(true);
    try {
      await api.deleteAvatar();
      onChange(null);
    } catch {
      setError("Couldn't remove your photo. Try again.");
    } finally {
      setUploading(false);
    }
  }

  // The photo with a camera button on it (choose a new one), and Remove under it.
  return (
    <div className="flex w-[84px] flex-shrink-0 flex-col items-center">
      <div className="relative">
        <span className="block rounded-full bg-[var(--color-panel)] p-[3px] shadow-[0_8px_20px_-8px_rgba(15,23,42,0.35)] ring-1 ring-[var(--color-line)]">
          <Avatar avatarUrl={avatarUrl} size={68} />
        </span>
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          aria-label={avatarUrl ? "Change photo" : "Upload a photo"}
          title={avatarUrl ? "Change photo (PNG, JPEG or WebP; you fit it in the circle next)" : "Upload a photo (PNG, JPEG or WebP; you fit it in the circle next)"}
          className="absolute -bottom-0.5 -right-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-primary)] text-white shadow-md ring-2 ring-[var(--color-panel)] transition-colors hover:bg-[var(--color-primary-hover,#4338ca)] disabled:opacity-60"
        >
          {uploading ? (
            <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5 animate-spin" aria-hidden>
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
              <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
              <path d="M3.5 7A1.5 1.5 0 015 5.5h1.8l1.2-1.8h4l1.2 1.8H15A1.5 1.5 0 0116.5 7v7a1.5 1.5 0 01-1.5 1.5H5A1.5 1.5 0 013.5 14V7z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <circle cx="10" cy="10.3" r="2.6" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          )}
        </button>
      </div>
      {avatarUrl ? (
        <button type="button" disabled={uploading} onClick={handleRemove} className="mt-2 text-[11.5px] font-medium text-[var(--color-muted)] hover:text-[var(--color-danger)] disabled:opacity-60">
          Remove photo
        </button>
      ) : (
        <button type="button" disabled={uploading} onClick={() => inputRef.current?.click()} className="mt-2 text-[11.5px] font-semibold text-[var(--color-primary)] hover:underline disabled:opacity-60">
          Add photo
        </button>
      )}
      {error && <p className="mt-1 w-[180px] text-center text-[11px] leading-snug text-[var(--color-danger)]">{error}</p>}
      {cropping && (
        <AvatarCropDialog
          key={cropping}
          src={cropping}
          saving={uploading}
          error={cropError}
          onCancel={() => setCropping(null)}
          onChooseAnother={() => inputRef.current?.click()}
          onSave={saveCropped}
        />
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
    </div>
  );
}
