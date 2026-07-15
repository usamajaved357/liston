import { ReactNode } from "react";

const VARIANTS = {
  error: "border-red-200 bg-red-50 text-red-800",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  info: "border-blue-200 bg-blue-50 text-blue-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
};

interface AlertProps {
  children: ReactNode;
  variant?: keyof typeof VARIANTS;
}

export function Alert({ children, variant = "error" }: AlertProps) {
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm ${VARIANTS[variant]}`}
    >
      <svg viewBox="0 0 20 20" fill="none" className="mt-0.5 h-4 w-4 flex-shrink-0">
        <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.3" />
        <path d="M10 6v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="10" cy="13.5" r="0.9" fill="currentColor" />
      </svg>
      <span>{children}</span>
    </div>
  );
}
