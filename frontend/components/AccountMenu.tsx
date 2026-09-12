"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

interface AccountMenuProps {
  email: string;
  planName: string;
  onLogout: () => void;
  onDeleteAccount: () => void;
}

export function AccountMenu({ email, planName, onLogout, onDeleteAccount }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-expanded={open}
        className="flex h-[34px] w-[34px] items-center justify-center rounded-full border-[1.5px] border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 transition-colors"
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-[17px] w-[17px]">
          <circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M4.5 19.5c1.4-3.4 4.3-5.2 7.5-5.2s6.1 1.8 7.5 5.2"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-56 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1.5 shadow-lg z-10">
          <div className="px-3 py-2.5 mb-1 border-b border-[var(--color-line)]">
            <p className="text-sm font-semibold text-[var(--color-ink)] truncate">{email}</p>
            <p className="text-xs text-[var(--color-muted)]">{planName} plan</p>
          </div>
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--color-paper)] transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-[15px] w-[15px] text-[var(--color-muted)]">
              <path
                d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
            </svg>
            Account settings
          </Link>
          <button
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--color-paper)] transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-[15px] w-[15px] text-[var(--color-muted)]">
              <path
                d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Log out
          </button>
          <div className="my-1 border-t border-[var(--color-line)]" />
          <button
            onClick={() => {
              setOpen(false);
              onDeleteAccount();
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-[var(--color-danger)] hover:bg-red-50 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-[15px] w-[15px]">
              <path
                d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2m2 0v12a2 2 0 01-2 2H9a2 2 0 01-2-2V7h10z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Delete account
          </button>
        </div>
      )}
    </div>
  );
}
