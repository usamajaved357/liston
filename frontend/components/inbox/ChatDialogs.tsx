"use client";

import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { api, ApiError, ChatConversation, ChatNotify, ChatOpenChannel, ChatPerson, Connection, inboxApi } from "@/lib/api";
import { PillTabs } from "@/components/PillTabs";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PersonAvatar } from "./PersonAvatar";
import { LockIcon } from "./ChatThread";

// Team chat's dialogs: a new direct message or group, a new (or changed)
// channel, the public channels to join, and a conversation's details (its
// people, your notifications for it, and its settings for whoever runs it).

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`flex max-h-[90dvh] w-full flex-col rounded-t-2xl bg-[var(--color-panel)] shadow-2xl sm:rounded-2xl ${wide ? "sm:max-w-lg" : "sm:max-w-md"}`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[var(--color-line)] px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)]">
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
              <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Pick people from the team (search by name or email). */
function PeoplePicker({ people, picked, onChange, exclude = [] }: { people: ChatPerson[]; picked: string[]; onChange: (ids: string[]) => void; exclude?: string[] }) {
  const [q, setQ] = useState("");
  const shown = people.filter((p) => !exclude.includes(p.id) && (!q.trim() || `${p.name} ${p.email}`.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your team" className="input input-sm mb-2" aria-label="Search your team" />
      <div className="max-h-[300px] overflow-y-auto rounded-xl border border-[var(--color-line)]">
        {shown.length === 0 && <p className="px-3 py-3 text-[12.5px] text-[var(--color-muted)]">{people.length <= 1 ? "Add people on the Team page to chat with them." : "Nobody matches."}</p>}
        {shown.map((p) => {
          const on = picked.includes(p.id);
          return (
            <label key={p.id} className={`flex cursor-pointer items-center gap-3 border-b border-[var(--color-line)] px-3 py-2 last:border-b-0 ${on ? "bg-[var(--color-primary-soft)]" : "hover:bg-[var(--color-paper)]"}`}>
              <input type="checkbox" checked={on} onChange={() => onChange(on ? picked.filter((id) => id !== p.id) : [...picked, p.id])} className="h-4 w-4 accent-[var(--color-primary)]" />
              <PersonAvatar id={p.id} name={p.name} avatarUrl={p.avatarUrl} size={30} online={p.online} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[var(--color-ink)]">
                  {p.name}
                  {p.role === "owner" && <span className="ml-1.5 text-[11px] font-normal text-[var(--color-muted)]">Owner</span>}
                </span>
                <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{p.email}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** A direct message (one person) or a group (two to seven others). */
export function NewChatDialog({ me, people, onClose, onOpened }: { me: string; people: ChatPerson[]; onClose: () => void; onOpened: (c: ChatConversation) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start(e: FormEvent) {
    e.preventDefault();
    if (!picked.length) return;
    setBusy(true);
    setError(null);
    try {
      onOpened(picked.length === 1 ? await inboxApi.chatOpenDm(picked[0]) : await inboxApi.chatCreateGroup(picked, name.trim() || null));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start it. Try again.");
      setBusy(false);
    }
  }
  const tooMany = picked.length > 7;
  return (
    <Modal title="New message" onClose={onClose}>
      <form onSubmit={start} className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4">
        <p className="text-[12.5px] text-[var(--color-muted)]">One person for a direct message, or up to seven for a group.</p>
        <PeoplePicker people={people} picked={picked} onChange={setPicked} exclude={[me]} />
        {picked.length > 1 && !tooMany && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name the group (optional)" maxLength={80} className="input input-sm" aria-label="Group name" />}
        {tooMany && <p className="notice notice-warning text-[12.5px]">A group is up to 8 people. For more, ask the owner for a channel.</p>}
        {error && <p className="notice notice-danger text-[12.5px]">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
            Cancel
          </button>
          <button type="submit" disabled={!picked.length || busy || tooMany} className="btn btn-primary btn-sm">
            {busy ? "Opening…" : picked.length > 1 ? `Start group of ${picked.length + 1}` : "Message"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function useAccounts() {
  const [accounts, setAccounts] = useState<Connection[]>([]);
  useEffect(() => {
    api.listConnections().then((r) => setAccounts(r.connections || [])).catch(() => {});
  }, []);
  return accounts;
}

/** Making a channel, or changing one (its name, topic, who can see it, the account it's about). */
export function ChannelDialog({ me, people, channel, onClose, onSaved }: { me: string; people: ChatPerson[]; channel?: ChatConversation | null; onClose: () => void; onSaved: (c: ChatConversation) => void }) {
  const accounts = useAccounts();
  const [name, setName] = useState(channel?.name || "");
  const [topic, setTopic] = useState(channel?.topic || "");
  const [isPrivate, setPrivate] = useState(channel?.private || false);
  const [account, setAccount] = useState(channel?.account?.id || "");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = name.trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-_]/g, "");
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = { name, topic: topic.trim() || null, private: isPrivate, connectionId: account || null };
      onSaved(channel ? await inboxApi.chatUpdate(channel.id, input) : await inboxApi.chatCreateChannel({ ...input, userIds: picked }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save it. Try again.");
      setBusy(false);
    }
  }
  return (
    <Modal title={channel ? "Channel settings" : "New channel"} onClose={onClose} wide>
      <form onSubmit={save} className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-5 py-4">
        <label className="block">
          <span className="label">Name</span>
          <div className="relative">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[14px] text-[var(--color-muted)]">#</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="flipx-orders" maxLength={60} required className="input !pl-7" autoFocus />
          </div>
          {preview && preview !== name && <span className="mt-1 block text-[11.5px] text-[var(--color-muted)]">Will be #{preview}</span>}
        </label>
        <label className="block">
          <span className="label">Topic (optional)</span>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What it's for" maxLength={250} className="input" />
        </label>
        <label className="block">
          <span className="label">About one account (optional)</span>
          <select value={account} onChange={(e) => setAccount(e.target.value)} className="input">
            <option value="">No particular account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--color-line)] px-3 py-2.5">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
          <span>
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-ink)]">
              <LockIcon className="h-3.5 w-3.5" /> Private
            </span>
            <span className="block text-[12px] text-[var(--color-muted)]">Only the people in it see it. A public channel anyone in the team can find and join.</span>
          </span>
        </label>
        {!channel && (
          <div>
            <span className="label">People to add</span>
            <PeoplePicker people={people} picked={picked} onChange={setPicked} exclude={[me]} />
          </div>
        )}
        {error && <p className="notice notice-danger text-[12.5px]">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
            Cancel
          </button>
          <button type="submit" disabled={busy || !preview} className="btn btn-primary btn-sm">
            {busy ? "Saving…" : channel ? "Save" : "Make channel"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The team's public channels you aren't in. */
export function BrowseChannelsDialog({ channels, onClose, onJoined, canManage, onNew }: { channels: ChatOpenChannel[]; onClose: () => void; onJoined: (c: ChatConversation) => void; canManage: boolean; onNew: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function join(id: string) {
    setBusy(id);
    setError(null);
    try {
      onJoined(await inboxApi.chatJoin(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't join it.");
      setBusy(null);
    }
  }
  return (
    <Modal title="Channels to join" onClose={onClose}>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-5 py-4">
        {channels.length === 0 && <p className="text-[13px] text-[var(--color-muted)]">You&apos;re in every public channel.</p>}
        {channels.map((c) => (
          <div key={c.id} className="flex items-center gap-3 rounded-xl border border-[var(--color-line)] px-3 py-2.5">
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--color-paper)] text-[15px] font-bold text-[var(--color-muted)]">#</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium text-[var(--color-ink)]">
                {c.name}
                {c.account && <span className="chip ml-2 text-[10.5px]">{c.account.label}</span>}
              </span>
              <span className="block truncate text-[12px] text-[var(--color-muted)]">{c.topic || `${c.memberCount} ${c.memberCount === 1 ? "person" : "people"}`}</span>
            </span>
            <button type="button" onClick={() => join(c.id)} disabled={busy !== null} className="btn btn-secondary btn-sm">
              {busy === c.id ? "Joining…" : "Join"}
            </button>
          </div>
        ))}
        {error && <p className="notice notice-danger text-[12.5px]">{error}</p>}
        {canManage && (
          <button type="button" onClick={onNew} className="mt-1 rounded-xl border border-dashed border-[var(--color-line)] px-3 py-2.5 text-left text-[13px] font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]">
            Make a new channel
          </button>
        )}
      </div>
    </Modal>
  );
}

/** A conversation's details: its people, your notifications for it, and (for whoever runs it) its settings. */
export function ConversationDetails({
  conversation,
  me,
  people,
  onClose,
  onChanged,
  onLeft,
  onEdit,
}: {
  conversation: ChatConversation;
  me: string;
  people: ChatPerson[];
  onClose: () => void;
  onChanged: (c: ChatConversation) => void;
  onLeft: () => void;
  onEdit: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "leave" | "delete" | "archive">(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const inIt = useMemo(() => conversation.members.map((m) => m.id), [conversation.members]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't do that just now.");
    } finally {
      setBusy(false);
    }
  }

  const notifyTabs: { key: ChatNotify; label: string }[] = [
    { key: "all", label: "Every message" },
    { key: "mentions", label: conversation.kind === "dm" ? "Every message" : "@mentions" },
    { key: "none", label: "Muted" },
  ].filter((t, i) => !(conversation.kind === "dm" && i === 1)) as { key: ChatNotify; label: string }[];

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[340px] flex-col border-l border-[var(--color-line)] bg-[var(--color-panel)] shadow-[var(--shadow-pop)]">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-3">
        <h3 className="text-[14px] font-semibold text-[var(--color-ink)]">Details</h3>
        <button type="button" onClick={onClose} aria-label="Close details" className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)]">
          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
            <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <div>
          <p className="text-[16px] font-semibold text-[var(--color-ink)]">{conversation.title}</p>
          {conversation.topic && <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">{conversation.topic}</p>}
          <p className="mt-1.5 flex flex-wrap gap-1.5">
            {conversation.kind === "channel" && <span className="chip text-[10.5px]">{conversation.private ? "Private channel" : "Public channel"}</span>}
            {conversation.account && <span className="chip text-[10.5px]">{conversation.account.label}</span>}
            {conversation.archived && <span className="chip text-[10.5px] text-[var(--color-muted)]">Archived</span>}
          </p>
        </div>

        <div>
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">Notifications</p>
          <PillTabs tabs={notifyTabs} value={conversation.notify === "mentions" && conversation.kind === "dm" ? "all" : conversation.notify} onChange={(notify) => run(async () => onChanged(await inboxApi.chatSetNotify(conversation.id, notify)))} label="Notifications" role="radiogroup" disabled={busy} />
          <p className="mt-1.5 text-[11.5px] text-[var(--color-muted)]">Your devices, the bell and the unread count. Change what&apos;s pushed everywhere in Settings.</p>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">{conversation.members.length} {conversation.members.length === 1 ? "person" : "people"}</p>
            {conversation.permissions.addPeople && !conversation.archived && (
              <button type="button" onClick={() => setAdding((v) => !v)} className="text-[12px] font-medium text-[var(--color-primary)]">
                {adding ? "Cancel" : "Add people"}
              </button>
            )}
          </div>
          {adding && (
            <div className="mb-3 space-y-2">
              <PeoplePicker people={people} picked={picked} onChange={setPicked} exclude={inIt} />
              <button
                type="button"
                disabled={!picked.length || busy}
                onClick={() =>
                  run(async () => {
                    onChanged(await inboxApi.chatAddPeople(conversation.id, picked));
                    setPicked([]);
                    setAdding(false);
                  })
                }
                className="btn btn-primary btn-sm w-full"
              >
                Add {picked.length || ""}
              </button>
            </div>
          )}
          <ul className="space-y-1">
            {conversation.members.map((m) => (
              <li key={m.id} className="flex items-center gap-2.5 rounded-lg px-1 py-1">
                <PersonAvatar id={m.id} name={m.name} avatarUrl={m.avatarUrl} size={30} online={m.online} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[var(--color-ink)]">
                    {m.name}
                    {m.id === me && <span className="ml-1 font-normal text-[var(--color-muted)]">(you)</span>}
                  </span>
                  <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{m.removed ? "No longer in the team" : m.role === "owner" ? "Owner" : m.email}</span>
                </span>
                {conversation.kind === "channel" && conversation.permissions.manage && m.id !== me && (
                  <button type="button" onClick={() => run(async () => { await inboxApi.chatRemovePerson(conversation.id, m.id); onChanged(await inboxApi.chatGet(conversation.id)); })} className="text-[11.5px] font-medium text-[var(--color-muted)] hover:text-rose-600">
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>

        {error && <p className="notice notice-danger text-[12.5px]">{error}</p>}

        <div className="space-y-1.5 border-t border-[var(--color-line)] pt-4">
          {conversation.kind === "channel" && conversation.permissions.manage && (
            <>
              <button type="button" onClick={onEdit} className="btn btn-secondary btn-sm w-full justify-start">
                Channel settings
              </button>
              <button type="button" onClick={() => (conversation.archived ? run(async () => onChanged(await inboxApi.chatUpdate(conversation.id, { archived: false }))) : setConfirm("archive"))} className="btn btn-ghost btn-sm w-full justify-start">
                {conversation.archived ? "Bring the channel back" : "Archive the channel"}
              </button>
              <button type="button" onClick={() => setConfirm("delete")} className="btn btn-danger-ghost btn-sm w-full justify-start">
                Delete the channel
              </button>
            </>
          )}
          {conversation.kind === "group" &&
            (renaming !== null ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    onChanged(await inboxApi.chatUpdate(conversation.id, { name: renaming }));
                    setRenaming(null);
                  });
                }}
                className="flex gap-1.5"
              >
                <input value={renaming} onChange={(e) => setRenaming(e.target.value)} maxLength={80} placeholder="Group name" className="input input-sm min-w-0 flex-1" autoFocus aria-label="Group name" />
                <button type="submit" disabled={busy} className="btn btn-primary btn-sm">
                  Save
                </button>
              </form>
            ) : (
              <button type="button" onClick={() => setRenaming(conversation.name || "")} className="btn btn-ghost btn-sm w-full justify-start">
                Rename the group
              </button>
            ))}
          {conversation.permissions.leave && (
            <button type="button" onClick={() => setConfirm("leave")} className="btn btn-danger-ghost btn-sm w-full justify-start">
              Leave
            </button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "delete" ? `Delete ${conversation.title}?` : confirm === "archive" ? `Archive ${conversation.title}?` : `Leave ${conversation.title}?`}
        description={
          confirm === "delete"
            ? "Everything said in it is deleted for everyone. This can't be undone."
            : confirm === "archive"
              ? "It stays readable, but nothing new can be said in it. You can bring it back."
              : conversation.private || conversation.kind === "group"
                ? "You won't see it again unless someone adds you back."
                : "You can join it again from Browse."
        }
        confirmLabel={confirm === "delete" ? "Delete" : confirm === "archive" ? "Archive" : "Leave"}
        danger={confirm !== "archive"}
        loading={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          run(async () => {
            if (confirm === "delete") {
              await inboxApi.chatDelete(conversation.id);
              onLeft();
            } else if (confirm === "archive") {
              onChanged(await inboxApi.chatUpdate(conversation.id, { archived: true }));
            } else {
              await inboxApi.chatRemovePerson(conversation.id, me);
              onLeft();
            }
            setConfirm(null);
          })
        }
      />
    </aside>
  );
}
