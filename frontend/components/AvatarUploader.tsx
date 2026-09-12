"use client";

import { useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Avatar } from "@/components/Avatar";
import { Alert } from "@/components/Alert";

const OUTPUT_SIZE = 256;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

function readFileAsImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file isn't a valid image."));
      img.onload = () => resolve(img);
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

function cropToSquareDataUrl(img: HTMLImageElement): string {
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't process that image.");

  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

  return canvas.toDataURL("image/jpeg", 0.9);
}

interface AvatarUploaderProps {
  avatarUrl?: string | null;
  onChange: (avatarUrl: string | null) => void;
}

export function AvatarUploader({ avatarUrl, onChange }: AvatarUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);

    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file (PNG, JPEG or WebP).");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setError("That image is too large. Please choose one under 8MB.");
      return;
    }

    setUploading(true);
    try {
      const img = await readFileAsImage(file);
      const dataUrl = cropToSquareDataUrl(img);
      await api.updateAvatar(dataUrl);
      onChange(dataUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Couldn't update your photo.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
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

  return (
    <div className="flex items-center gap-5">
      <Avatar avatarUrl={avatarUrl} size={72} />
      <div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="rounded-md border border-[var(--color-line)] bg-[var(--color-panel)] px-3.5 py-2 text-sm font-medium text-[var(--color-ink)] hover:border-[var(--color-accent)] disabled:opacity-60 transition-colors"
          >
            {uploading ? "Uploading…" : avatarUrl ? "Change photo" : "Upload photo"}
          </button>
          {avatarUrl && (
            <button
              type="button"
              disabled={uploading}
              onClick={handleRemove}
              className="text-sm font-medium text-[var(--color-danger)] hover:underline disabled:opacity-60"
            >
              Remove
            </button>
          )}
        </div>
        <p className="mt-1.5 text-xs text-[var(--color-muted)]">PNG, JPEG or WebP. Cropped to a square.</p>
        {error && (
          <div className="mt-2">
            <Alert>{error}</Alert>
          </div>
        )}
      </div>
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
