import type { Catalog } from "@/lib/i18n";

/** My account screen. */
export const ACCOUNT_MSG = {
  offline: { en: "You are offline. Your details will show when you are back online.", hi: "आप ऑफ़लाइन हैं। ऑनलाइन होते ही आपकी जानकारी दिखेगी।", hinglish: "Aap offline hain. Online hote hi aapki details dikhengi." },
  loadFail: { en: "Could not load your account.", hi: "आपका अकाउंट लोड नहीं हो सका।", hinglish: "Aapka account load nahi ho saka." },
  title: { en: "My account", hi: "मेरा अकाउंट", hinglish: "Mera account" },
  subtitle: { en: "Your sign-in details and password.", hi: "आपके साइन इन की जानकारी और पासवर्ड।", hinglish: "Aapke sign in ki details aur password." },
  profile: { en: "Profile", hi: "प्रोफ़ाइल", hinglish: "Profile" },
  loading: { en: "Loading your account", hi: "आपका अकाउंट लोड हो रहा है", hinglish: "Aapka account load ho raha hai" },
  changeTitle: { en: "Change password", hi: "पासवर्ड बदलें", hinglish: "Password badlein" },
  changeDesc: { en: "At least 10 characters. For safety this signs you out on every device, including this one.", hi: "कम से कम 10 अक्षर। सुरक्षा के लिए इससे आप इस डिवाइस समेत हर डिवाइस पर साइन आउट हो जाएँगे।", hinglish: "Kam se kam 10 characters. Suraksha ke liye isse aap is device samet har device par sign out ho jayenge." },
  changed: { en: "Password changed. Please sign in again.", hi: "पासवर्ड बदल गया। कृपया दोबारा साइन इन करें।", hinglish: "Password badal gaya. Kripya dobara sign in karein." },
  tooMany: { en: "Too many attempts. Please wait a few minutes.", hi: "बहुत ज़्यादा कोशिशें हो गईं। कृपया कुछ मिनट रुकें।", hinglish: "Bahut zyada koshishein ho gayi. Kripya kuch minute rukein." },
  changeFail: { en: "Could not change the password", hi: "पासवर्ड बदला नहीं जा सका", hinglish: "Password badla nahi ja saka" },
  current: { en: "Current password", hi: "मौजूदा पासवर्ड", hinglish: "Maujooda password" },
  next: { en: "New password", hi: "नया पासवर्ड", hinglish: "Naya password" },
  again: { en: "New password again", hi: "नया पासवर्ड दोबारा", hinglish: "Naya password dobara" },
  changeBtn: { en: "Change password", hi: "पासवर्ड बदलें", hinglish: "Password badlein" },
  signOutTitle: { en: "Sign out", hi: "साइन आउट", hinglish: "Sign out" },
  signOutBtn: { en: "Sign out", hi: "साइन आउट करें", hinglish: "Sign out karein" },
} satisfies Catalog;
