import type { MenuItem } from "./types";

/**
 * VOICE ORDERING CONTRACT. A provider turns speech or typed text into a parsed order (`VoiceOrderResponse`); the UI
 * shows it as a REVIEWABLE sheet and adds to the cart only after the waiter confirms. Voice never enqueues sync ops
 * or submits a KOT, and nothing is queued for voice when offline (it needs the network).
 *
 * Backend: pos-service POST /api/v1/ai/voice-order (multipart: `file` OR `text`, optional `language` en|hi|pa|auto).
 * ASSUMPTIONS about the hardening branch (not merged/verified when this was written; see docs/VOICE_UI.md):
 *  - `clarifications` (optional, absent on today's backend) lists ambiguous phrases with candidate dishes.
 *  - `client_op_id` (optional form field, a UUID per attempt) is accepted for idempotent replay; today's backend ignores it.
 *  - line fields are exactly today's `VoiceLineOut`; `issues` are free strings (we only react to a few known ones).
 */
export type VoiceLang = "auto" | "en" | "hi" | "pa";

export interface VoiceLineDto {
  item_id: string; item_name: string; variant_id: string | null; variant_name: string | null;
  quantity: number; note: string | null; heard_text: string; confidence: number; needs_review: boolean; issues: string[];
}
export interface VoiceClarificationOption { item_id: string; item_name: string; variant_id: string | null; variant_name: string | null }
export interface VoiceClarificationDto { id: string; heard_text: string; quantity: number; note?: string | null; options: VoiceClarificationOption[] }
export interface VoiceOrderResponse {
  transcript: string | null;
  lines: VoiceLineDto[];
  unmatched: string[];
  clarifications?: VoiceClarificationDto[];
  /** Also returned today (customer, order_type, table_label, ...); the waiter app ignores them: table/mode come from the draft. */
  [extra: string]: unknown;
}

export interface VoiceRequest {
  audio?: Blob; text?: string; language: VoiceLang;
  /** One per attempt; sent as `client_op_id` so a retried upload cannot be parsed/committed twice once the backend honours it. */
  clientOpId: string;
  /** Menu snapshot, used only by the fake provider (the real backend uses its own index). */
  menu?: MenuItem[];
}
export interface VoiceOrderingProvider {
  isSupported(): boolean;
  parse(req: VoiceRequest, signal: AbortSignal): Promise<VoiceOrderResponse>;
}

export type VoiceErrorCode = "offline" | "denied" | "unsupported" | "no_device" | "too_short" | "failed" | "network" | "rate_limit" | "server" | "empty" | "aborted";
export class VoiceError extends Error {
  constructor(public code: VoiceErrorCode, message?: string) { super(message ?? code); }
}
/** Maps an HTTP status from /ai/voice-order (0 = unreachable) to a user-facing error code. */
export function voiceErrorFromStatus(status: number): VoiceErrorCode {
  if (status === 0 || status === 408) return "network";
  if (status === 429) return "rate_limit";
  if (status >= 500 || status === 409 || status === 403) return "server";
  return "failed";
}

/** Registered provider; null = feature off (the mic button is not rendered). */
export let voiceProvider: VoiceOrderingProvider | null = null;
export function registerVoiceProvider(p: VoiceOrderingProvider | null) { voiceProvider = p; }
