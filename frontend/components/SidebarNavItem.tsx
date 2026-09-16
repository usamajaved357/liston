"use client";

import Link from "next/link";

interface NavItemProps {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
}

export function SidebarNavItem({ href, active, icon, label }: NavItemProps) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-[var(--color-primary)]/5 text-[var(--color-primary)]"
          : "text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
      }`}
    >
      {icon}
      {label}
    </Link>
  );
}
