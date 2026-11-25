import { VoiceError } from "./voice";

/**
 * Push-to-talk recorder on MediaRecorder. Same code path on web/PWA and in the Capacitor WebView: on Android the
 * WebView's getUserMedia request triggers the OS RECORD_AUDIO prompt (permission declared in AndroidManifest.xml);
 * on iOS WKWebView it needs NSMicrophoneUsageDescription (handled on the iOS branch). No extra plugin is used.
 */
export const MIN_MS = 500;
export const MAX_MS = 60_000;
export const MAX_BYTES = 10 * 1024 * 1024; // pos-service limit

/** Prefer formats pos-service accepts (webm/ogg/mp4); Safari only records mp4. */
export function pickMime(isTypeSupported: (m: string) => boolean): string | undefined {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => isTypeSupported(m));
}
/** getUserMedia failure -> VoiceError code. */
export function mapMediaError(e: unknown): VoiceError {
  const n = (e as { name?: string } | null)?.name;
  if (n === "NotAllowedError" || n === "SecurityError" || n === "PermissionDeniedError") return new VoiceError("denied");
  if (n === "NotFoundError" || n === "DevicesNotFoundError" || n === "OverconstrainedError") return new VoiceError("no_device");
  if (n === "NotSupportedError") return new VoiceError("unsupported");
  return new VoiceError("failed");
}
export const canRecord = (): boolean =>
  typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/** "denied" lets the UI show the blocked state before the user even presses; "prompt"/"unknown" means just try. */
export async function micPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  try {
    const s = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return s.state;
  } catch { return "unknown"; }
}

export interface Recording { stop(): Promise<Blob>; cancel(): void }

export async function startRecording(onAutoStop?: () => void): Promise<Recording> {
  if (!canRecord()) throw new VoiceError("unsupported");
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { throw mapMediaError(e); }
  const release = () => stream.getTracks().forEach((t) => t.stop());
  let rec: MediaRecorder;
  try { const mimeType = pickMime((m) => MediaRecorder.isTypeSupported(m)); rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); }
  catch { release(); throw new VoiceError("unsupported"); }
  const chunks: Blob[] = [];
  const startedAt = Date.now();
  let cancelled = false, finished = false;
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<Blob>((resolve, reject) => {
    rec.onstop = () => {
      finished = true; clearTimeout(cap); release();
      if (cancelled) return reject(new VoiceError("aborted"));
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (Date.now() - startedAt < MIN_MS || blob.size === 0) return reject(new VoiceError("too_short"));
      if (blob.size > MAX_BYTES) return reject(new VoiceError("failed"));
      resolve(blob);
    };
    rec.onerror = () => { finished = true; clearTimeout(cap); release(); reject(new VoiceError("failed")); };
  });
  done.catch(() => {}); // surfaced through stop(); avoids an unhandled rejection on cancel
  const cap = setTimeout(() => { if (!finished && rec.state !== "inactive") { rec.stop(); onAutoStop?.(); } }, MAX_MS);
  rec.start();
  return {
    stop: () => { if (rec.state !== "inactive") rec.stop(); return done; },
    cancel: () => { cancelled = true; if (rec.state !== "inactive") rec.stop(); else release(); },
  };
}
