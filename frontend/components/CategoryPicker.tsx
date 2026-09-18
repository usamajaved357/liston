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
// working copy of the selection starts fresh each time it's opened.
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
  const [store, setStore] = useState<{ categories: StoreCategory[]; note: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getStoreCategories(connectionId)
      .then((data) => {
        if (!cancelled) setStore({ categories: data.categories, note: data.unavailable || null });
      })
      .catch(() => {
        if (!cancelled) setStore({ categories: [], note: null });
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const storeOptions = useMemo(() => storePaths(store?.categories || []), [store]);
  const storeNote = store?.note || null;

  const rowClass = "flex items-center justify-between gap-4 border-b border-[var(--color-line)] py-3";

  function storeSelect(index: 0 | 1) {
    const current = draft.storeCategoryNames[index] || "";
    return (
      <select
        className="input input-sm max-w-[60%]"
        value={current}
        disabled={!storeOptions.length}
        onChange={(e) => {
          const names = [...draft.storeCategoryNames];
          if (e.target.value) names[index] = e.target.value;
          else names.splice(index, 1);
          setDraft({ ...draft, storeCategoryNames: names.filter(Boolean).slice(0, 2) });
        }}
      >
        <option value="">{storeOptions.length ? "None" : "No Shop categories"}</option>
        {storeOptions.map((o) => (
          <option key={o.path} value={o.path}>
            {`${"  ".repeat(o.depth)}${o.label}`}
          </option>
        ))}
      </select>
    );
  }

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
                  Change
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
                    {draft.secondaryCategoryId ? "Change" : "Add"}
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-5">
              <h3 className="text-base font-bold text-[var(--color-ink)]">Shop category</h3>
              <p className="text-xs text-[var(--color-muted)]">
                {storeNote ? storeNote : "If you have an eBay Shop, file the listing under your own departments."}
              </p>
              <div className={rowClass}>
                <p className="text-sm font-semibold text-[var(--color-ink)]">First category</p>
                {store === null ? <span className="text-xs text-[var(--color-muted)]">Loading…</span> : storeSelect(0)}
              </div>
              <div className={rowClass}>
                <p className="text-sm font-semibold text-[var(--color-ink)]">Second category</p>
                {store === null ? <span className="text-xs text-[var(--color-muted)]">Loading…</span> : storeSelect(1)}
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
