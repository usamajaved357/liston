"use client";

import Link from "next/link";

interface NavItemProps {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  // Things waiting for this person here (products to review, say).
  badge?: number;
}

export function SidebarNavItem({ href, active, icon, label, badge }: NavItemProps) {
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
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? (
        <span className="min-w-[20px] rounded-full bg-[var(--color-primary)] px-1.5 text-center text-[11px] font-semibold leading-5 text-white tabular-nums" aria-label={`${badge} waiting`}>
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </Link>
  );
}
