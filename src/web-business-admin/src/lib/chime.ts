"use client";

let audio: AudioContext | null = null;

/** Two short tones (and a short buzz on a phone). Needs a user gesture once on the page before browsers allow audio; never throws. */
export function chime() {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    const t = audio.currentTime;
    [880, 1175].forEach((f, i) => {
      const o = audio!.createOscillator(), g = audio!.createGain();
      o.frequency.value = f; g.gain.setValueAtTime(0.2, t + i * 0.18); g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.18 + 0.16);
      o.connect(g).connect(audio!.destination); o.start(t + i * 0.18); o.stop(t + i * 0.18 + 0.17);
    });
    navigator.vibrate?.(150);
  } catch { /* no audio: the visual alert still shows */ }
}

/** The counter bell's sound switch (a payment reminder from a waiter): ON unless this device turned it off. */
export const BELL_SOUND_KEY = "pos.bell.sound";
export function bellSoundOn(): boolean { try { return localStorage.getItem(BELL_SOUND_KEY) !== "0"; } catch { return true; } }
export function setBellSound(on: boolean) { try { localStorage.setItem(BELL_SOUND_KEY, on ? "1" : "0"); } catch { /* this tab only */ } }
