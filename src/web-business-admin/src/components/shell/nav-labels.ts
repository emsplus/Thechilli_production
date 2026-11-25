import type { Locale } from "@/lib/i18n";

/** Hindi and Hinglish names for navigation labels (English is the label itself). Unknown labels stay as they are. */
const HI: Record<string, [string, string]> = {
  Today: ["आज", "Aaj"], Alerts: ["अलर्ट", "Alerts"], Overview: ["सारांश", "Saaransh"], "Ask AI": ["AI से पूछें", "AI se poochhein"],
  Sell: ["बिक्री", "Bikri"], Counter: ["काउंटर", "Counter"], Orders: ["ऑर्डर", "Orders"], Tables: ["टेबल", "Tables"], Kitchen: ["रसोई", "Rasoi"],
  Menu: ["मेन्यू", "Menu"], "Menu items": ["मेन्यू आइटम", "Menu items"], Stock: ["स्टॉक", "Stock"], "Stock levels": ["स्टॉक की स्थिति", "Stock ki sthiti"],
  Recipes: ["रेसिपी", "Recipes"], Purchases: ["खरीद", "Kharid"], "Orders & receiving": ["ऑर्डर और माल प्राप्ति", "Order aur maal prapti"],
  Customers: ["ग्राहक", "Grahak"], Reports: ["रिपोर्ट", "Reports"], "Cash drawer": ["कैश दराज", "Cash drawer"], "End of day": ["दिन का समापन", "Din ka samapan"],
  Settings: ["सेटिंग", "Settings"], Business: ["व्यवसाय", "Vyavsay"], Staff: ["स्टाफ", "Staff"], Devices: ["डिवाइस", "Devices"],
  "Audit log": ["ऑडिट लॉग", "Audit log"], "System health": ["सिस्टम स्वास्थ्य", "System health"], "System tools": ["सिस्टम टूल", "System tools"], Sync: ["सिंक", "Sync"],
  Inventory: ["इन्वेंटरी", "Inventory"], Operations: ["संचालन", "Sanchalan"], "Set up": ["सेटअप", "Setup"],
  More: ["और", "Aur"], "Sign out": ["साइन आउट", "Sign out"], Reviews: ["रिव्यू", "Reviews"],
};
export function navLabel(label: string, locale: Locale): string {
  const h = HI[label];
  return !h || locale === "en" ? label : locale === "hi" ? h[0] : h[1];
}
