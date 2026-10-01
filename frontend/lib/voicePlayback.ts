import { useSyncExternalStore } from "react";

// Team chat's voice notes play through one audio element for the whole of
// Liston, not one inside each bubble: a note keeps playing while its bubble
// scrolls out of the list (which drops rows it isn't showing) and while you
// go to another page, until it ends or you stop it. Bubbles and the player
// that pops up elsewhere (NowPlaying) are views of it. One plays at a time;
// the speed (1x, 1.5x, 2x) is kept for the next. Each bubble on screen says
// so (seeVoice), so the pop-up shows only while the playing note's bubble
// isn't in view. Signing out stops it.

export type VoiceTrack = {
  id: string; // the message
  url: string;
  durationMs: number;
  peaks: number[];
  author: { id: string; name: string; avatarUrl: string | null } | null;
  mine: boolean;
  conversationId: string;
  threadId: string | null;
  // The conversation it was said in, for the pop-up's "In #orders", "Direct message".
  place: { kind: "dm" | "group" | "channel"; title: string } | null;
};

export type VoicePlayback = {
  track: VoiceTrack | null;
  playing: boolean;
  at: number; // seconds in
  speed: number;
  failed: string[]; // notes this browser couldn't play
  shown: boolean; // the playing note's bubble is on screen
};

export const VOICE_SPEEDS = [1, 1.5, 2];
const SPEED_KEY = "liston.voiceSpeed";

function savedSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return VOICE_SPEEDS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

const SERVER: VoicePlayback = { track: null, playing: false, at: 0, speed: 1, failed: [], shown: false };
let state: VoicePlayback = typeof window === "undefined" ? SERVER : { ...SERVER, speed: savedSpeed() };
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let frame = 0;
// Bubbles on screen now, and the note each shows.
const seen = new Map<Element, string>();

function set(next: Partial<VoicePlayback>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const signedIn = () => {
  try {
    return Boolean(localStorage.getItem("token"));
  } catch {
    return true;
  }
};

const isShown = (id: string | undefined) => Boolean(id) && [...seen.values()].includes(id!);

function element(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = "auto";
  a.addEventListener("play", () => {
    set({ playing: true });
    follow();
  });
  a.addEventListener("pause", () => set({ playing: false, at: a.currentTime }));
  a.addEventListener("ended", () => stopVoice());
  a.addEventListener("timeupdate", () => {
    if (!signedIn()) stopVoice();
    else if (Math.abs(a.currentTime - state.at) >= 0.05) set({ at: a.currentTime });
  });
  a.addEventListener("error", () => {
    // Only a note that was loaded (stopping empties it, which errors too).
    const t = state.track;
    if (!t || !a.getAttribute("src")) return;
    const failed = [...state.failed, t.id];
    stopVoice();
    set({ failed });
  });
  audio = a;
  return a;
}

// While it plays (and the page is drawn), the position every frame, so the dot moves smoothly.
function follow() {
  cancelAnimationFrame(frame);
  const step = () => {
    if (!audio || audio.paused) return;
    if (Math.abs(audio.currentTime - state.at) >= 0.03) set({ at: audio.currentTime });
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

function seekTo(a: HTMLAudioElement, seconds: number) {
  if (a.readyState >= 1) a.currentTime = seconds;
  else a.addEventListener("loadedmetadata", () => (a.currentTime = seconds), { once: true });
}

function load(track: VoiceTrack, at: number) {
  const a = element();
  a.src = track.url;
  a.defaultPlaybackRate = state.speed;
  a.playbackRate = state.speed;
  if (at > 0) seekTo(a, at);
  set({ track, at, playing: false, shown: isShown(track.id) });
  mediaSession(track);
}

function play(a: HTMLAudioElement, track: VoiceTrack) {
  a.playbackRate = state.speed;
  a.play().catch((err: { name?: string }) => {
    // Switched to another note before it started; or the browser wants a tap first.
    if (err?.name === "AbortError" || err?.name === "NotAllowedError") return;
    stopVoice();
    set({ failed: [...state.failed, track.id] });
  });
}

/** Play or pause a note (another one playing stops). */
export function toggleVoice(track: VoiceTrack) {
  const a = element();
  if (state.track?.id === track.id) {
    if (a.paused) play(a, track);
    else a.pause();
    return;
  }
  load(track, 0);
  play(a, track);
}

/** Move a note to `seconds` in (one not playing waits there, paused). */
export function seekVoice(track: VoiceTrack, seconds: number) {
  const to = Math.max(0, Math.min(track.durationMs / 1000, seconds));
  if (state.track?.id !== track.id) {
    load(track, to);
    return;
  }
  seekTo(element(), to);
  set({ at: to });
}

/** 1x → 1.5x → 2x → 1x, kept for the next note. */
export function nextVoiceSpeed() {
  const speed = VOICE_SPEEDS[(VOICE_SPEEDS.indexOf(state.speed) + 1) % VOICE_SPEEDS.length];
  if (audio) {
    audio.defaultPlaybackRate = speed;
    audio.playbackRate = speed;
  }
  try {
    localStorage.setItem(SPEED_KEY, String(speed));
  } catch {}
  set({ speed });
}

/** Stop and put it away (the pop-up goes). */
export function stopVoice() {
  cancelAnimationFrame(frame);
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  set({ track: null, playing: false, at: 0, shown: false });
  mediaSession(null);
}

/** A bubble saying whether it's on screen now (and gone when it unmounts: visible false). */
export function seeVoice(el: Element, id: string, visible: boolean) {
  if (visible) seen.set(el, id);
  else seen.delete(el);
  const shown = isShown(state.track?.id);
  if (shown !== state.shown) set({ shown });
}

// The computer's own media keys and lock screen show the note and control it.
function mediaSession(track: VoiceTrack | null) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = track
      ? new MediaMetadata({ title: "Voice message", artist: track.mine ? "You" : track.author?.name || "Someone", album: "Liston", artwork: track.author?.avatarUrl ? [{ src: track.author.avatarUrl }] : [] })
      : null;
    navigator.mediaSession.setActionHandler("play", track ? () => audio && play(audio, track) : null);
    navigator.mediaSession.setActionHandler("pause", track ? () => audio?.pause() : null);
    navigator.mediaSession.setActionHandler("stop", track ? () => stopVoice() : null);
  } catch {}
}

/** Everything: for the pop-up. */
export function useVoicePlayback(): VoicePlayback {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER
  );
}

export type VoiceView = { current: boolean; playing: boolean; at: number; speed: number; failed: boolean };
// Each note's view, kept the same object until something it shows changes,
// so the bubbles of notes not playing don't redraw as one plays.
const views = new Map<string, { key: string; view: VoiceView }>();
function viewOf(id: string): VoiceView {
  const current = state.track?.id === id;
  const failed = state.failed.includes(id);
  const key = current ? `1|${state.playing}|${state.at}|${state.speed}|${failed}` : `0|${failed}`;
  const kept = views.get(id);
  if (kept?.key === key) return kept.view;
  const view = { current, playing: current && state.playing, at: current ? state.at : 0, speed: state.speed, failed };
  views.set(id, { key, view });
  return view;
}

/** One note as its bubble shows it: whether it's the one playing, where it's at. */
export function useVoice(id: string): VoiceView {
  return useSyncExternalStore(
    subscribe,
    () => viewOf(id),
    () => viewOf(id)
  );
}
