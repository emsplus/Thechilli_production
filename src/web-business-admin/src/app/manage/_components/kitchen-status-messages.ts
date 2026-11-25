import type { Catalog } from "@/lib/i18n";

/** Manage > Restaurant > Kitchen status tracking (KitchenStatusCard). */
export const KITCHEN_STATUS_MSG = {
  title: { en: "Kitchen status tracking", hi: "किचन स्टेटस ट्रैकिंग", hinglish: "Kitchen status tracking" },
  desc: { en: "What happens after an order is sent to the kitchen.", hi: "ऑर्डर किचन में जाने के बाद क्या होगा।", hinglish: "Order kitchen mein jaane ke baad kya hoga." },
  group: { en: "Kitchen status tracking", hi: "किचन स्टेटस ट्रैकिंग", hinglish: "Kitchen status tracking" },
  kotOnly: { en: "KOT only (default)", hi: "सिर्फ KOT (डिफ़ॉल्ट)", hinglish: "Sirf KOT (default)" },
  kotOnlyHint: { en: "The kitchen just receives the ticket. Nobody has to click: tickets clear by themselves. No Preparing, Ready or Served steps.", hi: "किचन को बस टिकट मिलता है। किसी को क्लिक नहीं करना, टिकट अपने आप हट जाते हैं। कोई बन रहा है / तैयार / परोसा चरण नहीं।", hinglish: "Kitchen ko bas ticket milta hai. Kisi ko click nahi karna, tickets apne aap hat jaate hain. Koi Preparing, Ready ya Served step nahi." },
  showFor: { en: "Show tickets for (minutes)", hi: "टिकट कितनी देर दिखाएँ (मिनट)", hinglish: "Tickets kitni der dikhayein (minutes)" },
  showForHint: { en: "After this, a ticket moves to Earlier tickets (also at end of day). Nothing is deleted.", hi: "इसके बाद टिकट \"पिछले टिकट\" में चला जाता है (दिन के अंत में भी)। कुछ मिटता नहीं।", hinglish: "Iske baad ticket \"Pichhle tickets\" mein chala jaata hai (din ke ant mein bhi). Kuch delete nahi hota." },
  showForRange: { en: "Enter {min} to {max} minutes", hi: "{min} से {max} मिनट लिखें", hinglish: "{min} se {max} minutes likhein" },
  track: { en: "Track Preparing / Ready / Served", hi: "बन रहा है / तैयार / परोसा ट्रैक करें", hinglish: "Preparing / Ready / Served track karein" },
  trackHint: { en: "The full workflow: the kitchen moves each ticket through Preparing, Ready and Served, and waiters get a Ready alert.", hi: "पूरा वर्कफ़्लो: किचन हर टिकट को बन रहा है, तैयार और परोसा में ले जाता है, वेटर को तैयार का अलर्ट मिलता है।", hinglish: "Poora workflow: kitchen har ticket ko Preparing, Ready aur Served mein le jaata hai, waiter ko Ready ka alert milta hai." },
  save: { en: "Save", hi: "सेव करें", hinglish: "Save karein" },
  saved: { en: "Kitchen status tracking saved", hi: "किचन स्टेटस ट्रैकिंग सेव हो गई", hinglish: "Kitchen status tracking save ho gayi" },
  fail: { en: "Could not save. Check your connection and try again.", hi: "सेव नहीं हो सका। इंटरनेट जाँचकर फिर कोशिश करें।", hinglish: "Save nahi ho paya. Internet check karke phir koshish karein." },
  note: { en: "Tickets already on the kitchen screen stay there when you switch.", hi: "बदलने पर किचन स्क्रीन के मौजूदा टिकट वहीं रहते हैं।", hinglish: "Badalne par kitchen screen ke maujooda tickets wahin rehte hain." },
} satisfies Catalog;
