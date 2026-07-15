"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

interface AccountMenuProps {
  onLogout: () => void;
  onDeleteAccount: () => void;
}

export function AccountMenu({ onLogout, onDeleteAccount }: AccountMenuProps) {
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
        aria-label="Account settings"
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--color-muted)] hover:bg-[var(--color-line)]/60 hover:text-[var(--color-ink)] transition-colors"
      >
        <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5">
          <path
            d="M10 12.9a2.9 2.9 0 100-5.8 2.9 2.9 0 000 5.8z"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M16.2 10c0 .3-.02.55-.06.8l1.36 1.06-1.1 1.9-1.6-.53c-.44.4-.96.72-1.52.94l-.24 1.63H9.96l-.24-1.63a5.2 5.2 0 01-1.52-.94l-1.6.53-1.1-1.9L6.86 10.8A4.4 4.4 0 016.8 10c0-.27.02-.53.06-.8L5.5 8.14l1.1-1.9 1.6.53c.44-.4.96-.72 1.52-.94L9.96 4.2h2.08l.24 1.63c.56.22 1.08.54 1.52.94l1.6-.53 1.1 1.9-1.36 1.06c.04.27.06.53.06.8z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-52 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] py-1.5 shadow-lg z-10">
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="block w-full px-4 py-2 text-left text-sm text-[var(--color-ink)] hover:bg-[var(--color-paper)] transition-colors"
          >
            Account settings
          </Link>
          <div className="my-1.5 border-t border-[var(--color-line)]" />
          <button
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="block w-full px-4 py-2 text-left text-sm text-[var(--color-ink)] hover:bg-[var(--color-paper)] transition-colors"
          >
            Log out
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onDeleteAccount();
            }}
            className="block w-full px-4 py-2 text-left text-sm text-[var(--color-danger)] hover:bg-red-50 transition-colors"
          >
            Delete account
          </button>
        </div>
      )}
    </div>
  );
}
