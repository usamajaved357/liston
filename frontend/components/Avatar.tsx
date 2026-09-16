interface AvatarProps {
  avatarUrl?: string | null;
  size?: number;
}

export function Avatar({ avatarUrl, size = 34 }: AvatarProps) {
  if (avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={avatarUrl}
        alt="Profile"
        width={size}
        height={size}
        className="rounded-full object-cover flex-shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className="flex items-center justify-center rounded-full border-[1.5px] border-[var(--color-primary)] bg-[var(--color-primary)]/5 text-[var(--color-primary)] flex-shrink-0"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" fill="none" style={{ width: size * 0.5, height: size * 0.5 }}>
        <circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M4.5 19.5c1.4-3.4 4.3-5.2 7.5-5.2s6.1 1.8 7.5 5.2"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
