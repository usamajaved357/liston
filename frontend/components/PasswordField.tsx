"use client";

import { useState } from "react";
import { PasswordInput } from "./PasswordInput";

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  name?: string;
  required?: boolean;
  error?: string;
  showCriteria?: boolean;
}

export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  name,
  required,
  error,
  showCriteria,
}: PasswordFieldProps) {
  const [focused, setFocused] = useState(false);
  const meetsLength = value.length >= 8;

  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-[var(--color-ink)]">{label}</span>
      <PasswordInput
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        name={name}
        required={required}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {showCriteria && focused && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
          <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 flex-shrink-0">
            <circle cx="8" cy="8" r="8" fill={meetsLength ? "#0f9b8e" : "#e2e5eb"} />
            {meetsLength && (
              <path
                d="M5 8l2 2 4-4"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
          <span className={meetsLength ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"}>
            At least 8 characters
          </span>
        </div>
      )}
      {error && <span className="mt-1 block text-xs text-[var(--color-danger)]">{error}</span>}
    </label>
  );
}
