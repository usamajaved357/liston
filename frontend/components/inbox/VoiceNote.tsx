"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { nextVoiceSpeed, seekVoice, seeVoice, toggleVoice, useVoice, voiceUrl, VoiceTrack } from "@/lib/voicePlayback";
import { PersonAvatar } from "./PersonAvatar";

// Voice notes, as WhatsApp has them. Recording: the composer's mic starts
// it (the browser asks for the microphone the first time), a bar shows the
// time and the sound as it comes in, the bin throws it away and the arrow
// sends it; ten minutes at most. What's kept is the audio (AAC in MP4 where
// the browser records it, which plays everywhere, iPhones too; Chrome's
// plain "audio/mp4" is Opus, which some don't; else WebM), its length and
// the shape of its sound as 48 bars. Playing: drawn as WhatsApp draws it
// (the sender's picture, play, the bars filling in with a dot to drag, the
// time; 1x / 1.5x / 2x in the picture's place while it plays), through
// Liston's one player, so it keeps going while you scroll or change page
// (lib/voicePlayback; the pop-up controlling it is NowPlaying). One plays
// at a time.

export const VOICE_MAX_MS = 10 * 60 * 1000;
const BARS = 48;
const SAMPLE_MS = 70;
const TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

export type RecordedVoice = { blob: Blob; mime: string; name: string; durationMs: number; peaks: number[] };

/** A length as a clock: "0:07", "1:42". */
export function clockOf(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The loudness samples squeezed into `bars` bars, scaled so the loudest is 1 (a floor so silence still shows). */
export function peaksOf(samples: number[], bars = BARS): number[] {
  if (!samples.length) return Array(bars).fill(0.08);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i * samples.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / bars));
    out.push(Math.max(...samples.slice(from, to)));
  }
  const top = Math.max(...out, 0.0001);
  return out.map((v) => Math.round(Math.max(0.08, Math.min(1, v / top)) * 100) / 100);
}

const extensionOf = (mime: string) => (/mp4/.test(mime) ? "m4a" : /ogg/.test(mime) ? "ogg" : "webm");

/**
 * Records a voice note. `start` asks for the microphone; `stop` gives the
 * recording; `cancel` throws it away. `level` is the sound now (0–1) and
 * `recent` the last few dozen, for the bar while recording.
 */
export function useVoiceRecorder({ onLimit }: { onLimit?: () => void } = {}) {
  const [state, setState] = useState<"idle" | "starting" | "recording">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [recent, setRecent] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const parts = useRef<{ recorder: MediaRecorder; stream: MediaStream; context: AudioContext; chunks: Blob[]; samples: number[]; startedAt: number; timer: ReturnType<typeof setInterval>; mime: string } | null>(null);
  const limitRef = useRef(onLimit);
  useEffect(() => {
    limitRef.current = onLimit;
  });

  const release = useCallback(() => {
    const p = parts.current;
    if (!p) return;
    clearInterval(p.timer);
    p.stream.getTracks().forEach((t) => t.stop());
    p.context.close().catch(() => {});
    parts.current = null;
  }, []);

  useEffect(() => release, [release]);

  const start = useCallback(async () => {
    if (parts.current || state !== "idle") return;
    setError(null);
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser can't record voice messages.");
      return;
    }
    setState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || "";
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const samples: number[] = [];
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start(250);
      const startedAt = performance.now();
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
        samples.push(level);
        const ms = performance.now() - startedAt;
        setElapsed(ms);
        setRecent((r) => [...r.slice(-39), level]);
        if (ms >= VOICE_MAX_MS) limitRef.current?.();
      }, SAMPLE_MS);
      parts.current = { recorder, stream, context, chunks, samples, startedAt, timer, mime: recorder.mimeType || mime || "audio/webm" };
      setElapsed(0);
      setRecent([]);
      setState("recording");
    } catch (err) {
      release();
      setState("idle");
      const name = (err as { name?: string })?.name;
      setError(name === "NotAllowedError" || name === "SecurityError" ? "Liston can't use your microphone. Allow it in the browser's address bar, then try again." : name === "NotFoundError" ? "No microphone found." : "Couldn't start recording.");
    }
  }, [state, release]);

  /** Stops and hands back the recording (null when it was too short to keep). */
  const stop = useCallback(async (): Promise<RecordedVoice | null> => {
    const p = parts.current;
    if (!p) return null;
    const durationMs = Math.min(VOICE_MAX_MS, performance.now() - p.startedAt);
    const done = new Promise<void>((resolve) => {
      p.recorder.onstop = () => resolve();
    });
    if (p.recorder.state !== "inactive") p.recorder.stop();
    await done;
    const mime = p.mime.split(";")[0] || "audio/webm";
    const blob = new Blob(p.chunks, { type: mime });
    const peaks = peaksOf(p.samples);
    release();
    setState("idle");
    setRecent([]);
    if (durationMs < 700 || !blob.size) return null;
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", ".");
    return { blob, mime, name: `Voice message ${stamp}.${extensionOf(mime)}`, durationMs, peaks };
  }, [release]);

  const cancel = useCallback(() => {
    const p = parts.current;
    if (!p) return;
    if (p.recorder.state !== "inactive") p.recorder.stop();
    release();
    setState("idle");
    setRecent([]);
  }, [release]);

  return { state, recording: state === "recording", elapsed, recent, error, clearError: () => setError(null), start, stop, cancel };
}

/** The bar the composer becomes while recording: throw away, the time and the sound coming in, send. */
export function RecordingBar({ elapsed, recent, sending, onCancel, onSend }: { elapsed: number; recent: number[]; sending: boolean; onCancel: () => void; onSend: () => void }) {
  const bars = [...Array(Math.max(0, 40 - recent.length)).fill(0), ...recent];
  return (
    <div className="flex min-h-[52px] items-center gap-2 rounded-xl border border-[var(--color-ink)]/30 bg-[var(--color-panel)] px-2 py-2 shadow-[0_1px_6px_-1px_rgba(15,23,42,0.12)]">
      <button type="button" onClick={onCancel} disabled={sending} title="Throw it away" aria-label="Throw the recording away" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40">
        <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]" aria-hidden>
          <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <span className="flex items-center gap-1.5 text-[12.5px] font-medium tabular-nums text-[var(--color-ink)]" aria-live="off">
        <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" aria-hidden />
        {clockOf(elapsed)}
      </span>
      <span className="flex h-7 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden px-1" aria-hidden>
        {bars.map((v, i) => (
          <span key={i} className="w-[3px] flex-shrink-0 rounded-full bg-[var(--color-primary)]/70" style={{ height: `${Math.max(12, Math.round(v * 100))}%` }} />
        ))}
      </span>
      <span className="sr-only" role="status">
        Recording a voice message
      </span>
      <button type="button" onClick={onSend} disabled={sending} aria-label="Send the voice message" title="Send" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-60">
        {sending ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
        ) : (
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
            <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
    </div>
  );
}

/** How tall a bar is drawn (% of the wave): quiet sound still shows, loud doesn't swamp it. */
const barHeight = (p: number) => Math.round(18 + 82 * Math.pow(Math.min(1, Math.max(0, p)), 0.75));

// Bars are drawn this wide with this gap (px); as many as fit the room the wave has.
const BAR_PX = 2.5;
const GAP_PX = 2;

/** The bars squeezed into `count` (each the loudest of those it covers); as they are when they already fit. */
function fitBars(peaks: number[], count: number): number[] {
  if (count >= peaks.length) return peaks;
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * peaks.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / count));
    return Math.max(...peaks.slice(from, to));
  });
}

/**
 * A note's sound as bars, filled in up to `share` (0–1) with a dot there;
 * a click or a drag moves it (`onSeek` with the share), the arrow keys five
 * seconds (`onStep`). `tone` is the bubble it sits on, `ring` its colour
 * (round the dot).
 */
export function Waveform({ peaks, share, durationS, tone, ring, onSeek, onStep, className = "h-7" }: { peaks: number[]; share: number; durationS: number; tone: "mine" | "theirs"; ring: string; onSeek: (share: number) => void; onStep: (seconds: number) => void; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [room, setRoom] = useState(BARS);
  const bars = fitBars(peaks.length ? peaks : Array(BARS).fill(0.3), room);

  // As many bars as there's room for (a phone's narrower bubble gets fewer).
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(([entry]) => setRoom(Math.max(12, Math.floor((entry.contentRect.width + GAP_PX) / (BAR_PX + GAP_PX)))));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const shareAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  return (
    <div
      ref={box}
      role="slider"
      tabIndex={0}
      aria-label="Position"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationS)}
      aria-valuenow={Math.round(share * durationS)}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onSeek(shareAt(e));
      }}
      onPointerMove={(e) => {
        if (dragging.current) onSeek(shareAt(e));
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        onStep(e.key === "ArrowRight" ? 5 : -5);
      }}
      className={`relative mx-1.5 min-w-0 flex-1 cursor-pointer touch-none rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 ${className}`}
    >
      <span className="absolute inset-0 flex items-center justify-between overflow-hidden" aria-hidden>
        {bars.map((p, i) => (
          <span
            key={i}
            className={`w-[2.5px] flex-shrink-0 rounded-full ${(i + 0.5) / bars.length <= share ? "bg-[var(--color-primary)]" : tone === "mine" ? "bg-[var(--color-primary)]/35" : "bg-[var(--color-muted)]/40"}`}
            style={{ height: `${barHeight(p)}%` }}
          />
        ))}
      </span>
      <span className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-primary)]" style={{ left: `${share * 100}%`, boxShadow: `0 0 0 2px ${ring}` }} aria-hidden />
    </div>
  );
}

/** The play / pause icon (no button round it). */
export function PlayIcon({ playing, className = "h-[22px] w-[22px]" }: { playing: boolean; className?: string }) {
  return playing ? (
    <svg viewBox="0 0 20 20" className={className} aria-hidden>
      <rect x="4.5" y="3.5" width="3.8" height="13" rx="1.2" fill="currentColor" />
      <rect x="11.7" y="3.5" width="3.8" height="13" rx="1.2" fill="currentColor" />
    </svg>
  ) : (
    <svg viewBox="0 0 20 20" className={`ml-0.5 ${className}`} aria-hidden>
      <path d="M5.5 3.6v12.8a1 1 0 001.5.86l10.2-6.4a1 1 0 000-1.72L7 2.74a1 1 0 00-1.5.86z" fill="currentColor" />
    </svg>
  );
}

/** A person's picture with the small mic of a voice note on its corner (`ring`: what's behind it). */
export function VoiceAvatar({ author, size, ring }: { author: VoiceTrack["author"]; size: number; ring: string }) {
  return (
    <span className="relative flex flex-shrink-0" style={{ width: size, height: size }}>
      <PersonAvatar id={author?.id} name={author?.name} avatarUrl={author?.avatarUrl} size={size} />
      <span className="absolute -bottom-0.5 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full text-[var(--color-primary)]" style={{ background: ring }} aria-hidden>
        <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3">
          <rect x="5.25" y="1.5" width="5.5" height="8.5" rx="2.75" fill="currentColor" />
          <path d="M3 7.5a5 5 0 0010 0M8 12.5v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
    </span>
  );
}

/**
 * A voice note in a bubble, as WhatsApp draws one: the sender's picture with
 * a mic (while it plays, the speed instead: 1x, 1.5x, 2x), then play and the
 * sound's shape on one line, a dot marking where it's got to (click or drag
 * to move it), and under them its length (where it's at while playing) with
 * the bubble's time and ticks (`meta`) on the right. The sound itself plays
 * through Liston's one player (lib/voicePlayback), so it goes on when this
 * bubble scrolls away or you change page; the bubble tells it whether it's
 * on screen, for the pop-up that shows when it isn't.
 */
export function VoicePlayer({ track, meta, tone }: { track: VoiceTrack; meta?: ReactNode; tone?: "mine" | "theirs" }) {
  const root = useRef<HTMLDivElement>(null);
  const v = useVoice(track.id);
  const durationS = track.durationMs / 1000;
  const share = durationS ? Math.min(1, v.at / durationS) : 0;
  const started = v.current && (v.playing || v.at > 0);
  // What it sits on: your tinted bubble, else white (theirs, or a thread's flat row).
  const look = tone ?? (track.mine ? "mine" : "theirs");
  const bubble = look === "mine" ? "var(--color-bubble-out)" : "var(--color-panel)";

  // Whether this bubble is on screen (and not, once it's gone).
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver(([entry]) => seeVoice(el, track.id, entry.isIntersecting), { threshold: 0.5 });
    watch.observe(el);
    return () => {
      watch.disconnect();
      seeVoice(el, track.id, false);
    };
  }, [track.id]);

  return (
    <div ref={root} className="flex w-[300px] max-w-full items-center gap-2 py-[6px] pl-[7px] pr-[9px]">
      <span className="relative flex h-11 w-11 flex-shrink-0 items-center justify-center">
        {started ? (
          <button type="button" onClick={nextVoiceSpeed} aria-label={`Playback speed ${v.speed}x, change it`} title="Playback speed" className="h-7 min-w-[42px] rounded-full bg-black/[0.07] px-2 text-[12px] font-semibold tabular-nums text-[var(--color-ink)]/80 transition-colors hover:bg-black/[0.12]">
            {v.speed}x
          </button>
        ) : (
          <VoiceAvatar author={track.author} size={44} ring={bubble} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex h-8 items-center gap-1">
          <button
            type="button"
            onClick={() => toggleVoice(track)}
            disabled={v.failed}
            aria-label={v.playing ? "Pause voice message" : "Play voice message"}
            className="-ml-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--color-ink)]/70 transition-colors hover:bg-black/[0.05] hover:text-[var(--color-primary)] disabled:opacity-40"
          >
            <PlayIcon playing={v.playing} />
          </button>
          {v.gone ? (
            // The server no longer has its file: who to ask for it again, never a download that would fail.
            <span className="line-clamp-2 min-w-0 text-[12px] leading-snug text-[var(--color-muted)]" title={v.gone}>
              {v.gone}
            </span>
          ) : v.failed ? (
            <a href={voiceUrl(track)} download className="min-w-0 truncate text-[12.5px] text-[var(--color-primary)] underline underline-offset-2">
              Can&apos;t play here. Download it
            </a>
          ) : (
            <Waveform peaks={track.peaks} share={share} durationS={durationS} tone={look} ring={bubble} onSeek={(s) => seekVoice(track, s * durationS)} onStep={(d) => seekVoice(track, v.at + d)} />
          )}
        </div>
        <div className="flex h-4 items-center justify-between gap-2 pl-[38px]">
          <span className="text-[10.5px] leading-none tabular-nums text-[var(--color-bubble-meta)]">{started ? clockOf(v.at * 1000) : clockOf(track.durationMs)}</span>
          {meta}
        </div>
      </div>
    </div>
  );
}
