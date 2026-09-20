// Shimmering placeholders shown while a page's data is on the way — the
// shape of the real content in grey, never a bare "Loading…", so the layout
// stays put between tabs. One primitive (`Bone`) and a few page-shaped
// arrangements built from it.

export function Bone({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-full bg-[var(--color-line)] ${className}`} aria-hidden />;
}

function Block({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-[var(--color-paper)] ${className}`} aria-hidden />;
}

// Rows of a list (listings, orders): thumbnail, two lines, a figure.
export function ListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <ul className="divide-y divide-[var(--color-line)]" aria-busy="true" aria-live="polite">
      {Array.from({ length: count }).map((_, i) => (
        <li key={i} className="flex items-center gap-4 px-5 py-3.5">
          <Block className="h-14 w-14" />
          <div className="flex-1 space-y-2">
            <Bone className="h-3.5 w-2/3" />
            <Bone className="h-3 w-1/3 bg-[var(--color-paper)]" />
          </div>
          <Bone className="h-4 w-14" />
        </li>
      ))}
    </ul>
  );
}

// A whole account page before the connection itself has loaded: the
// sidebar's place, a header bar, then list rows. Used by every tab under
// /accounts/[id] so switching tabs never flashes an empty screen.
export function AccountPageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <main className="min-h-screen bg-[var(--color-paper)]" aria-busy="true" aria-live="polite">
      <div className="flex">
        <aside className="hidden w-[260px] flex-shrink-0 border-r border-[var(--color-line)] bg-[var(--color-panel)] p-5 lg:block">
          <Bone className="h-8 w-28" />
          <Block className="mt-6 h-16 w-full" />
          <div className="mt-8 space-y-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Bone key={i} className="h-3.5 w-24" />
            ))}
          </div>
        </aside>
        <div className="min-w-0 flex-1 px-8 py-6">
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <Bone className="h-6 w-32" />
              <Bone className="h-3 w-24 bg-[var(--color-paper)]" />
            </div>
            <Bone className="h-9 w-28" />
          </div>
          <div className="mt-6 flex gap-2">
            <Bone className="h-9 w-24" />
            <Bone className="h-9 w-28 bg-[var(--color-paper)]" />
            <Bone className="h-9 w-24 bg-[var(--color-paper)]" />
          </div>
          <div className="card mt-5 overflow-hidden">
            <ListSkeleton count={rows} />
          </div>
        </div>
      </div>
    </main>
  );
}

// The order page's own shape: dispatch card with its track, postage, item,
// and the Order / Payment cards down the side.
export function OrderDetailSkeleton() {
  const card = "rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5";
  return (
    <div className="pb-8" aria-busy="true" aria-live="polite">
      <div className="flex items-center gap-3 border-b border-[var(--color-line)] pb-4">
        <Block className="h-12 w-12" />
        <div className="space-y-2">
          <Bone className="h-4 w-[420px] max-w-[60vw]" />
          <Bone className="h-3 w-40 bg-[var(--color-paper)]" />
        </div>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <div className={card}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 space-y-2.5">
                <Bone className="h-5 w-72" />
                <Bone className="h-3 w-full max-w-[520px] bg-[var(--color-paper)]" />
                <Bone className="h-3 w-64 bg-[var(--color-paper)]" />
              </div>
              <div className="w-[160px] space-y-2">
                <Bone className="h-8 w-full" />
                <Bone className="h-8 w-full bg-[var(--color-paper)]" />
              </div>
            </div>
            <div className="mt-6 flex items-center gap-3">
              <Bone className="h-6 w-6" />
              <Bone className="h-0.5 flex-1 bg-[var(--color-paper)]" />
              <Bone className="h-6 w-6 bg-[var(--color-paper)]" />
              <Bone className="h-0.5 flex-1 bg-[var(--color-paper)]" />
              <Bone className="h-6 w-6 bg-[var(--color-paper)]" />
            </div>
          </div>
          <div className={card}>
            <Bone className="h-5 w-24" />
            <Block className="mt-4 h-40 w-full" />
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Bone className="h-3 w-16 bg-[var(--color-paper)]" />
                <Bone className="h-3 w-32" />
                <Bone className="h-3 w-40" />
                <Bone className="h-3 w-28" />
              </div>
              <div className="space-y-2">
                <Bone className="h-3 w-40 bg-[var(--color-paper)]" />
                <Bone className="h-3 w-24" />
              </div>
              <Bone className="h-8 w-32 justify-self-end" />
            </div>
          </div>
          <div className={card}>
            <Bone className="h-5 w-16" />
            <div className="mt-4 flex gap-4">
              <Block className="h-[120px] w-[120px]" />
              <div className="flex-1 space-y-2.5">
                <Bone className="h-3.5 w-3/4" />
                <Bone className="h-3 w-1/3 bg-[var(--color-paper)]" />
                <Bone className="h-3 w-1/4 bg-[var(--color-paper)]" />
              </div>
            </div>
          </div>
        </div>
        <div className="space-y-4">
          <div className={card}>
            <Bone className="h-5 w-20" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex justify-between">
                  <Bone className="h-3 w-20 bg-[var(--color-paper)]" />
                  <Bone className="h-3 w-28" />
                </div>
              ))}
            </div>
            <Bone className="mt-5 h-9 w-full bg-[var(--color-paper)]" />
          </div>
          <div className={card}>
            <Bone className="h-5 w-24" />
            <Block className="mt-4 h-20 w-full" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex justify-between">
                  <Bone className="h-3 w-24 bg-[var(--color-paper)]" />
                  <Bone className="h-3 w-14" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// The draft / live-listing editor: photo panel on the left, the title,
// category and specifics fields on the right.
export function EditorSkeleton() {
  const card = "rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5";
  return (
    <main className="min-h-screen bg-[var(--color-paper)]" aria-busy="true" aria-live="polite">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-panel)] px-8 py-4">
        <Bone className="h-9 w-9" />
        <Bone className="h-5 w-32" />
        <Bone className="h-8 w-36 bg-[var(--color-paper)]" />
      </div>
      <div className="grid gap-5 px-8 py-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,5fr)]">
        <div className="space-y-4">
          <div className={card}>
            <div className="flex items-center justify-between">
              <Bone className="h-4 w-24" />
              <Bone className="h-8 w-24 bg-[var(--color-paper)]" />
            </div>
            <Block className="mt-4 aspect-square w-full" />
            <div className="mt-3 grid grid-cols-6 gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Block key={i} className="aspect-square" />
              ))}
            </div>
          </div>
          <div className={card}>
            <Bone className="h-4 w-20" />
            <Bone className="mt-3 h-3 w-full bg-[var(--color-paper)]" />
            <Bone className="mt-2 h-3 w-5/6 bg-[var(--color-paper)]" />
            <Block className="mt-4 h-16 w-full" />
          </div>
        </div>
        <div className="space-y-4">
          <div className={card}>
            <Bone className="h-3 w-12 bg-[var(--color-paper)]" />
            <Bone className="mt-2 h-10 w-full" />
            <Block className="mt-4 h-24 w-full" />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Bone className="h-10 w-full" />
              <Bone className="h-10 w-full" />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Bone className="h-10 w-full" />
              <Bone className="h-10 w-full" />
              <Bone className="h-10 w-full" />
            </div>
          </div>
          <div className={card}>
            <Bone className="h-4 w-32" />
            <div className="mt-4 grid gap-x-10 gap-y-3 sm:grid-cols-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex justify-between">
                  <Bone className="h-3 w-24 bg-[var(--color-paper)]" />
                  <Bone className="h-3 w-28" />
                </div>
              ))}
            </div>
          </div>
          <div className={card}>
            <Bone className="h-4 w-28" />
            <Block className="mt-4 h-48 w-full" />
          </div>
        </div>
      </div>
    </main>
  );
}

// A few lines inside a panel or dropdown that is fetching its options.
export function LinesSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-2.5 px-3 py-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: count }).map((_, i) => (
        <Bone key={i} className={`h-3 ${i % 2 ? "w-2/3" : "w-5/6"}`} />
      ))}
    </div>
  );
}
