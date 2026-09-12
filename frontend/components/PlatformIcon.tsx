interface PlatformIconProps {
  platformKey: string;
  size?: number;
}

function EbayGlyph({ size }: { size: number }) {
  const dot = Math.max(4, Math.round(size * 0.15));
  const gap = Math.max(2, Math.round(size * 0.08));
  return (
    <div
      className="flex items-center justify-center flex-shrink-0 rounded-lg bg-white border border-[var(--color-line)]"
      style={{ width: size, height: size }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(2, ${dot}px)`,
          gridTemplateRows: `repeat(2, ${dot}px)`,
          gap,
        }}
      >
        <div style={{ width: dot, height: dot, borderRadius: 999, background: "#E53238" }} />
        <div style={{ width: dot, height: dot, borderRadius: 999, background: "#0064D2" }} />
        <div style={{ width: dot, height: dot, borderRadius: 999, background: "#F5AF02" }} />
        <div style={{ width: dot, height: dot, borderRadius: 999, background: "#86B817" }} />
      </div>
    </div>
  );
}

function TikTokGlyph({ size }: { size: number }) {
  return (
    <div
      className="flex items-center justify-center flex-shrink-0 rounded-lg"
      style={{ width: size, height: size, background: "#000000" }}
    >
      <svg width={size * 0.46} height={size * 0.46} viewBox="0 0 24 24" fill="none">
        <path
          d="M14 4c.4 2.2 1.9 3.7 4 4v3c-1.5 0-2.9-.4-4-1.2V15a5 5 0 11-5-5c.3 0 .7 0 1 .1v3.1a2 2 0 101.8 2V4h2.2z"
          fill="#ffffff"
        />
      </svg>
    </div>
  );
}

function AmazonGlyph({ size }: { size: number }) {
  return (
    <div
      className="flex items-center justify-center flex-shrink-0 rounded-lg"
      style={{ width: size, height: size, background: "#131921" }}
    >
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none">
        <path d="M4 15.5c4 2.6 12 3 16-.3" stroke="#FF9900" strokeWidth="2" strokeLinecap="round" />
        <path
          d="M17 13.8l2.6.4-.9 2.5"
          stroke="#FF9900"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function FallbackGlyph({ size, label }: { size: number; label: string }) {
  return (
    <div
      className="flex items-center justify-center flex-shrink-0 rounded-lg font-semibold text-white"
      style={{ width: size, height: size, background: "#5b6472", fontSize: size * 0.4 }}
    >
      {label}
    </div>
  );
}

export function PlatformIcon({ platformKey, size = 40 }: PlatformIconProps) {
  switch (platformKey) {
    case "ebay":
      return <EbayGlyph size={size} />;
    case "tiktok_shop":
      return <TikTokGlyph size={size} />;
    case "amazon":
      return <AmazonGlyph size={size} />;
    case "aliexpress":
      return <FallbackGlyph size={size} label="AE" />;
    default:
      return <FallbackGlyph size={size} label="?" />;
  }
}
