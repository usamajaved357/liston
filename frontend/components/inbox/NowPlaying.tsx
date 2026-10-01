"use client";

import Link from "next/link";
import { nextVoiceSpeed, seekVoice, stopVoice, toggleVoice, useVoicePlayback, VoiceTrack } from "@/lib/voicePlayback";
import { clockOf, PlayIcon, VoiceAvatar, Waveform } from "./VoiceNote";

// The voice note playing, wherever you are in Liston: it pops up once its
// bubble is off screen (scrolled away, another conversation, another page)
// and goes when it ends, when you stop it, or when its bubble is back in
// view. A notification-sized card at the top right, where Liston's own
// notifications pop up (one arriving meanwhile goes under it: see
// useVoicePopupOpen); across the top on a phone. Who sent it and where,
// play / pause, the sound's shape to move along, the time, the speed,
// stop; the name opens the conversation it's in.

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

  return (
    <div role="region" aria-label="Voice message playing" className="fixed right-4 top-[68px] z-[65] w-[min(380px,calc(100vw-32px))] animate-[slideIn_200ms_ease-out] rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-3 shadow-[0_22px_56px_-14px_rgba(15,23,42,0.35)]">
      <div className="flex items-center gap-3">
        <VoiceAvatar author={track.author} size={40} ring="var(--color-panel)" />
        <div className="min-w-0 flex-1">
          <div className="flex h-5 items-center gap-2">
            <Link href={href} title="Open the conversation" className="group min-w-0 flex-1 truncate text-[13px] leading-5">
              <span className="font-semibold text-[var(--color-ink)] group-hover:text-[var(--color-primary)]">{who}</span>
              <span className="text-[var(--color-muted)]"> · {whereOf(track)}</span>
            </Link>
            <button type="button" onClick={stopVoice} aria-label="Stop the voice message" title="Stop" className="-mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]">
              <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
                <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="mt-1 flex h-8 items-center gap-1">
            <button
              type="button"
              onClick={() => toggleVoice(track)}
              aria-label={p.playing ? "Pause voice message" : "Play voice message"}
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-white transition-colors hover:bg-[var(--color-primary-hover)]"
            >
              <PlayIcon playing={p.playing} className="h-3.5 w-3.5" />
            </button>
            <Waveform peaks={track.peaks} share={share} durationS={durationS} tone="theirs" ring="var(--color-panel)" onSeek={(s) => seekVoice(track, s * durationS)} onStep={(d) => seekVoice(track, p.at + d)} className="h-6" />
            <span className="min-w-[30px] flex-shrink-0 text-right text-[11px] tabular-nums text-[var(--color-muted)]">{clockOf((p.playing || p.at > 0 ? p.at : durationS) * 1000)}</span>
            <button type="button" onClick={nextVoiceSpeed} aria-label={`Playback speed ${p.speed}x, change it`} title="Playback speed" className="ml-1 h-6 min-w-[36px] flex-shrink-0 rounded-full bg-black/[0.06] px-1.5 text-[11px] font-semibold tabular-nums text-[var(--color-ink)]/80 transition-colors hover:bg-black/[0.11]">
              {p.speed}x
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
