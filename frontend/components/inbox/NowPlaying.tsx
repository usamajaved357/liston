"use client";

import Link from "next/link";
import { nextVoiceSpeed, seekVoice, stopVoice, toggleVoice, useVoicePlayback, VoiceTrack } from "@/lib/voicePlayback";
import { PersonAvatar } from "./PersonAvatar";
import { clockOf, PlayIcon, Waveform } from "./VoiceNote";

// The voice note playing, wherever you are in Liston: it pops up once its
// bubble is off screen (scrolled away, another conversation, another page)
// and goes when it ends, when you stop it, or when its bubble is back in
// view. A notification-sized card at the top right, where Liston's own
// notifications pop up (one arriving meanwhile goes under it: see
// useVoicePopupOpen); across the top on a phone. Frosted, the sender
// haloed while it plays with a moving equalizer on their picture; who
// sent it and where, play / pause, the sound's shape to move along, the
// time, the speed, stop (clearer on hover); the name opens the
// conversation it's in.

/** Where it was said, under who said it: "In #orders", "Thread in #orders", "Direct message" (yours there: "To Sara Khan"). */
function whereOf(track: VoiceTrack): string {
  if (!track.place) return "Voice message";
  const { kind, title } = track.place;
  if (kind === "dm") return track.mine ? `To ${title}` : "Direct message";
  const name = kind === "channel" ? `#${title}` : title;
  return track.threadId ? `Thread in ${name}` : `In ${name}`;
}

export function NowPlaying() {
  const p = useVoicePlayback();
  const track = p.track;
  if (!track || p.shown) return null;

  const durationS = track.durationMs / 1000;
  const share = durationS ? Math.min(1, p.at / durationS) : 0;
  const who = track.mine ? "You" : track.author?.name || "Someone";
  const href = `/inbox?c=${track.conversationId}${track.threadId ? `&t=${track.threadId}` : ""}`;

  const elapsed = clockOf(p.at * 1000);

  return (
    <div
      role="region"
      aria-label="Voice message playing"
      className="group fixed right-4 top-[68px] z-[65] w-[min(380px,calc(100vw-32px))] animate-[slideIn_220ms_cubic-bezier(.2,.8,.2,1)] rounded-2xl border border-white/70 bg-white/85 p-3 shadow-[0_24px_60px_-18px_rgba(15,23,42,0.38),0_0_0_1px_rgba(15,23,42,0.06)] backdrop-blur-xl backdrop-saturate-150"
    >
      <div className="flex items-center gap-3">
        {/* The sender, haloed while it plays; the badge a moving equalizer then, a mic when paused. */}
        <span className={`relative flex flex-shrink-0 rounded-full ${p.playing ? "animate-[voiceHalo_1.8s_ease-out_infinite]" : ""}`}>
          <PersonAvatar id={track.author?.id} name={track.author?.name} avatarUrl={track.author?.avatarUrl} size={44} />
          <span className="absolute -bottom-0.5 -right-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--color-primary)] text-white ring-2 ring-white" aria-hidden>
            {p.playing ? (
              <span className="flex h-2 items-end gap-[1.5px]">
                {[0, 0.25, 0.5].map((d) => (
                  <span key={d} className="h-full w-[2px] origin-bottom rounded-full bg-white animate-[eqBar_.9s_ease-in-out_infinite]" style={{ animationDelay: `${d}s` }} />
                ))}
              </span>
            ) : (
              <svg viewBox="0 0 16 16" fill="none" className="h-2.5 w-2.5">
                <rect x="5.25" y="1.5" width="5.5" height="8.5" rx="2.75" fill="currentColor" />
                <path d="M3 7.5a5 5 0 0010 0M8 12.5v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            )}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex h-5 items-center gap-2">
            <Link href={href} title="Open the conversation" className="group/name min-w-0 flex-1 truncate text-[13px] leading-5">
              <span className="font-semibold text-[var(--color-ink)] group-hover/name:text-[var(--color-primary)]">{who}</span>
              <span className="text-[var(--color-muted)]"> · {whereOf(track)}</span>
            </Link>
            <button
              type="button"
              onClick={stopVoice}
              aria-label="Stop the voice message"
              title="Stop"
              className="-mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] opacity-60 transition hover:bg-black/[0.05] hover:text-[var(--color-ink)] hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden>
                <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="mt-1.5 flex h-8 items-center gap-1">
            <button
              type="button"
              onClick={() => toggleVoice(track)}
              aria-label={p.playing ? "Pause voice message" : "Play voice message"}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-white shadow-[0_6px_14px_-6px_rgba(79,70,229,0.75)] transition hover:scale-105 hover:bg-[var(--color-primary-hover)] active:scale-95"
            >
              <PlayIcon playing={p.playing} className="h-3.5 w-3.5" />
            </button>
            <Waveform peaks={track.peaks} share={share} durationS={durationS} tone="theirs" ring="#ffffff" onSeek={(s) => seekVoice(track, s * durationS)} onStep={(d) => seekVoice(track, p.at + d)} className="h-6" />
            <span className="flex-shrink-0 text-[11px] tabular-nums">
              <span className="text-[var(--color-ink)]/80">{elapsed}</span>
              <span className="text-[var(--color-muted)]/80"> / {clockOf(track.durationMs)}</span>
            </span>
            <button
              type="button"
              onClick={nextVoiceSpeed}
              aria-label={`Playback speed ${p.speed}x, change it`}
              title="Playback speed"
              className="ml-1.5 h-6 min-w-[38px] flex-shrink-0 rounded-full border border-[var(--color-line)] bg-white px-2 text-[11px] font-semibold tabular-nums text-[var(--color-ink)]/80 transition-colors hover:border-[var(--color-primary)]/40 hover:text-[var(--color-primary)]"
            >
              {p.speed}x
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
