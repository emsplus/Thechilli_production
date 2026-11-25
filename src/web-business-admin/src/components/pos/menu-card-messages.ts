import type { Catalog } from "@/lib/i18n";

/** Strings of the POS menu item card. English / Hindi / Hinglish. */
export const MENU_CARD_MSG = {
  soldOut: { en: "Sold out", hi: "स्टॉक ख़त्म", hinglish: "Sold out" },
  addToOrderSuffix: { en: "add to order", hi: "ऑर्डर में जोड़ें", hinglish: "order mein jodein" },
  inOrder: { en: "{qty} in order", hi: "ऑर्डर में {qty}", hinglish: "order mein {qty}" },
  addOneMore: { en: "Add one more {name}", hi: "एक और {name} जोड़ें", hinglish: "Ek aur {name} jodein" },
  removeOne: { en: "Remove one {name}", hi: "एक {name} घटाएँ", hinglish: "Ek {name} kam karein" },
  addNameToOrder: { en: "Add {name} to order", hi: "{name} को ऑर्डर में जोड़ें", hinglish: "{name} ko order mein jodein" },
  add: { en: "Add", hi: "जोड़ें", hinglish: "Jodein" },
} satisfies Catalog;
