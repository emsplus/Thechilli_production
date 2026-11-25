export type Locale = 'en' | 'hi' | 'hinglish';

export const htmlLang: Record<Locale, string> = { en: 'en-IN', hi: 'hi-IN', hinglish: 'hi-Latn' };

type Catalog = Record<string, string>;

const en: Catalog = {
  'action.retry': 'Retry',
  'action.close': 'Close',
  'action.cancel': 'Cancel',
  'action.save': 'Save',
  'action.dismiss': 'Dismiss',
  'common.loading': 'Loading',
  'common.empty': 'Nothing here yet',
  'common.error': 'Something went wrong',
  'qty.increase': 'Increase {label}',
  'qty.decrease': 'Decrease {label}',
  'sync.synced': 'All synced',
  'sync.queued': '{n} waiting to send',
  'sync.sending': 'Sending {n}',
  'sync.failed': '{n} failed to send',
  'sync.offline': 'Offline',
  'offline.banner': 'You are offline. Orders are saved and will send when you are back online.',
  'order.draft': 'Draft',
  'order.placed': 'New',
  'order.preparing': 'Preparing',
  'order.ready': 'Ready',
  'order.served': 'Served',
  'order.paid': 'Paid',
  'order.cancelled': 'Cancelled',
  'action.confirm': 'Confirm',
  'action.export': 'Export CSV',
  'action.reset': 'Reset',
  'filter.label': 'Filters',
  'outlet.label': 'Outlet',
  'delta.up': 'up {n}%',
  'delta.down': 'down {n}%',
  'delta.flat': 'no change',
  'kds.late': 'Late',
  'kds.min': '{n} min',
  'kds.start': 'Start',
  'kds.ready': 'Mark ready',
  'kds.serve': 'Served',
  'kds.empty': 'No tickets',
  'pad.tendered': 'Tendered',
  'pad.change': 'Change',
  'pad.short': 'Short by',
  'pad.back': 'Delete digit',
  'pad.clear': 'Clear',
  'table.scroll': 'Scroll for more columns',
};

const hi: Catalog = {
  'action.retry': 'फिर कोशिश करें',
  'action.close': 'बंद करें',
  'action.cancel': 'रद्द करें',
  'action.save': 'सहेजें',
  'action.dismiss': 'हटाएं',
  'common.loading': 'लोड हो रहा है',
  'common.empty': 'यहाँ अभी कुछ नहीं है',
  'common.error': 'कुछ गड़बड़ हो गई',
  'qty.increase': '{label} बढ़ाएं',
  'qty.decrease': '{label} घटाएं',
  'sync.synced': 'सब सिंक हो गया',
  'sync.queued': '{n} भेजने के लिए रुके हैं',
  'sync.sending': '{n} भेजे जा रहे हैं',
  'sync.failed': '{n} नहीं भेजे जा सके',
  'sync.offline': 'ऑफलाइन',
  'offline.banner': 'आप ऑफलाइन हैं। ऑर्डर सेव रहेंगे और नेट आने पर भेजे जाएंगे।',
  'order.draft': 'ड्राफ्ट',
  'order.placed': 'नया',
  'order.preparing': 'बन रहा है',
  'order.ready': 'तैयार',
  'order.served': 'परोसा गया',
  'order.paid': 'भुगतान हुआ',
  'order.cancelled': 'रद्द',
  'action.confirm': 'पक्का करें',
  'action.export': 'CSV निकालें',
  'action.reset': 'रीसेट',
  'filter.label': 'फ़िल्टर',
  'outlet.label': 'आउटलेट',
  'delta.up': '{n}% ऊपर',
  'delta.down': '{n}% नीचे',
  'delta.flat': 'कोई बदलाव नहीं',
  'kds.late': 'देरी',
  'kds.min': '{n} मिनट',
  'kds.start': 'शुरू करें',
  'kds.ready': 'तैयार करें',
  'kds.serve': 'परोसा',
  'kds.empty': 'कोई टिकट नहीं',
  'pad.tendered': 'दिया गया',
  'pad.change': 'वापसी',
  'pad.short': 'कम है',
  'pad.back': 'अंक हटाएं',
  'pad.clear': 'साफ़ करें',
  'table.scroll': 'और कॉलम के लिए स्क्रॉल करें',
};

const hinglish: Catalog = {
  'action.retry': 'Dobara try karein',
  'action.close': 'Band karein',
  'action.cancel': 'Cancel karein',
  'action.save': 'Save karein',
  'action.dismiss': 'Hatayein',
  'common.loading': 'Load ho raha hai',
  'common.empty': 'Yahan abhi kuch nahi hai',
  'common.error': 'Kuch gadbad ho gayi',
  'qty.increase': '{label} badhayein',
  'qty.decrease': '{label} ghatayein',
  'sync.synced': 'Sab sync ho gaya',
  'sync.queued': '{n} bhejne ke liye ruke hain',
  'sync.sending': '{n} bheje ja rahe hain',
  'sync.failed': '{n} nahi bheje ja sake',
  'sync.offline': 'Offline',
  'offline.banner': 'Aap offline hain. Orders save rahenge aur net aane par bhej diye jayenge.',
  'order.draft': 'Draft',
  'order.placed': 'Naya',
  'order.preparing': 'Ban raha hai',
  'order.ready': 'Ready',
  'order.served': 'Serve ho gaya',
  'order.paid': 'Paid',
  'order.cancelled': 'Cancel',
  'action.confirm': 'Pakka karein',
  'action.export': 'CSV nikalein',
  'action.reset': 'Reset',
  'filter.label': 'Filter',
  'outlet.label': 'Outlet',
  'delta.up': '{n}% upar',
  'delta.down': '{n}% neeche',
  'delta.flat': 'Koi badlav nahi',
  'kds.late': 'Deri',
  'kds.min': '{n} min',
  'kds.start': 'Shuru karein',
  'kds.ready': 'Ready karein',
  'kds.serve': 'Serve kiya',
  'kds.empty': 'Koi ticket nahi',
  'pad.tendered': 'Diya gaya',
  'pad.change': 'Wapsi',
  'pad.short': 'Kam hai',
  'pad.back': 'Ank hatayein',
  'pad.clear': 'Saaf karein',
  'table.scroll': 'Aur columns ke liye scroll karein',
};

export const catalogs: Record<Locale, Catalog> = { en, hi, hinglish };

export type MessageKey = keyof typeof en;

/** Looks up a string; falls back to English, then to the key. Replaces {name} params. */
export function t(locale: Locale, key: string, params: Record<string, string | number> = {}): string {
  const raw = catalogs[locale][key] ?? en[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

/** True when text contains Devanagari, so callers can set lang="hi" on that run. */
export function hasDevanagari(text: string): boolean {
  return /[ऀ-ॿ]/.test(text);
}

/** Returns lang attribute for a text run ('hi' for Devanagari, otherwise undefined). */
export function langFor(text: string): string | undefined {
  return hasDevanagari(text) ? 'hi' : undefined;
}
