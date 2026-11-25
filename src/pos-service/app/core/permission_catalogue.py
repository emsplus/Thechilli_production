"""Human labels (en + hi) for every permission and area, for the role editor UI (GET /permissions, docs/ROLES_API.md).
tests/test_roles_api.py fails if a permission in app/core/permissions.py has no label here."""
from __future__ import annotations

from app.core.permissions import ALL_PERMISSIONS

# area key -> (en, hi)
AREAS: dict[str, tuple[str, str]] = {
    "orders": ("Orders", "ऑर्डर"),
    "kot": ("Kitchen tickets", "किचन टिकट (KOT)"),
    "bills": ("Billing", "बिलिंग"),
    "shifts": ("Waiter shifts", "वेटर शिफ़्ट"),
    "cashier": ("Cashier shift", "कैशियर शिफ़्ट"),
    "payments": ("Payments", "भुगतान"),
    "refunds": ("Refunds", "रिफंड"),
    "sync": ("Device sync", "डिवाइस सिंक"),
    "printing": ("Printing", "प्रिंटिंग"),
    "voice": ("Voice ordering", "वॉइस ऑर्डर"),
    "crm": ("Customers", "ग्राहक"),
    "menu": ("Menu", "मेन्यू"),
    "offers": ("Offers", "ऑफ़र"),
    "tables": ("Tables", "टेबल"),
    "inventory": ("Inventory", "इन्वेंटरी"),
    "purchases": ("Purchases and suppliers", "खरीद और सप्लायर"),
    "wastage": ("Wastage", "बर्बादी"),
    "delivery": ("Delivery orders", "डिलीवरी ऑर्डर"),
    "expenses": ("Expenses", "खर्चे"),
    "reports": ("Reports", "रिपोर्ट"),
    "audit": ("Audit log", "ऑडिट लॉग"),
    "ai": ("AI assistant", "AI सहायक"),
    "system": ("System health", "सिस्टम स्थिति"),
    "settings": ("Settings", "सेटिंग्स"),
    "outlets": ("Outlets", "आउटलेट"),
    "staff": ("Staff", "स्टाफ"),
    "roles": ("Roles", "भूमिकाएँ"),
    "users": ("User access", "यूज़र एक्सेस"),
    "reservations": ("Reservations", "टेबल बुकिंग"),
    "attendance": ("Staff attendance", "स्टाफ उपस्थिति"),
    "setup": ("Setup checklist", "सेटअप चेकलिस्ट"),
    "billing": ("Chilli credit (wallet)", "Chilli क्रेडिट (वॉलेट)"),
    "devices": ("Devices", "डिवाइस"),
}

# permission -> (en, hi)
LABELS: dict[str, tuple[str, str]] = {
    "orders.create": ("Take new orders", "नए ऑर्डर लेना"),
    "orders.update": ("Add lines / customer to an order", "ऑर्डर में आइटम या ग्राहक जोड़ना"),
    "orders.cancel": ("Cancel orders", "ऑर्डर रद्द करना"),
    "orders.cancel_unsent": ("Cancel orders or lines not yet sent to the kitchen", "रसोई को न भेजे गए ऑर्डर या आइटम रद्द करना"),
    "orders.request_bill": ("Request the bill for a table", "टेबल के लिए बिल माँगना"),
    "orders.transfer": ("Move or merge table orders", "टेबल ऑर्डर बदलना या मर्ज करना"),
    "orders.cancel_after_kitchen": ("Cancel orders the kitchen already has", "किचन में पहुँच चुके ऑर्डर रद्द करना"),
    "kot.send": ("Send orders to the kitchen", "ऑर्डर किचन को भेजना"),
    "kot.view": ("See kitchen tickets", "किचन टिकट देखना"),
    "kot.update_status": ("Update kitchen ticket status", "किचन टिकट की स्थिति बदलना"),
    "bills.finalize": ("Create bills", "बिल बनाना"),
    "bills.receipt": ("View bills and receipts", "बिल और रसीद देखना"),
    "bills.discount": ("Give discounts / remove service charge", "छूट देना / सर्विस चार्ज हटाना"),
    "bills.discount.over_limit": ("Discount above the cashier cap", "कैशियर सीमा से अधिक छूट"),
    "bills.amend": ("Amend finalised bills", "बने हुए बिल में बदलाव"),
    "shifts.use": ("Open and close own shift", "अपनी शिफ़्ट खोलना और बंद करना"),
    "shifts.manage": ("See who is on shift, close anyone's shift", "शिफ़्ट पर कौन है देखना, किसी की भी शिफ़्ट बंद करना"),
    "bills.void": ("Void bills", "बिल रद्द (वॉइड) करना"),
    "bills.skip_kitchen": ("Make a dine-in bill before the kitchen has every item", "किचन को सब आइटम भेजे बिना डाइन-इन बिल बनाना"),
    "payments.record": ("Record payments", "भुगतान दर्ज करना"),
    "cashier.shift": ("Open and close own cash session", "अपना कैश सेशन खोलना और बंद करना"),
    "payments.online": ("Take online payments (UPI / links)", "ऑनलाइन भुगतान (UPI / लिंक)"),
    "payments.setup": ("Set up the payment provider account", "पेमेंट प्रोवाइडर खाता सेट करना"),
    "refunds.create": ("Issue refunds", "रिफंड देना"),
    "sync.push": ("Sync the Chilli Agent device", "Chilli Agent डिवाइस सिंक करना"),
    "printing.use": ("Print bills and kitchen tickets", "बिल और किचन टिकट प्रिंट करना"),
    "printing.manage": ("Manage printers and print hubs", "प्रिंटर और प्रिंट हब मैनेज करना"),
    "voice.use": ("Use voice ordering", "वॉइस ऑर्डर का उपयोग"),
    "crm.read": ("View customers", "ग्राहक देखना"),
    "crm.write": ("Create / edit customers", "ग्राहक जोड़ना / बदलना"),
    "menu.manage": ("Manage menu", "मेन्यू मैनेज करना"),
    "menu.sold_out": ("Mark dishes sold out for today", "आज के लिए डिश ख़त्म (सोल्ड आउट) करना"),
    "offers.manage": ("Create and manage automatic offers (lunch deals, happy hours)", "ऑटोमैटिक ऑफ़र बनाना और मैनेज करना (लंच डील, हैप्पी आवर)"),
    "tables.assign": ("Assign tables to waiters on shift", "शिफ़्ट पर वेटरों को टेबल सौंपना"),
    "tables.manage": ("Manage tables", "टेबल मैनेज करना"),
    "inventory.manage": ("Manage inventory and recipes", "इन्वेंटरी और रेसिपी मैनेज करना"),
    "purchases.manage": ("Manage purchases and suppliers", "खरीद और सप्लायर मैनेज करना"),
    "purchases.receive": ("Receive goods against purchase orders", "खरीद ऑर्डर का माल प्राप्त करना"),
    "delivery.accept": ("Accept or reject delivery orders", "डिलीवरी ऑर्डर स्वीकार या अस्वीकार करना"),
    "delivery.manage": ("Manage delivery settings, the webhook outbox and payment confirmation", "डिलीवरी सेटिंग्स, वेबहुक आउटबॉक्स और भुगतान पुष्टि प्रबंधित करना"),
    "wastage.record": ("Record wastage and expiry write-offs", "बर्बादी और एक्सपायरी राइट-ऑफ दर्ज करना"),
    "inventory.count": ("Count stock (stocktake)", "स्टॉक की गिनती करना"),
    "expenses.manage": ("Manage expenses", "खर्चे मैनेज करना"),
    "reports.view": ("View reports and bills", "रिपोर्ट और बिल देखना"),
    "reports.close_day": ("Close the day (Z report)", "दिन बंद करना (Z रिपोर्ट)"),
    "audit.view": ("View the audit log", "ऑडिट लॉग देखना"),
    "ai.use": ("Use the AI assistant", "AI सहायक का उपयोग"),
    "system.view": ("View system health", "सिस्टम स्थिति देखना"),
    "settings.manage": ("Manage restaurant settings", "रेस्टोरेंट सेटिंग्स मैनेज करना"),
    "settings.owner": ("Owner settings (restaurant profile, localisation)", "ओनर सेटिंग्स (प्रोफ़ाइल, लोकलाइज़ेशन)"),
    "outlets.manage": ("Create and edit outlets", "आउटलेट बनाना और बदलना"),
    "outlets.access_all": ("Reach every outlet", "सभी आउटलेट तक पहुँच"),
    "staff.view": ("View staff", "स्टाफ देखना"),
    "staff.create": ("Create staff accounts", "स्टाफ खाते बनाना"),
    "staff.manage_roles": ("Change a staff member's built-in role", "स्टाफ की बिल्ट-इन भूमिका बदलना"),
    "staff.deactivate": ("Deactivate / reactivate staff", "स्टाफ को निष्क्रिय / सक्रिय करना"),
    "staff.reset_password": ("Reset staff passwords", "स्टाफ का पासवर्ड रीसेट करना"),
    "staff.manage_outlet_access": ("Set which outlets staff can use", "स्टाफ के आउटलेट एक्सेस तय करना"),
    "roles.manage": ("Create, edit and delete custom roles", "कस्टम भूमिकाएँ बनाना, बदलना और हटाना"),
    "users.manage": ("Assign roles and outlet access to users", "यूज़र को भूमिका और आउटलेट एक्सेस देना"),
    "reservations.manage": ("Book, seat and cancel table reservations", "टेबल बुकिंग करना, बैठाना और रद्द करना"),
    "attendance.clock": ("Clock in and out", "क्लॉक-इन और क्लॉक-आउट करना"),
    "attendance.manage": ("Manage staff attendance, schedules and reports", "स्टाफ उपस्थिति, शेड्यूल और रिपोर्ट मैनेज करना"),
    "setup.manage": ("Use the setup checklist", "सेटअप चेकलिस्ट का उपयोग करना"),
    "billing.view": ("See Chilli credit: balance, free trial, usage and receipts", "Chilli क्रेडिट देखना: बैलेंस, फ़्री ट्रायल, उपयोग और रसीदें"),
    "billing.topup": ("Top up Chilli credit", "Chilli क्रेडिट टॉप-अप करना"),
    "devices.manage": ("Manage signed-in devices and counter tablets", "साइन-इन डिवाइस और काउंटर टैबलेट मैनेज करना"),
    "staff.pin.manage": ("Reset or unlock staff counter PINs", "स्टाफ का काउंटर PIN रीसेट या अनलॉक करना"),
}

NOTES: dict[str, tuple[str, str]] = {
    "devices.manage": (
        "Can sign any staff member out of any device and register shared counter tablets for an outlet.",
        "किसी भी स्टाफ को किसी भी डिवाइस से साइन-आउट कर सकता है और आउटलेट के लिए काउंटर टैबलेट जोड़ सकता है।"),
    "outlets.access_all": (
        "Without this, the user only works in the outlets granted to them (user outlet access), or the default outlet when none "
        "are granted. With it, every outlet of the restaurant, including future ones, and grants are ignored.",
        "इसके बिना यूज़र केवल उन्हीं आउटलेट में काम कर सकता है जो उसे दिए गए हैं (कोई नहीं दिया तो डिफ़ॉल्ट आउटलेट)। इसके साथ "
        "रेस्टोरेंट के सभी आउटलेट, भविष्य के भी, खुल जाते हैं।"),
    "roles.manage": ("High risk: whoever holds this can shape other roles (never beyond their own permissions).",
                     "उच्च जोखिम: इसे रखने वाला दूसरी भूमिकाएँ बना सकता है (अपनी अनुमतियों से ज़्यादा नहीं)।"),
    "users.manage": ("High risk: whoever holds this can change what other users may do (never beyond their own permissions).",
                     "उच्च जोखिम: इसे रखने वाला दूसरों की अनुमतियाँ बदल सकता है (अपनी अनुमतियों से ज़्यादा नहीं)।"),
}

assert set(LABELS) == ALL_PERMISSIONS, sorted(set(LABELS) ^ ALL_PERMISSIONS)
assert {p.split(".")[0] for p in ALL_PERMISSIONS} <= set(AREAS)


def area_of(perm: str) -> str:
    return perm.split(".")[0]


def by_area(perms) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for p in sorted(perms):
        out.setdefault(area_of(p), []).append(p)
    return out


def catalogue(held: frozenset[str], lang: str = "en") -> list[dict]:
    """Areas in display order, each with its permissions; `grantable` = the caller holds it (so may give it to a role).
    lang 'en' (default): every label / note is {"en": ...} only (same object shape as before, so readers of `label.en` keep
    working; Hindi is not returned); 'all' / 'hi': {"en", "hi"} (the Hindi strings stay in this file, returned only when asked)."""
    from app.core.permissions import SYSTEM_ROLE_PERMISSIONS
    both = lang in ("all", "hi")

    def tx(en: str, hi: str) -> dict:
        return {"en": en, "hi": hi} if both else {"en": en}

    out = []
    for area, (en, hi) in AREAS.items():
        perms = [p for p in sorted(ALL_PERMISSIONS) if area_of(p) == area]
        if not perms:
            continue
        out.append({"key": area, "label": tx(en, hi), "permissions": [
            {"key": p, "label": tx(*LABELS[p]),
             "note": (tx(*NOTES[p]) if p in NOTES else None),
             "grantable": p in held,
             "system_roles": sorted(r for r, have in SYSTEM_ROLE_PERMISSIONS.items() if p in have)} for p in perms]})
    return out
