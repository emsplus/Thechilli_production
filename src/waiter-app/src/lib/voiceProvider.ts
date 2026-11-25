import { ApiError, api } from "./api";
import { getOnline } from "./native/network";
import { canRecord } from "./recorder";
import { fakeProvider } from "./voiceFake";
import { registerVoiceProvider, VoiceError, voiceErrorFromStatus, type VoiceOrderingProvider, type VoiceRequest } from "./voice";

export const VOICE_FAKE = process.env.NEXT_PUBLIC_VOICE_FAKE === "1";

/** Builds the multipart body: exactly one of `file` / `text`, language only when chosen, plus the attempt id. */
export function buildForm(req: VoiceRequest): FormData {
  const f = new FormData();
  if (req.audio) f.append("file", req.audio, `voice.${req.audio.type.includes("mp4") ? "m4a" : req.audio.type.includes("ogg") ? "ogg" : "webm"}`);
  else if (req.text?.trim()) f.append("text", req.text.trim());
  else throw new VoiceError("empty");
  if (req.language !== "auto") f.append("language", req.language);
  f.append("client_op_id", req.clientOpId);
  return f;
}

export const apiProvider: VoiceOrderingProvider = {
  isSupported: () => true, // typing always works; recording is checked separately (canRecord)
  async parse(req, signal) {
    if (!getOnline()) throw new VoiceError("offline");
    try { return await api.voiceOrder(buildForm(req), signal); }
    catch (e) {
      if (e instanceof VoiceError) throw e;
      if (signal.aborted) throw new VoiceError("aborted");
      if (e instanceof ApiError) throw new VoiceError(voiceErrorFromStatus(e.status), e.message);
      throw new VoiceError("network");
    }
  },
};

/** Called once when the signed-in app mounts. The mic button needs a provider; the sheet itself degrades to typing when recording is unsupported. */
export function registerDefaultVoice() { registerVoiceProvider(VOICE_FAKE ? fakeProvider : apiProvider); }
export { canRecord };
