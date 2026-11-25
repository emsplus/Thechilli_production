"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Settings2, Trash2 } from "lucide-react";
import { Button, Dialog, IconButton } from "@chilli/ui";
import { LiveListener, liveSpeechUsable } from "@/lib/liveSpeech";
import { VOICE_COUNTDOWN_CHOICES, voiceCountdown } from "@/lib/voiceSettings";
import { setShareSwitch, shareOffered, shareSample, shareSwitch } from "@/lib/voiceShare";
import { micDebugShown, setMicDebugShown } from "@/lib/micLog";
import { directOn, setDirectOn } from "@/lib/voiceDirect";
import { detectorOn, setDetectorOn } from "@/lib/wakeDetector";
import { autoLearnOn, confirmNearMiss, findWake, lastWakeHeard, learnedWakes, noteNearMiss, phoneticKey, removeLearned, resetLearned, setAutoLearn, setWakeSensitivity, train, WAKE_SENSITIVITIES, wakeSensitivity, type TrainResult, type WakeSensitivity } from "@/lib/wakeWord";

/** How many times training asks for "Hey Zonov". */
export const TRAIN_SAMPLES = 5;

/**
 * Voice settings of this device (docs/VOICE_QA_REPORT.md round 2): the countdown before a spoken place / send runs, how strict
 * "Hey Zonov" is matched, what the recogniser last returned while waiting, training "Hey Zonov" to this voice (5 samples; only
 * forms that sound like Zonov are kept, on top of the built-in matcher), a Test, the learned list, and "Mic not working? Reset".
 */
export function VoiceSettings({ onResetMic, pauseHandsFree }: { onResetMic: () => void; pauseHandsFree: () => void }) {
  const [open, setOpen] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const [sens, setSens] = useState<WakeSensitivity>("normal");
  const [learned, setLearned] = useState<string[]>([]);
  const [auto, setAuto] = useState(true);
  const [offered, setOffered] = useState(false);
  const [debug, setDebug] = useState(true);
  const [directMode, setDirectMode] = useState(true);
  const [detect, setDetect] = useState(true);
  const [share, setShare] = useState(true);
  const [heard, setHeard] = useState("");
  // training / test: one tapped recogniser, owned here and always torn down
  const [mode, setMode] = useState<"idle" | "train" | "test">("idle");
  const [samples, setSamples] = useState<{ final: string; interims: string[] }[]>([]);
  const [interim, setInterim] = useState("");
  const [results, setResults] = useState<TrainResult[] | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const listener = useRef<LiveListener | null>(null);

  const stopListening = () => { listener.current?.abort(); listener.current = null; setInterim(""); setMode("idle"); };
  useEffect(() => () => { listener.current?.abort(); }, []);
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setHeard(lastWakeHeard()), 500);
    return () => clearInterval(id);
  }, [open]);

  function openIt() {
    setCountdown(voiceCountdown.get()); setSens(wakeSensitivity()); setAuto(autoLearnOn()); setOffered(shareOffered()); setShare(shareSwitch()); setDebug(micDebugShown()); setDirectMode(directOn()); setDetect(detectorOn()); setLearned(learnedWakes()); setHeard(lastWakeHeard());
    setResults(null); setTest(null); setSamples([]); setOpen(true);
  }
  function closeIt() { stopListening(); setOpen(false); }

  /** Listens (inside the tap) and hands every finished phrase to `onFinal`; interims are kept for the sample list. */
  function listen(next: "train" | "test", onFinal: (text: string, interims: string[]) => boolean) {
    pauseHandsFree();
    listener.current?.abort();
    let seen = "";
    let interims: string[] = [];
    const l = new LiveListener({
      lang: "en-IN",
      onUpdate: (u) => {
        if (u.interim) { setInterim(u.interim); if (interims[interims.length - 1] !== u.interim) interims = [...interims, u.interim]; }
        let part = "";
        if (u.finalText.length > seen.length) { part = u.finalText.slice(seen.length).replace(/^[,\s]+/, "").trim(); seen = u.finalText; }
        // the same phrase said again: the listener folds a repeated final into the previous one, so the last guess is the sample
        else if (!u.interim && interims.length) part = interims[interims.length - 1];
        if (!u.interim && part) {
          const done = onFinal(part, interims);
          interims = [];
          if (done) { l.abort(); if (listener.current === l) listener.current = null; setMode("idle"); setInterim(""); }
        }
      },
      onFail: () => { setMode("idle"); setTest("The microphone could not start. Allow it in the browser, or use Reset."); },
      onEnd: () => { if (listener.current === l) { listener.current = null; setMode("idle"); setInterim(""); } },
    });
    listener.current = l;
    setMode(next);
    l.start();
  }

  function startTraining() {
    setResults(null); setSamples([]);
    const got: { final: string; interims: string[] }[] = [];
    listen("train", (text, interims) => {
      got.push({ final: text, interims });
      setSamples([...got]);
      if (got.length < TRAIN_SAMPLES) return false;
      const r = train(got.map((g) => g.final));
      setResults(r); setLearned(learnedWakes());
      return true;
    });
  }
  function startTest() {
    setTest(null);
    listen("test", (text) => {
      const ok = findWake(text, wakeSensitivity()) !== null;
      shareSample(text, ok, "wake"); // testing phase (server flag), text only
      // a close miss heard in a Test is learned by auto-learn (when it is on), like one before a voice command that succeeded
      let learnt: string | null = null;
      if (!ok) { noteNearMiss(text); learnt = confirmNearMiss(); setLearned(learnedWakes()); }
      setTest(`Heard: “${text}” (${ok ? "matched" : learnt ? `not matched; learned “hey ${learnt}”, it matches from now on` : "not matched"})`);
      return true;
    });
  }

  const select = "h-11 w-full rounded-xl border border-border-strong bg-surface px-3 text-sm text-fg";
  return (
    <>
      <IconButton label="Voice settings" icon={<Settings2 />} variant="ghost" data-testid="voice-settings" onClick={openIt} />
      <Dialog open={open} onOpenChange={(o) => { if (!o) closeIt(); }} title="Voice settings" description="Kept on this device."
        footer={<Button variant="primary" onClick={() => { voiceCountdown.set(countdown); setWakeSensitivity(sens); closeIt(); }}>Save</Button>}>
        <div className="space-y-4 pb-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold text-fg">Countdown before a spoken “place order” or “send to kitchen” runs</span>
            <select aria-label="Countdown before a spoken order runs" value={countdown} onChange={(e) => setCountdown(Number(e.target.value))} className={select}>
              {VOICE_COUNTDOWN_CHOICES.map((n) => <option key={n} value={n}>{n === 0 ? "None: run at once" : `${n} seconds${n === 3 ? " (default)" : ""}`}</option>)}
            </select>
            <span className="block text-xs text-fg-muted">A dish added with a doubt (Check) always gets at least 5 seconds, so there is time to change it or say “stop”.</span>
          </label>

          <label className="flex min-h-11 items-start gap-2 text-sm font-semibold text-fg">
            <input type="checkbox" className="mt-1 size-4" data-testid="detector-switch" checked={detect} onChange={(e) => { setDetect(e.target.checked); setDetectorOn(e.target.checked); }} />
            <span>Offline “Hey Zonov” detector (on this device, no internet needed)
              <span className="block text-xs font-normal text-fg-muted">Listens for the wake phrase on this computer itself ({36} MB voice engine, downloaded once). Takes effect when hands-free starts again (Reset).</span></span>
          </label>

          <label className="flex min-h-11 items-start gap-2 text-sm font-semibold text-fg">
            <input type="checkbox" className="mt-1 size-4" data-testid="direct-switch" checked={directMode} onChange={(e) => { setDirectMode(e.target.checked); setDirectOn(e.target.checked); }} />
            <span>Direct mode: add spoken dishes to the selected bill without “Hey Zonov”
              <span className="block text-xs font-normal text-fg-muted">Only clear orders are added (“ek butter chicken”, “bill 2 me do lassi”, “table 4 me …”); talk that is not an order is ignored. “Undo” takes the last add back.</span></span>
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-semibold text-fg">How closely “Hey Zonov” must match</span>
            <select aria-label="Wake word sensitivity" value={sens} onChange={(e) => setSens(e.target.value as WakeSensitivity)} className={select}>
              {WAKE_SENSITIVITIES.map((s) => <option key={s.value} value={s.value}>{s.label}{s.value === "normal" ? " (default)" : ""}</option>)}
            </select>
            <span data-testid="voice-last-heard" className="block break-words text-xs text-fg-muted">Last heard while waiting: {heard ? `“${heard}”` : "nothing yet"}</span>
          </label>

          <section aria-label="Train Hey Zonov" className="space-y-2 rounded-xl border border-border p-3">
            <h3 className="text-sm font-semibold text-fg">Train “Hey Zonov” to your voice</h3>
            <p className="text-xs text-fg-muted">Say “Hey Zonov” {TRAIN_SAMPLES} times, with a short pause each time. Only what sounds like “Zonov” is kept, on top of the built-in matching (which always stays on).</p>
            {mode === "train" ? (
              <div role="status" aria-live="polite" data-testid="voice-train-status" className="flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm font-semibold text-danger-fg">
                <Mic aria-hidden className="size-4 animate-pulse" />Listening: say “Hey Zonov” ({Math.min(samples.length + 1, TRAIN_SAMPLES)} of {TRAIN_SAMPLES}){interim ? ` · “${interim}”` : ""}
              </div>
            ) : null}
            {samples.length > 0 && (
              <ol data-testid="voice-train-samples" className="space-y-1 text-xs">
                {samples.map((s, i) => {
                  const r = results?.[i];
                  return (
                    <li key={i} className="flex flex-wrap gap-x-2">
                      <span className="font-semibold text-fg">{i + 1}. “{s.final}”</span>
                      <span className="text-fg-muted">{r ? (r.name ? `${r.name} · ${r.key || phoneticKey(r.name)}` : "") : ""}</span>
                      {r && <span className={r.accepted ? "font-semibold text-success-fg" : "font-semibold text-warning-fg"}>{r.matchedBefore ? "already understood" : r.accepted ? "learned" : `not kept: ${r.why}`}</span>}
                      {s.interims.length > 0 && <span className="w-full text-fg-muted">while speaking: {s.interims.slice(-3).map((x) => `“${x}”`).join(", ")}</span>}
                    </li>
                  );
                })}
              </ol>
            )}
            <div className="flex flex-wrap gap-2">
              {mode === "idle"
                ? <Button size="sm" variant="secondary" iconStart={<Mic />} disabled={!liveSpeechUsable()} onClick={startTraining}>Train “Hey Zonov”</Button>
                : <Button size="sm" variant="secondary" onClick={stopListening}>Stop</Button>}
              <Button size="sm" variant="ghost" disabled={mode !== "idle" || !liveSpeechUsable()} onClick={startTest}>Test</Button>
            </div>
            {mode === "test" && <p role="status" className="text-xs font-semibold text-danger-fg">Listening: say “Hey Zonov”{interim ? ` · “${interim}”` : ""}</p>}
            {test && <p role="status" data-testid="voice-test-result" className="text-sm font-semibold text-fg">{test}</p>}
            <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-fg">
              <input type="checkbox" className="size-4" data-testid="voice-auto-learn" checked={auto} onChange={(e) => { setAuto(e.target.checked); setAutoLearn(e.target.checked); }} />
              Auto-learn how I say “Hey Zonov”
            </label>
            <p className="text-xs text-fg-muted">{offered && share ? "Learned on this device (in this testing build the words the mic hears are also shared: see below). " : "Learned on this device only. Nothing is sent to our servers. "}Only the words are kept (never audio), at most 3 new ones a day, and a learned form that is not used for 30 days is forgotten.</p>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-fg-muted">Learned on this device</p>
              {learned.length === 0 ? <p className="text-xs text-fg-muted">None: the built-in matching only.</p> : (
                <ul data-testid="voice-learned" className="flex flex-wrap gap-1.5">
                  {learned.map((w) => (
                    <li key={w} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 pl-2.5 text-xs font-semibold text-fg">
                      hey {w}
                      <IconButton label={`Forget “hey ${w}”`} icon={<Trash2 />} variant="ghost" onClick={() => { removeLearned(w); setLearned(learnedWakes()); }} />
                    </li>
                  ))}
                </ul>
              )}
              {learned.length > 0 && <Button size="sm" variant="ghost" onClick={() => { resetLearned(); setLearned([]); }}>Reset to the built-in matching</Button>}
            </div>
          </section>

          {offered && (
            <section aria-label="Testing build" data-testid="voice-share" className="space-y-1 rounded-xl border border-warning bg-warning-soft/60 p-3">
              <p className="text-xs font-semibold text-warning-fg">Testing build: the words the mic hears are sent to improve recognition. No audio is stored.</p>
              <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-fg">
                <input type="checkbox" className="size-4" data-testid="voice-share-switch" checked={share} onChange={(e) => { setShare(e.target.checked); setShareSwitch(e.target.checked); }} />
                Share what the mic heard (text only)
              </label>
            </section>
          )}

          <section aria-label="Microphone" className="space-y-1.5">
            <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-fg">
              <input type="checkbox" className="size-4" data-testid="mic-debug-switch" checked={debug} onChange={(e) => { setDebug(e.target.checked); setMicDebugShown(e.target.checked); }} />
              Show mic debug (next to the mic: what the microphone heard and did; on this device only)
            </label>
            <Button variant="secondary" data-testid="voice-reset-settings" onClick={() => { stopListening(); onResetMic(); }}>Mic not working? Reset</Button>
            <p className="text-xs text-fg-muted">Stops and restarts the microphone and speech recognition without reloading the page.</p>
          </section>
        </div>
      </Dialog>
    </>
  );
}
