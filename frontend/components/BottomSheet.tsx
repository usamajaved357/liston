"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

// A panel that rises from the bottom of a phone's screen: what a dropdown
// becomes where there's no room beside its button. Rendered at the end of
// the page, so no scrolling area or card can clip it. The backdrop, Escape
// and Done close it.
export function BottomSheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl bg-[var(--color-panel)] shadow-[0_-12px_32px_-12px_rgba(15,23,42,0.25)]">
        <div className="mx-auto mt-2 h-1 w-10 flex-shrink-0 rounded-full bg-[var(--color-line-strong)]" aria-hidden />
        <div className="flex flex-shrink-0 items-center justify-between px-4 pb-1 pt-2">
          <p className="text-[15px] font-semibold text-[var(--color-ink)]">{title}</p>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-[14px] font-semibold text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]">
            Done
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(16px,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>,
    document.body
  );
}
