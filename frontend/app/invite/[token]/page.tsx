"use client";

import { useEffect, useState, FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, InvitePage } from "@/lib/api";
import { AuthLayout } from "@/components/AuthLayout";
import { Field } from "@/components/Field";
import { PasswordField } from "@/components/PasswordField";
import { PasswordInput } from "@/components/PasswordInput";
import { LinesSkeleton } from "@/components/Skeleton";
import { Alert } from "@/components/Alert";
import { offerToSaveLogin } from "@/lib/savedLogin";
import { formatShortDate } from "@/lib/format";
import { homeFor, rememberTeam } from "@/lib/team";

// The page an invitation link opens (invites.service). Someone new chooses
// their name and a password and is in; someone already on Liston joins with
// their login (one click when signed in as it, else its password); a member
// whose login is moving to this email confirms it with a password of their
// own. Whichever it is, they land signed in, in the workspace.

// Who's signed in on this browser, from the stored sign-in (its email), to offer a one-click join.
function signedInEmail(): string | null {
  try {
    const payload = localStorage.getItem("token")?.split(".")[1];
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).email || null;
  } catch {
    return null;
  }
}

// The email the invitation is for: fixed, shown rather than typed.
function FixedEmail({ label, email }: { label: string; email: string }) {
  return (
    <div>
      <span className="mb-1 block text-[13px] font-medium text-[var(--color-ink)]">{label}</span>
      <div className="flex h-11 items-center gap-2 rounded-xl bg-[var(--color-paper)] px-3.5 text-[14px] text-[var(--color-ink)] ring-1 ring-inset ring-[var(--color-line)]">
        <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 flex-shrink-0 text-[var(--color-muted)]" aria-hidden>
          <path d="M3.5 6.5l6.5 4.5 6.5-4.5M4.5 5h11a1 1 0 011 1v8a1 1 0 01-1 1h-11a1 1 0 01-1-1V6a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0 truncate">{email}</span>
      </div>
    </div>
  );
}

const ENDED: Record<Exclude<InvitePage["status"], "open">, { title: string; text: (i: InvitePage) => string }> = {
  accepted: { title: "Already accepted", text: (i) => `This invitation to ${i.workspace} has been used. Log in with ${i.email} to open it.` },
  revoked: { title: "Invitation withdrawn", text: (i) => `${i.invitedBy} withdrew this invitation. Ask them for a new one if you still need it.` },
  expired: { title: "Invitation expired", text: (i) => `This invitation to ${i.workspace} has run out. Ask ${i.invitedBy} to send it again.` },
};

export default function InvitePageView() {
  const router = useRouter();
  const { token } = useParams<{ token: string }>();
  const [invite, setInvite] = useState<InvitePage | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A new-password link emailed (an existing login they can't sign in to), and back here once it's set.
  const [linkSent, setLinkSent] = useState<"sending" | "sent" | null>(null);
  const [passwordSet, setPasswordSet] = useState(false);

  useEffect(() => {
    // Back from choosing a new password (reset-password's `next`): after the first paint, as the address says so.
    const t = setTimeout(() => setPasswordSet(new URLSearchParams(window.location.search).get("reset") === "1"), 0);
    return () => clearTimeout(t);
  }, []);

  async function emailPasswordLink() {
    setError(null);
    setLinkSent("sending");
    try {
      await api.sendInvitePasswordLink(token);
      setLinkSent("sent");
    } catch (err) {
      setLinkSent(null);
      setError(err instanceof ApiError ? err.message : "Couldn't send the link. Try again.");
    }
  }

  useEffect(() => {
    let live = true;
    api
      .getInvite(token)
      .then(({ invite: found }) => {
        if (!live) return;
        setInvite(found);
        setName(found.name || "");
        setMe(signedInEmail());
      })
      .catch((err) => live && setFailed(err instanceof ApiError ? err.message : "Couldn't open this invitation. Check your connection and try again."));
    return () => {
      live = false;
    };
  }, [token]);

  const signedInAsThem = Boolean(invite && me && me.toLowerCase() === invite.email.toLowerCase());

  async function accept(e?: FormEvent) {
    e?.preventDefault();
    if (!invite) return;
    setError(null);
    const choosing = invite.kind !== "join";
    if (choosing && password.length < 8) return setError("Choose a password of at least 8 characters.");
    if (invite.kind === "email" && password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    try {
      const joinsSignedIn = invite.kind === "join" && signedInAsThem && !usePassword;
      const { user, token: session } = await api.acceptInvite(token, {
        ...(invite.kind === "new" && name.trim() ? { name: name.trim() } : {}),
        ...(joinsSignedIn ? {} : { password }),
      });
      try {
        localStorage.setItem("token", session);
        localStorage.removeItem("liston:me");
      } catch {}
      // The workspace they joined, named on every request from here.
      rememberTeam(user.team?.id || null);
      if (!joinsSignedIn) await offerToSaveLogin(user.email, password, user.name || undefined);
      router.replace(homeFor(user.role));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
      setBusy(false);
    }
  }

  const footer = (
    <>
      Already set up?{" "}
      <Link href="/login" className="font-medium text-[var(--color-accent)] hover:underline">
        Log in
      </Link>
    </>
  );

  if (failed) {
    return (
      <AuthLayout eyebrow="Liston" title="This link doesn't work" subtitle="It may have been copied only in part." footer={footer}>
        <Alert>{failed}</Alert>
      </AuthLayout>
    );
  }

  if (!invite) {
    return (
      <AuthLayout eyebrow="Liston" title="Opening your invitation" subtitle="One moment." footer={footer}>
        <LinesSkeleton count={4} />
      </AuthLayout>
    );
  }

  if (invite.status !== "open") {
    const ended = ENDED[invite.status];
    return (
      <AuthLayout eyebrow={invite.workspace} title={ended.title} subtitle={ended.text(invite)} footer={footer}>
        <Link href="/login" className="btn btn-primary w-full">
          Go to log in
        </Link>
      </AuthLayout>
    );
  }

  if (invite.kind === "email") {
    // The same address: confirming the email they have; another: their login moving to it.
    const moving = Boolean(invite.currentEmail && invite.currentEmail.toLowerCase() !== invite.email.toLowerCase());
    return (
      <AuthLayout
        eyebrow={invite.workspace}
        title="Confirm your email"
        subtitle={moving ? `${invite.invitedBy} asked for your Liston login to use this email. Choose your own password to finish.` : `${invite.invitedBy} asked you to confirm the email you sign in to Liston with. Choose your own password to finish: only you will know it.`}
        footer={footer}
      >
        <form onSubmit={accept} method="post" action="/invite" className="space-y-3.5">
          {moving && (
            <p className="rounded-xl bg-[var(--color-paper)] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)]">
              You sign in as <span className="break-all font-medium text-[var(--color-ink)]">{invite.currentEmail}</span>{" "}now. From now on it&apos;s the email below, with the password you choose here.
            </p>
          )}
          <FixedEmail label="Your email" email={invite.email} />
          <input type="hidden" name="email" value={invite.email} autoComplete="username" />
          <PasswordField label="Your password" name="new-password" value={password} onChange={setPassword} autoComplete="new-password" required showCriteria />
          <PasswordField label="Confirm the password" name="confirm-password" value={confirm} onChange={setConfirm} autoComplete="new-password" required />
          {error && <Alert>{error}</Alert>}
          <button type="submit" disabled={busy} className="btn btn-primary w-full">
            {busy ? "Confirming…" : "Confirm email"}
          </button>
        </form>
      </AuthLayout>
    );
  }

  const title = `Join ${invite.workspace}`;
  const subtitle = `${invite.invitedBy} invited you to work in ${invite.workspace} on Liston.`;

  if (invite.kind === "new") {
    return (
      <AuthLayout eyebrow="Invitation" title={title} subtitle={subtitle} footer={footer}>
        <form onSubmit={accept} method="post" action="/invite" className="space-y-3.5">
          <FixedEmail label="Your email" email={invite.email} />
          <input type="hidden" name="email" value={invite.email} autoComplete="username" />
          <Field label="Your name" type="text" name="name" value={name} onChange={setName} autoComplete="name" required />
          <PasswordField label="Choose a password" name="new-password" value={password} onChange={setPassword} autoComplete="new-password" required showCriteria />
          {error && <Alert>{error}</Alert>}
          <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary w-full">
            {busy ? "Joining…" : "Create my login and join"}
          </button>
          <p className="text-center text-[12px] leading-relaxed text-[var(--color-muted)]">Only you know this password. You sign in with this email and it from now on.</p>
        </form>
      </AuthLayout>
    );
  }

  // Already on Liston: one click when signed in as this email, else its password.
  if (signedInAsThem && !usePassword) {
    return (
      <AuthLayout eyebrow="Invitation" title={title} subtitle={subtitle} footer={footer}>
        <div className="space-y-3.5">
          <FixedEmail label="You're signed in as" email={invite.email} />
          {error && <Alert>{error}</Alert>}
          <button type="button" onClick={() => accept()} disabled={busy} className="btn btn-primary w-full">
            {busy ? "Joining…" : `Join ${invite.workspace}`}
          </button>
          <p className="text-center text-[12px] text-[var(--color-muted)]">
            It joins your workspace list; switch between them from the rail.{" "}
            <button type="button" onClick={() => setUsePassword(true)} className="font-medium text-[var(--color-accent)] hover:underline">
              Use the password instead
            </button>
          </p>
        </div>
      </AuthLayout>
    );
  }

  // The email already has a Liston login (made by them before, maybe long ago): its password, or a new one by email.
  return (
    <AuthLayout eyebrow="Invitation" title={title} subtitle={subtitle} footer={footer}>
      <form onSubmit={accept} method="post" action="/invite" className="space-y-3.5">
        {me && !signedInAsThem && (
          <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-amber-800 ring-1 ring-inset ring-amber-200">
            You&apos;re signed in as <span className="break-all font-medium">{me}</span>. This invitation is for the email below, so joining signs you in as it.
          </p>
        )}
        {passwordSet ? (
          <Alert variant="success">Your new password is set. Enter it below to join {invite.workspace}.</Alert>
        ) : (
          <div className="rounded-xl bg-[var(--color-paper)] px-3.5 py-3 text-[12.5px] leading-relaxed text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)]">
            <span className="font-semibold text-[var(--color-ink)]">This email already has a Liston login</span>
            {invite.loginSince ? `, made ${formatShortDate(invite.loginSince)}` : ""}. You join with its password; you don&apos;t make a new one.
          </div>
        )}
        <FixedEmail label="Your Liston login" email={invite.email} />
        <input type="hidden" name="email" value={invite.email} autoComplete="username" />
        <div>
          <span className="mb-1.5 block text-sm font-medium text-[var(--color-ink)]">Its password</span>
          <PasswordInput name="password" value={password} onChange={setPassword} autoComplete="current-password" required />
        </div>
        {error && <Alert>{error}</Alert>}
        <button type="submit" disabled={busy || !password} className="btn btn-primary w-full">
          {busy ? "Joining…" : `Join ${invite.workspace}`}
        </button>
        {/* Don't know it: a new one chosen from a link sent to this email (only its owner opens it), then back here. */}
        <div className="rounded-xl border border-dashed border-[var(--color-line-strong)] px-3.5 py-3 text-center">
          {linkSent === "sent" ? (
            <p className="text-[12.5px] leading-relaxed text-[var(--color-ink)]">
              Check <span className="break-all font-semibold">{invite.email}</span>. The link there lets you choose a new password and brings you back here to join. It works for an hour.
            </p>
          ) : (
            <>
              <p className="text-[12.5px] text-[var(--color-muted)]">Don&apos;t know this login&apos;s password?</p>
              <button type="button" onClick={emailPasswordLink} disabled={linkSent === "sending"} className="mt-1 text-[13px] font-semibold text-[var(--color-accent)] hover:underline disabled:opacity-60">
                {linkSent === "sending" ? "Sending…" : "Email me a link to set a new one"}
              </button>
            </>
          )}
        </div>
      </form>
    </AuthLayout>
  );
}
