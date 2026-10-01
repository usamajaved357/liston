"use client";

import Link from "next/link";
import { nextVoiceSpeed, seekVoice, stopVoice, toggleVoice, useVoicePlayback, VoiceTrack } from "@/lib/voicePlayback";
import { clockOf, PlayIcon, VoiceAvatar, Waveform } from "./VoiceNote";

// The voice note playing, wherever you are in Liston: it pops up once its
// bubble is off screen (scrolled away, another conversation, another page)
// and goes when it ends, when you stop it, or when its bubble is back in
// view. On a laptop it sits at the foot of the sidebar, where it covers
// nothing (a Send or Publish button stays in reach); on a phone or tablet
// it's a slim bar under the top bar. Play / pause, the sound's shape to
// move along, the speed, stop; the name opens the conversation it's in.

/** Where it was said, under who said it: "In #orders", "Thread in #orders", "Direct message" (yours there: "To Sara Khan"). */
function whereOf(track: VoiceTrack): string {
  if (!track.place) return "Voice message";
  const { kind, title } = track.place;
  if (kind === "dm") return track.mine ? `To ${title}` : "Direct message";
  const name = kind === "channel" ? `#${title}` : title;
  return track.threadId ? `Thread in ${name}` : `In ${name}`;
}

export function NowPlaying({ variant }: { variant: "sidebar" | "bar" }) {
  const p = useVoicePlayback();
  const track = p.track;
  if (!track || p.shown) return null;

  const durationS = track.durationMs / 1000;
  const share = durationS ? Math.min(1, p.at / durationS) : 0;
  const who = track.mine ? "You" : track.author?.name || "Someone";
  const href = `/inbox?c=${track.conversationId}${track.threadId ? `&t=${track.threadId}` : ""}`;
  const time = `${clockOf(p.at * 1000)} / ${clockOf(track.durationMs)}`;

  const play = (
    <button
      type="button"
      onClick={() => toggleVoice(track)}
      aria-label={p.playing ? "Pause voice message" : "Play voice message"}
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-white transition-colors hover:bg-[var(--color-primary-hover)]"
    >
      <PlayIcon playing={p.playing} className="h-4 w-4" />
    </button>
  );
  const speed = (
    <button type="button" onClick={nextVoiceSpeed} aria-label={`Playback speed ${p.speed}x, change it`} title="Playback speed" className="h-6 min-w-[36px] flex-shrink-0 rounded-full bg-black/[0.06] px-1.5 text-[11px] font-semibold tabular-nums text-[var(--color-ink)]/80 transition-colors hover:bg-black/[0.11]">
      {p.speed}x
    </button>
  );
  const stop = (
    <button type="button" onClick={stopVoice} aria-label="Stop the voice message" title="Stop" className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
        <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </button>
  );
  const wave = (className: string) => <Waveform peaks={track.peaks} share={share} durationS={durationS} tone="theirs" ring="var(--color-panel)" onSeek={(s) => seekVoice(track, s * durationS)} onStep={(d) => seekVoice(track, p.at + d)} className={className} />;
  const title = (
    <Link href={href} title="Open the conversation" className="group block min-w-0 flex-1">
      <span className="block truncate text-[12.5px] font-semibold leading-4 text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{who}</span>
      <span className="block truncate text-[11px] leading-4 text-[var(--color-muted)]">{whereOf(track)}</span>
    </Link>
  );

  if (variant === "bar")
    return (
      <div role="region" aria-label="Voice message playing" className="flex h-12 flex-shrink-0 animate-[popUp_.18s_ease-out] items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-panel)] px-3 lg:hidden">
        {play}
        <div className="w-[30%] min-w-0 max-w-[180px]">{title}</div>
        {wave("h-5")}
        <span className="flex-shrink-0 text-[10.5px] tabular-nums text-[var(--color-muted)]">{clockOf((p.playing || p.at > 0 ? p.at : durationS) * 1000)}</span>
        {speed}
        {stop}
      </div>
    );

  return (
    <div className="flex-shrink-0 px-3 pb-3">
      <div role="region" aria-label="Voice message playing" className="animate-[popUp_.18s_ease-out] rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-2.5 shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-2">
          <VoiceAvatar author={track.author} size={32} ring="var(--color-panel)" />
          {title}
          {stop}
        </div>
        <div className="mt-2 flex items-center">
          {play}
          {wave("h-6")}
        </div>
        <div className="mt-1 flex items-center justify-between pl-[38px]">
          <span className="text-[10.5px] tabular-nums text-[var(--color-muted)]">{time}</span>
          {speed}
        </div>
      </div>
    </div>
  );
}
