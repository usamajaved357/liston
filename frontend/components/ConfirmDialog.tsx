interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  danger,
  loading,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        className="w-full max-w-sm rounded-xl bg-[var(--color-panel)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-[var(--color-ink)]">{title}</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">{description}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="rounded-md px-4 py-2 text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-ink)] disabled:opacity-60 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-60 transition-colors ${
              danger
                ? "bg-[var(--color-danger)] hover:bg-red-700"
                : "bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)]"
            }`}
          >
            {loading ? "Please wait" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
