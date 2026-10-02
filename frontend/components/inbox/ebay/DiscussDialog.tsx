"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiError, ChatConversation, ChatPerson, inboxApi } from "@/lib/api";
import { Modal } from "../ChatDialogs";
import { PersonAvatar } from "../PersonAvatar";
import { LockIcon } from "../ChatThread";

// "Discuss with team": a buyer's eBay conversation shared into team chat
// as a card (who, the item, the last line), with a word about it. The
// team talks it over there; the buyer never sees any of it. The card opens
// the conversation in that account's Inbox for whoever has the Inbox there
// (locked for anyone else). Sent to a channel, a group or a direct message
// (made if it's the first).

type Target = { kind: "conversation"; c: ChatConversation } | { kind: "person"; p: ChatPerson };

export function DiscussDialog({ connectionId, conversationId, buyer, me, onClose }: { connectionId: string; conversationId: string; buyer: string; me: string | null; onClose: () => void }) {
  const [conversations, setConversations] = useState<ChatConversation[] | null>(null);
  const [people, setPeople] = useState<ChatPerson[]>([]);
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    inboxApi
      .chatList()
      .then((d) => setConversations(d.conversations.filter((c) => !c.archived)))
      .catch(() => setConversations([]));
    inboxApi
      .chatPeople()
      .then((r) => setPeople(r.people))
      .catch(() => {});
  }, []);

  // Where it can go: channels and groups you're in, then everyone in the team (their direct message).
  const options = useMemo(() => {
    const words = q.trim().toLowerCase();
    const match = (s: string) => !words || s.toLowerCase().includes(words);
    const rooms: Target[] = (conversations || []).filter((c) => c.kind !== "dm" && match(c.title)).map((c) => ({ kind: "conversation", c }));
    const folks: Target[] = people.filter((p) => p.id !== me && !p.removed && match(`${p.name} ${p.email}`)).map((p) => ({ kind: "person", p }));
    return [...rooms, ...folks];
  }, [conversations, people, q, me]);
  const keyOf = (t: Target) => (t.kind === "conversation" ? `c:${t.c.id}` : `p:${t.p.id}`);

  async function share() {
    if (!target) return;
    setSending(true);
    setError(null);
    try {
      const chat = target.kind === "conversation" ? target.c : await inboxApi.chatOpenDm(target.p.id);
      await inboxApi.chatSend(chat.id, { body: note.trim(), refs: [{ kind: "conversation", id: conversationId, connectionId }] });
      setSentTo(chat.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't share it. Try again.");
    } finally {
      setSending(false);
    }
  }

  if (sentTo) {
    return (
      <Modal title="Discuss with team" onClose={onClose}>
        <div className="px-5 py-5 text-center">
          <p className="text-[14px] font-semibold text-[var(--color-ink)]">Shared with your team</p>
          <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">The conversation with {buyer} is in team chat as a card. {buyer} doesn&apos;t see any of it.</p>
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">
              Done
            </button>
            <a href={`/inbox?c=${sentTo}`} target="_blank" rel="noopener" className="btn btn-primary btn-sm">
              Open team chat
            </a>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Discuss with team" onClose={onClose}>
      <div className="space-y-3 px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-[var(--color-muted)]">Share the conversation with {buyer} in team chat to talk it over. {buyer} won&apos;t see it.</p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a channel, group or person" className="input input-sm" aria-label="Find a channel, group or person" autoFocus />
        <div className="max-h-[260px] overflow-y-auto rounded-xl border border-[var(--color-line)]">
          {!conversations ? (
            <p className="px-3 py-3 text-[12.5px] text-[var(--color-muted)]">Loading…</p>
          ) : options.length === 0 ? (
            <p className="px-3 py-3 text-[12.5px] text-[var(--color-muted)]">Nothing matches.</p>
          ) : (
            options.map((t) => {
              const on = target && keyOf(target) === keyOf(t);
              return (
                <button key={keyOf(t)} type="button" onClick={() => setTarget(t)} className={`flex w-full items-center gap-3 border-b border-[var(--color-line)] px-3 py-2 text-left last:border-b-0 ${on ? "bg-[var(--color-primary-soft)]" : "hover:bg-[var(--color-paper)]"}`}>
                  {t.kind === "person" ? (
                    <PersonAvatar id={t.p.id} name={t.p.name} avatarUrl={t.p.avatarUrl} size={30} online={t.p.online} />
                  ) : (
                    <span className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-[13px] font-bold text-[var(--color-primary)]">{t.c.kind === "channel" ? t.c.private ? <LockIcon className="h-3.5 w-3.5" /> : "#" : t.c.members.length}</span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-[var(--color-ink)]">{t.kind === "person" ? t.p.name : t.c.kind === "channel" ? t.c.title.slice(1) : t.c.title}</span>
                    <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{t.kind === "person" ? "Direct message" : t.c.kind === "channel" ? "Channel" : "Group"}</span>
                  </span>
                  {on && (
                    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-[var(--color-primary)]" aria-hidden>
                      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              );
            })
          )}
        </div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} placeholder="Add a message (optional)" className="input min-h-[64px] resize-none py-2 text-[13px]" aria-label="Add a message" />
        {error && <p className="text-[12px] text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">
            Cancel
          </button>
          <button type="button" onClick={share} disabled={!target || sending} className="btn btn-primary btn-sm">
            {sending ? "Sharing…" : "Share"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
