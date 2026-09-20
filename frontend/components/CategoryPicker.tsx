"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, CategoryNode, CategorySuggestion, StoreCategory } from "@/lib/api";

// The category dialog, laid out the way eBay's own is: an item category
// (required) and an optional second one, then up to two Shop categories for
// sellers with an eBay Shop. Item categories come from eBay's full tree for
// the account's marketplace, found by search or by browsing down from the
// top; Shop categories are the seller's own departments.

export interface CategorySelection {
  categoryId: string;
  categoryPath: string[];
  secondaryCategoryId: string | null;
  secondaryCategoryPath: string[];
  storeCategoryNames: string[];
}

type Slot = "primary" | "secondary";

function pathOf(node: CategoryNode, trail: { id: string; name: string }[]) {
  return node.path?.length ? node.path : [...trail.map((t) => t.name), node.name];
}

// Flattens the Shop category tree into "/Department/Sub" paths, which is the
// form eBay takes on an offer.
function storePaths(categories: StoreCategory[], prefix = ""): { path: string; label: string; depth: number }[] {
  return categories.flatMap((c) => {
    const path = `${prefix}/${c.name}`;
    return [{ path, label: c.name, depth: prefix.split("/").length - 1 }, ...storePaths(c.children || [], path)];
  });
}

function CategoryBrowser({
  connectionId,
  suggestions,
  onPick,
  onCancel,
}: {
  connectionId: string;
  suggestions: CategorySuggestion[];
  onPick: (node: { id: string; path: string[] }) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  // Results are tagged with the query they answer, so "still searching" is
  // simply "the tag doesn't match what's typed" — no separate flag to keep
  // in step.
  const [search, setSearch] = useState<{ q: string; results: CategoryNode[] } | null>(null);
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const [loaded, setLoaded] = useState<{ parentId: string | undefined; children: CategoryNode[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const parentId = trail[trail.length - 1]?.id;
  const loadingChildren = !loaded || loaded.parentId !== parentId;
  const children = loadingChildren ? [] : loaded.children;

  // Browse: children of the last crumb (top level when there's none).
  useEffect(() => {
    let cancelled = false;
    api
      .categoryChildren(connectionId, parentId)
      .then((data) => {
        if (!cancelled) setLoaded({ parentId, children: data.children });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Couldn't load categories.");
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, parentId]);

  const q = query.trim();
  const results = q.length < 2 ? null : search && search.q === q ? search.results : [];
  const searching = q.length >= 2 && (!search || search.q !== q);

  // Search, debounced.
  useEffect(() => {
    if (q.length < 2) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      api
        .searchCategories(connectionId, q)
        .then((data) => {
          if (!cancelled) setSearch({ q, results: data.results });
        })
        .catch(() => {
          if (!cancelled) setSearch({ q, results: [] });
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [connectionId, q]);

  const rowClass =
    "flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm hover:bg-[var(--color-paper)] disabled:opacity-60";

  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          className="input"
          placeholder="Search categories, e.g. coin holder"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm shrink-0">
          Back
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-[var(--color-danger)]">{error}</p>}

      <div className="mt-3 max-h-[52vh] overflow-y-auto pr-1">
        {results !== null ? (
          <>
            <p className="label mb-1">{searching ? "Searching…" : `${results.length} match${results.length === 1 ? "" : "es"}`}</p>
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                disabled={!r.leaf}
                onClick={() => onPick({ id: r.id, path: pathOf(r, []) })}
                className={rowClass}
                title={r.leaf ? undefined : "Not a final category"}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-[var(--color-ink)]">{r.name}</span>
                  <span className="block truncate text-xs text-[var(--color-muted)]">{(r.path || []).join(" › ")}</span>
                </span>
                <span className="shrink-0 text-xs text-[var(--color-muted)]">{r.leaf ? "Select" : "Has sub-categories"}</span>
              </button>
            ))}
          </>
        ) : (
          <>
            {suggestions.length > 0 && trail.length === 0 && (
              <div className="mb-3">
                <p className="label mb-1">eBay suggests</p>
                {suggestions.map((s) => (
                  <button key={s.id} type="button" onClick={() => onPick({ id: s.id, path: s.path })} className={rowClass}>
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-[var(--color-ink)]">{s.name}</span>
                      <span className="block truncate text-xs text-[var(--color-muted)]">{s.path.join(" › ")}</span>
                    </span>
                    <span className="shrink-0 text-xs text-[var(--color-muted)]">Select</span>
                  </button>
                ))}
              </div>
            )}

            <div className="mb-1 flex flex-wrap items-center gap-1 text-xs">
              <button type="button" onClick={() => setTrail([])} className={`rounded-full px-2 py-0.5 ${trail.length ? "text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]" : "font-semibold text-[var(--color-ink)]"}`}>
                All categories
              </button>
              {trail.map((crumb, i) => (
                <span key={crumb.id} className="flex items-center gap-1">
                  <span className="text-[var(--color-line-strong)]">›</span>
                  <button
                    type="button"
                    onClick={() => setTrail(trail.slice(0, i + 1))}
                    className={`rounded-full px-2 py-0.5 ${i === trail.length - 1 ? "font-semibold text-[var(--color-ink)]" : "text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]"}`}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
            {loadingChildren ? (
              <p className="px-3 py-2 text-sm text-[var(--color-muted)]">Loading…</p>
            ) : (
              children.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => (c.leaf ? onPick({ id: c.id, path: [...trail.map((t) => t.name), c.name] }) : setTrail([...trail, { id: c.id, name: c.name }]))}
                  className={rowClass}
                >
                  <span className="font-medium text-[var(--color-ink)]">{c.name}</span>
                  <span className="shrink-0 text-xs text-[var(--color-muted)]">{c.leaf ? "Select" : `${c.childCount} ›`}</span>
                </button>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Mounted only while open (the parent renders it conditionally), so its
// working copy of the selection starts fresh each time it's opened. Item
// categories only: the Shop's own departments are a different thing with
// their own dialog (ShopCategoryPicker).
export function CategoryPicker({
  connectionId,
  value,
  suggestions,
  onApply,
  onClose,
}: {
  connectionId: string;
  value: CategorySelection;
  suggestions: CategorySuggestion[];
  onApply: (next: CategorySelection) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CategorySelection>(value);
  const [editing, setEditing] = useState<Slot | null>(null);
  const rowClass = "flex items-center justify-between gap-4 border-b border-[var(--color-line)] py-3";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="w-full max-w-xl rounded-2xl bg-[var(--color-panel)] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-[var(--color-ink)]">{editing ? (editing === "primary" ? "Choose the item category" : "Choose a second category") : "Item category"}</h2>
          {!editing && (
            <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
              Close
            </button>
          )}
        </div>

        {editing ? (
          <div className="mt-4">
            <CategoryBrowser
              connectionId={connectionId}
              suggestions={suggestions}
              onCancel={() => setEditing(null)}
              onPick={(node) => {
                if (editing === "primary") setDraft({ ...draft, categoryId: node.id, categoryPath: node.path });
                else setDraft({ ...draft, secondaryCategoryId: node.id, secondaryCategoryPath: node.path });
                setEditing(null);
              }}
            />
          </div>
        ) : (
          <>
            <div className="mt-2">
              <div className={rowClass}>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--color-ink)]">First category</p>
                  <p className="truncate text-sm text-[var(--color-primary)]">{draft.categoryPath.join(" › ") || "Not set"}</p>
                </div>
                <button type="button" onClick={() => setEditing("primary")} className="btn btn-secondary btn-sm shrink-0">
                  Edit
                </button>
              </div>
              <div className={rowClass}>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--color-ink)]">Second category</p>
                  <p className="text-xs text-[var(--color-muted)]">Fees may apply whether or not the item sells.</p>
                  <p className="truncate text-sm text-[var(--color-primary)]">{draft.secondaryCategoryPath.join(" › ") || "None"}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {draft.secondaryCategoryId && (
                    <button type="button" onClick={() => setDraft({ ...draft, secondaryCategoryId: null, secondaryCategoryPath: [] })} className="btn btn-ghost btn-sm">
                      Remove
                    </button>
                  )}
                  <button type="button" onClick={() => setEditing("secondary")} className="btn btn-secondary btn-sm">
                    {draft.secondaryCategoryId ? "Edit" : "Add"}
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
                Cancel
              </button>
              <button type="button" onClick={() => onApply(draft)} disabled={!draft.categoryId} className="btn btn-primary btn-sm">
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Turns a stored "/Department/Sub" path into "Department › Sub".
export function shopCategoryLabel(path: string) {
  return path.replace(/^\//, "").split("/").join(" › ");
}

// The seller's own eBay Shop departments — up to two per listing. Loaded
// once per connection by the page (they're cached server-side) and passed
// in, so the dialog opens ready.
export function ShopCategoryPicker({
  value,
  categories,
  hasStore,
  note,
  onApply,
  onClose,
  onRefresh,
  onCreate,
}: {
  value: string[];
  categories: StoreCategory[];
  // false: no eBay Shop subscription; null: the read failed (see `note`).
  hasStore: boolean | null;
  note: string | null;
  onApply: (names: string[]) => void;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onCreate: (input: { name: string; parentId?: string }) => Promise<StoreCategory | null>;
}) {
  const [names, setNames] = useState<string[]>(value);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => storePaths(categories), [categories]);
  const topLevel = useMemo(() => categories.map((c) => ({ id: c.id, name: c.name })), [categories]);
  const rowClass = "flex items-center justify-between gap-4 border-b border-[var(--color-line)] py-3";

  const status = note
    ? note
    : hasStore === false
      ? "This account has no eBay Shop subscription, so it has no departments. Departments need a Shop (Seller Hub › Subscriptions)."
      : options.length
        ? "File the listing under your own eBay Shop departments, so buyers browsing your Shop find it."
        : "This Shop has no departments yet. Create the first one below.";

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      await onRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach eBay. Try again.");
    } finally {
      setRefreshing(false);
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const created = await onCreate({ name, ...(newParent ? { parentId: newParent } : {}) });
      setNewName("");
      // The new department is selected in the first free slot straight away.
      if (created) {
        const parent = newParent ? categories.find((c) => c.id === newParent) : null;
        const path = `${parent ? `/${parent.name}` : ""}/${created.name}`;
        setNames((current) => (current.length < 2 && !current.includes(path) ? [...current, path] : current));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "eBay didn't accept that department. Try again.");
    } finally {
      setCreating(false);
    }
  }

  function select(index: 0 | 1) {
    const current = names[index] || "";
    return (
      <select
        className="input input-sm max-w-[60%]"
        value={current}
        disabled={!options.length}
        onChange={(e) => {
          const next = [...names];
          if (e.target.value) next[index] = e.target.value;
          else next.splice(index, 1);
          setNames(next.filter(Boolean).slice(0, 2));
        }}
      >
        <option value="">{options.length ? "None" : "No Shop categories"}</option>
        {options.map((o) => (
          <option key={o.path} value={o.path}>
            {`${"\u00a0\u00a0".repeat(o.depth)}${o.label}`}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="w-full max-w-xl rounded-2xl bg-[var(--color-panel)] p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-[var(--color-ink)]">Shop category</h2>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
            Close
          </button>
        </div>
        <div className="mt-1 flex items-start justify-between gap-3">
          <p className="text-xs text-[var(--color-muted)]">{status}</p>
          <button type="button" onClick={refresh} disabled={refreshing} className="btn btn-ghost btn-sm flex-shrink-0" title="Re-read the departments from eBay">
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {error && <p className="mt-2 text-xs font-medium text-[var(--color-danger)]">{error}</p>}
        <div className="mt-2">
          <div className={rowClass}>
            <p className="text-sm font-semibold text-[var(--color-ink)]">First category</p>
            {select(0)}
          </div>
          <div className={rowClass}>
            <p className="text-sm font-semibold text-[var(--color-ink)]">Second category</p>
            {select(1)}
          </div>
        </div>
        {hasStore !== false && (
          <div className="mt-4 rounded-xl border border-dashed border-[var(--color-line)] p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">New department</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={newName}
                maxLength={35}
                placeholder="e.g. Bathroom"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    create();
                  }
                }}
                className="input input-sm min-w-0 flex-1"
              />
              <select className="input input-sm max-w-[45%]" value={newParent} onChange={(e) => setNewParent(e.target.value)} title="Where to put it">
                <option value="">Top level</option>
                {topLevel.map((c) => (
                  <option key={c.id} value={c.id}>
                    Under {c.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={create} disabled={creating || !newName.trim()} className="btn btn-secondary btn-sm">
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-[var(--color-muted)]">Created in your eBay Shop itself, so it shows on eBay too.</p>
          </div>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
            Cancel
          </button>
          <button type="button" onClick={() => onApply(names)} className="btn btn-primary btn-sm">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
