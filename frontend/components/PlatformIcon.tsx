const PLATFORM_STYLES: Record<string, { bg: string; fg: string; label: string }> = {
  ebay: { bg: "#0064D2", fg: "#ffffff", label: "eB" },
  tiktok_shop: { bg: "#000000", fg: "#ffffff", label: "TT" },
  aliexpress: { bg: "#FF4747", fg: "#ffffff", label: "AE" },
  amazon: { bg: "#131921", fg: "#FF9900", label: "az" },
};

interface PlatformIconProps {
  platformKey: string;
  size?: number;
}

export function PlatformIcon({ platformKey, size = 40 }: PlatformIconProps) {
  const style = PLATFORM_STYLES[platformKey] || { bg: "#5b6472", fg: "#ffffff", label: "?" };

  return (
    <div
      className="flex items-center justify-center rounded-lg font-semibold flex-shrink-0"
      style={{
        width: size,
        height: size,
        background: style.bg,
        color: style.fg,
        fontSize: size * 0.4,
      }}
    >
      {style.label}
    </div>
  );
}
