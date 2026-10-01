"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatMessage } from "@/lib/api";

// Voice notes, as WhatsApp has them. Recording: the composer's mic starts
// it (the browser asks for the microphone the first time), a bar shows the
// time and the sound as it comes in, the bin throws it away and the arrow
// sends it; ten minutes at most. What's kept is the audio (MP4 where the
// browser records it, which plays everywhere; else WebM), its length and
// the shape of its sound as 48 bars. Playing: a round play button, the
// bars filling in as it plays (a click on them jumps there), the time, and
// 1x / 1.5x / 2x. One plays at a time.

export const VOICE_MAX_MS = 10 * 60 * 1000;
const BARS = 48;
const SAMPLE_MS = 70;
const TYPES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

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
    <div className="flex items-center gap-2 rounded-[22px] border border-[var(--color-line)] bg-[var(--color-panel)] py-1 pl-1.5 pr-1">
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

// The note playing now, so starting another pauses it.
let playing: HTMLAudioElement | null = null;
const SPEEDS = [1, 1.5, 2];

/** A voice note in a bubble: play, its sound's shape filling in, the time, the speed. */
export function VoicePlayer({ voice, mine }: { voice: NonNullable<ChatMessage["voice"]>; mine: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const [at, setAt] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [failed, setFailed] = useState(false);
  const duration = voice.durationMs / 1000;
  const peaks = voice.peaks.length ? voice.peaks : Array(BARS).fill(0.3);
  const share = duration ? Math.min(1, at / duration) : 0;

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    const tick = () => setAt(el.currentTime);
    const ended = () => {
      setOn(false);
      setAt(0);
      el.currentTime = 0;
    };
    const paused = () => setOn(false);
    const played = () => setOn(true);
    el.addEventListener("timeupdate", tick);
    el.addEventListener("ended", ended);
    el.addEventListener("pause", paused);
    el.addEventListener("play", played);
    return () => {
      el.removeEventListener("timeupdate", tick);
      el.removeEventListener("ended", ended);
      el.removeEventListener("pause", paused);
      el.removeEventListener("play", played);
      if (playing === el) playing = null;
    };
  }, []);

  function toggle() {
    const el = audio.current;
    if (!el) return;
    if (!el.paused) {
      el.pause();
      return;
    }
    if (playing && playing !== el) playing.pause();
    playing = el;
    el.playbackRate = speed;
    el.play().catch(() => setFailed(true));
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const el = audio.current;
    if (!el || !duration) return;
    const box = e.currentTarget.getBoundingClientRect();
    const to = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * duration;
    el.currentTime = to;
    setAt(to);
  }

  function nextSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audio.current) audio.current.playbackRate = next;
  }

  if (failed) {
    return (
      <a href={voice.url} download className="flex w-[240px] max-w-full items-center gap-2 px-[9px] pt-[7px] text-[12.5px] text-[var(--color-primary)] underline underline-offset-2">
        Voice message ({clockOf(voice.durationMs)}): this browser can&apos;t play it. Download it
      </a>
    );
  }

  return (
    <div className="flex w-[264px] max-w-full items-center gap-2.5 px-[9px] pt-[7px]">
      <audio ref={audio} src={voice.url} preload="metadata" onError={() => setFailed(true)} />
      <button
        type="button"
        onClick={toggle}
        aria-label={on ? "Pause voice message" : "Play voice message"}
        className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-colors ${mine ? "bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)]" : "bg-[var(--color-primary-soft)] text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white"}`}
      >
        {on ? (
          <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
            <rect x="5" y="4" width="3.4" height="12" rx="1" fill="currentColor" />
            <rect x="11.6" y="4" width="3.4" height="12" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" className="ml-0.5 h-4 w-4" aria-hidden>
            <path d="M6 4.2v11.6a.8.8 0 001.2.7l9.3-5.8a.8.8 0 000-1.4L7.2 3.5A.8.8 0 006 4.2z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(at)}
          onClick={seek}
          onKeyDown={(e) => {
            const el = audio.current;
            if (!el || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
            e.preventDefault();
            el.currentTime = Math.min(duration, Math.max(0, el.currentTime + (e.key === "ArrowRight" ? 5 : -5)));
          }}
          className="flex h-7 cursor-pointer items-center gap-[2px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
        >
          {peaks.map((p, i) => (
            <span
              key={i}
              className={`min-w-[2px] flex-1 rounded-full transition-colors ${(i + 0.5) / peaks.length <= share ? "bg-[var(--color-primary)]" : mine ? "bg-[var(--color-primary)]/30" : "bg-[var(--color-muted)]/35"}`}
              style={{ height: `${Math.max(14, Math.round(p * 100))}%` }}
            />
          ))}
        </div>
        <div className="mt-0.5 flex items-center justify-between text-[10.5px] tabular-nums text-[var(--color-bubble-meta)]">
          <span>{on || at > 0 ? clockOf(at * 1000) : clockOf(voice.durationMs)}</span>
          <button type="button" onClick={nextSpeed} className="rounded-full bg-black/[0.06] px-1.5 font-semibold leading-4 text-[var(--color-ink)]/70 hover:bg-black/[0.1]" aria-label={`Playback speed ${speed}x`}>
            {speed}x
          </button>
        </div>
      </div>
    </div>
  );
}
