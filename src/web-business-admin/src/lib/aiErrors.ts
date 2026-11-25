/**
 * The AI / OCR features answer with the server's own words, which for a missing key or model name an environment variable
 * ("AI model is not configured (set GEMINI_MODEL)") or a raw exception ("RuntimeError: GEMINI_API_KEY is not configured").
 * An owner cannot act on that: say what it means for them, keep every other message as it is.
 */
export function plainAiError(raw: string, feature = "AI suggestions", plural = true): string {
  if (/GEMINI|API[_ ]?KEY|not configured|not set up/i.test(raw)) return `${feature} ${plural ? "are" : "is"} not switched on for this account. You can still do this by hand.`;
  if (/^\s*\w*(Error|Exception)\b|Traceback|\bat \w+\.\w+/.test(raw)) return `${feature} had a problem just now. Try again, or do this by hand.`;
  return raw;
}
