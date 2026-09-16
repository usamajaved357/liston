import { ReactNode } from "react";
import { Logo } from "@/components/Logo";

// The feature grid — what the tool actually does today, no more.
const FEATURES = ["Reads the competitor and the supplier", "Prices every variation for your return", "Publishes to eBay in one click"];

// Listings published per day, drawn as an area chart with the line tracing
// itself in, and the orders that followed as bars beneath. Decorative, but
// honest in shape: this is what a good month looks like.
function Chart() {
  const points = [12, 18, 15, 26, 24, 34, 31, 42, 38, 47, 45, 56];
  const w = 600;
  const h = 150;
  const max = 60;
  const step = w / (points.length - 1);
  const coords = points.map((v, i) => [i * step, h - (v / max) * h] as const);
  const line = coords.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  const orders = [3, 5, 4, 8, 7, 11, 9, 14, 12, 16, 15, 19];

  return (
    <div className="lst-in relative mt-7 overflow-hidden rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm" style={{ animationDelay: ".2s" }}>
      <style>{`
        @keyframes lst-draw { to { stroke-dashoffset: 0 } }
        @keyframes lst-fade { to { opacity: 1 } }
        @keyframes lst-grow { from { transform: scaleY(0) } to { transform: scaleY(1) } }
        @keyframes lst-in { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes lst-blink { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
        .lst-line { stroke-dasharray: 1400; stroke-dashoffset: 1400; animation: lst-draw 2.2s cubic-bezier(.4,0,.2,1) .4s forwards }
        .lst-area { opacity: 0; animation: lst-fade 1.2s ease 1.6s forwards }
        .lst-bar { transform-origin: bottom; animation: lst-grow .8s cubic-bezier(.2,.8,.2,1) both }
        .lst-in { animation: lst-in .7s ease-out both }
        .lst-dot { animation: lst-blink 1.8s ease-in-out 2.6s infinite }
      `}</style>
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/55">Listings published · last 12 days</p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-white">
            388 <span className="text-sm font-semibold text-[#a7f3d0]">▲ 3.4× vs by hand</span>
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-white/60">
          <span className="inline-block h-2 w-5 rounded-sm bg-white" /> listings
          <span className="ml-2 inline-block h-2 w-5 rounded-sm bg-[#fbbf24]" /> orders
        </div>
      </div>
      <svg viewBox={`0 0 ${w} ${h + 30}`} className="mt-2 h-28 w-full" preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="lst-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} stroke="rgba(255,255,255,.14)" strokeWidth="1" />
        ))}
        <path d={area} fill="url(#lst-fill)" className="lst-area" />
        <path d={line} fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" className="lst-line" />
        {orders.map((o, i) => (
          <rect
            key={i}
            x={i * step - 6}
            y={h + 28 - o}
            width="12"
            height={o}
            rx="2"
            fill="#fbbf24"
            fillOpacity="0.9"
            className="lst-bar"
            style={{ animationDelay: `${1.2 + i * 0.07}s` }}
          />
        ))}
        <circle cx={coords[coords.length - 1][0]} cy={coords[coords.length - 1][1]} r="5" fill="#ffffff" className="lst-dot" />
      </svg>
    </div>
  );
}

interface AuthLayoutProps {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}

export function AuthLayout({ eyebrow, title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <main className="grid h-screen bg-[var(--color-paper)] lg:grid-cols-2">
      <section className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-[var(--color-primary)] px-12 py-10 text-white">
        {/* Backdrop: soft colour fields + a faint grid, so the panels below
            read as floating over a surface rather than flat on a fill. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(55% 45% at 10% 10%, rgba(255,255,255,0.18) 0%, transparent 60%), radial-gradient(50% 40% at 90% 90%, rgba(30,27,75,0.55) 0%, transparent 60%), linear-gradient(165deg, #5b54ea 0%, #4f46e5 50%, #3f37c9 100%)",
          }}
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.08]"
          style={{ backgroundImage: "linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)", backgroundSize: "44px 44px" }}
        />

        <div className="relative flex items-center gap-2.5">
          <Logo size={36} variant="dark" />
          <span className="font-semibold tracking-tight">Liston</span>
        </div>

        <div className="relative">
          <h2 className="max-w-md text-[28px] font-bold leading-[1.15] tracking-tight">
            From two links to a live eBay listing.
          </h2>
          <p className="mt-2 max-w-md text-[14px] leading-relaxed text-white/70">
            Paste a competitor and a supplier — Liston does the rest.
          </p>

          <Chart />

          <ul className="mt-5 space-y-2">
            {FEATURES.map((feature, i) => (
              <li key={feature} className="lst-in flex items-center gap-3 text-[13px] text-white/85" style={{ animationDelay: `${0.5 + i * 0.1}s` }}>
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-white/15">
                  <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5">
                    <path d="M5 10.5l3 3L15 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                {feature}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-white/45">© {new Date().getFullYear()} Liston</p>
      </section>

      <section className="flex items-center justify-center overflow-y-auto px-4 py-8 sm:px-6">
        <div className="w-full max-w-[360px]">
          <div className="mb-5 text-center lg:text-left">
            <div className="inline-flex mb-4 lg:hidden">
              <Logo size={36} />
            </div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-accent)] mb-1.5">
              {eyebrow}
            </p>
            <h1 className="text-[22px] font-bold tracking-tight text-[var(--color-ink)]">{title}</h1>
            <p className="mt-1 text-[13.5px] leading-relaxed text-[var(--color-muted)]">{subtitle}</p>
          </div>

          <div className="card p-5">
            {children}
          </div>

          <div className="mt-5 text-center text-sm text-[var(--color-muted)]">{footer}</div>
        </div>
      </section>
    </main>
  );
}
