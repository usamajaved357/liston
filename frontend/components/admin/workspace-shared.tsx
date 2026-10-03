"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Alert } from "@/components/Alert";

// The pieces the admin's Workspaces page and a workspace's own page share:
// a workspace's face (its initials), its status, and deleting it.

export type WorkspaceStatus = "pending" | "active" | "rejected";

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function initials(name: string | null | undefined, email: string) {
  const parts = (name || email).trim().split(/[\s@._'-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}

// A soft tint per workspace, from its id, so rows are told apart at a glance.
const TINTS = [
  "bg-indigo-50 text-indigo-600 ring-indigo-100",
  "bg-sky-50 text-sky-600 ring-sky-100",
  "bg-emerald-50 text-emerald-600 ring-emerald-100",
  "bg-amber-50 text-amber-700 ring-amber-100",
  "bg-violet-50 text-violet-600 ring-violet-100",
  "bg-rose-50 text-rose-600 ring-rose-100",
  "bg-teal-50 text-teal-600 ring-teal-100",
];
const tintOf = (id: string) => TINTS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % TINTS.length];

/** A workspace's initials (its name's, else its owner's) in a rounded square. */
export function WorkspaceFace({ id, name, email, size = 40 }: { id: string; name: string | null; email: string; size?: number }) {
  return (
    <span
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      className={`flex flex-shrink-0 items-center justify-center rounded-[30%] font-semibold ring-1 ring-inset ${tintOf(id)}`}
      aria-hidden
    >
      {initials(name, email)}
    </span>
  );
}

const STATUS: Record<WorkspaceStatus, { label: string; look: string; dot: string }> = {
  active: { label: "Active", look: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
  pending: { label: "Waiting", look: "bg-amber-50 text-amber-800 ring-amber-200", dot: "bg-amber-500" },
  rejected: { label: "Revoked", look: "bg-rose-50 text-rose-700 ring-rose-200", dot: "bg-rose-500" },
};

export function StatusChip({ status }: { status: WorkspaceStatus }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex h-6 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-semibold ring-1 ring-inset ${s.look}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

export function AdminChip() {
  return <span className="inline-flex h-6 items-center rounded-full bg-slate-100 px-2.5 text-[11.5px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">Admin</span>;
}

export type DeletableWorkspace = { id: string; email: string; name: string | null; team_name: string | null; accounts: number; logins_only_here: number; other_workspaces: number };

/**
 * Deleting a workspace account: what goes with it, spelled out, and its
 * email typed to be sure. Can't be undone.
 */
export function DeleteWorkspaceDialog({ account, onCancel, onDeleted }: { account: DeletableWorkspace | null; onCancel: () => void; onDeleted: (id: string) => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!account) return null;
  const matches = typed.trim().toLowerCase() === account.email.toLowerCase();
  const goes = [
    `The workspace "${account.team_name || "Untitled"}" and everything in it`,
    account.accounts ? `${plural(account.accounts, "eBay account")}, with their listings, orders and messages in Liston` : null,
    account.logins_only_here ? `${plural(account.logins_only_here, "member login")} in no other workspace` : null,
    account.other_workspaces ? `The owner's place in ${plural(account.other_workspaces, "other workspace")}` : null,
  ].filter(Boolean) as string[];

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteWorkspaceAccount(account!.id, typed.trim());
      onDeleted(account!.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete the workspace. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.45)] p-4" onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="card w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6">
        <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Delete {account.team_name || "this workspace"}?</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-muted)]">
          {`${account.name || account.email}'s login goes, and with it:`}
        </p>
        <ul className="mt-2.5 space-y-1.5 rounded-xl bg-rose-50/60 px-4 py-3 text-[12.5px] leading-relaxed text-[var(--color-ink)] ring-1 ring-inset ring-rose-100">
          {goes.map((line) => (
            <li key={line} className="flex gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-rose-400" aria-hidden />
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12.5px] text-[var(--color-muted)]">This can&apos;t be undone. The email is free again afterwards, for a new sign-up or invitation.</p>
        <label className="mt-4 block text-[12.5px] font-medium text-[var(--color-ink)]" htmlFor="del-email">
          Type <span className="break-all font-semibold">{account.email}</span> to confirm
        </label>
        <input id="del-email" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus className="input mt-1.5" />
        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">
            Cancel
          </button>
          <button type="button" onClick={remove} disabled={!matches || busy} className="btn btn-sm bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50">
            {busy ? "Deleting…" : "Delete workspace"}
          </button>
        </div>
      </div>
    </div>
  );
}
