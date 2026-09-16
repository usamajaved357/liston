interface LogoProps {
  size?: number;
  variant?: "light" | "dark";
}

// The mark: an "L" as a thick rounded stroke, with a small accent dot at its
// corner standing in for a connection point — what Liston actually does is
// link marketplace accounts together.
export function Logo({ size = 32, variant = "light" }: LogoProps) {
  const bg = variant === "light" ? "#0f2e4c" : "#ffffff1a";
  const radius = Math.round(size * 0.3);

  return (
    <div
      className="flex items-center justify-center flex-shrink-0"
      style={{ width: size, height: size, background: bg, borderRadius: radius }}
    >
      <svg width={size * 0.52} height={size * 0.52} viewBox="0 0 24 24" fill="none">
        <path
          d="M7.5 5.5V17.5H17.5"
          stroke="#ffffff"
          strokeWidth="4.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="7.5" cy="5.5" r="2.8" fill="#2fd7c4" />
      </svg>
    </div>
  );
}
