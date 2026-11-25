export const site = {
  name: 'thechilli',
  email: 'contact@thechilli.ai',
}

export const navLinks = [
  { label: 'Home', to: '/' },
  { label: 'Features', to: '/features' },
  { label: 'Waiter app', to: '/waiter-app' },
  { label: 'GST & payments', to: '/gst-payments' },
  { label: 'Delivery', to: '/delivery' },
  { label: 'Pricing', to: '/pricing' },
]

export const heroPoints = ['GST-ready billing', 'UPI & card payments', 'Works offline', 'Hindi & Hinglish voice orders']

export const serviceTypes = ['Dine-in', 'Takeaway', 'Delivery', 'Cafés', 'Quick service', 'Multi-outlet restaurants']

export const modules = [
  { icon: 'receipt', title: 'Orders & billing', text: 'Dine-in, takeaway and delivery orders with KOT, discounts and split payments in cash, card or UPI.' },
  { icon: 'grid', title: 'Menu & tables', text: 'Items, categories and options, plus areas and tables, set up once and used on every device.' },
  { icon: 'box', title: 'Inventory', text: 'Stock, recipes, purchases, suppliers, stock counts and wastage in one place.' },
  { icon: 'users', title: 'Staff & roles', text: 'Custom roles with permissions, outlets, shifts and cash drawer for every team member.' },
  { icon: 'chart', title: 'Reports', text: 'Daily sales, end-of-day, GST summary and insights, always up to date.' },
  { icon: 'mic', title: 'Voice ordering', text: 'Speak the order in Hindi or Hinglish; it lands on the bill as English item names.' },
  { icon: 'scan', title: 'Bill scan', text: 'Photograph a supplier bill and it is read into your purchase entry automatically.' },
  { icon: 'percent', title: 'India GST', text: 'CGST, SGST and IGST calculated and rounded exactly, switched on per restaurant.' },
  { icon: 'card', title: 'Payments', text: 'Record cash, card and UPI on every bill, split across methods, with a clear end-of-day total.' },
]

export const counterPoints = [
  'Dine-in, takeaway and delivery on one counter screen',
  'KOT goes to the kitchen the moment you send it',
  'Split a bill across cash, card and UPI',
  'Voids and cancels are manager-only, need a reason and create a credit note',
]

export const waiterPoints = [
  'Pick a table, add dishes and send to the kitchen in a few taps',
  'Keep taking orders when the internet drops; they sync when it returns',
  'Orders are never duplicated, even if a sync is retried',
  'Available in English and Hindi on Android and iOS',
]

export const kitchenPoints = [
  'A live kitchen screen shows every order as it arrives',
  'KOT and bills print on your thermal printer over the restaurant network',
  'Print hub runs on a computer inside your restaurant, so printing never waits on the internet',
]

export const voicePoints = [
  'Understands Hindi and Hinglish as people actually speak',
  'Converts to English item names that match your menu',
  'Faster at a busy counter than typing',
]

export const stockPoints = [
  'Recipes deduct stock automatically as you sell',
  'Purchases, suppliers, stock counts and wastage tracked',
  'Snap a supplier bill and it fills in the purchase for you',
]

export const gstPoints = [
  { title: 'Exact GST', text: 'CGST, SGST and IGST with correct rounding. All amounts are handled in whole paise, so totals always add up.' },
  { title: 'Cash, card & UPI', text: 'Every payment is recorded in rupees against the bill, split across cash, card and UPI if the guest wants.' },
  { title: 'Reports for your CA', text: 'Daily sales, end-of-day and a GST summary ready when your accountant asks.' },
]

export const deliveryItems = [
  { title: 'Your own delivery', tag: 'Plan add-on', text: 'Assign riders, share a tracking link with the customer and give riders their own simple page.' },
  { title: 'Zomato & Swiggy orders', tag: 'Coming soon', text: 'Bring marketplace orders straight into the same Chilli Agent screen instead of re-typing them.' },
  { title: 'WhatsApp updates', tag: 'Coming soon', text: 'Order and delivery updates to customers on WhatsApp.' },
]

export const trust = [
  { icon: 'shield', title: 'Your data stays yours', text: 'Every restaurant’s data is isolated from every other restaurant at the database level.' },
  { icon: 'wifi', title: 'Built for patchy internet', text: 'Orders are saved on the device and sync safely when the connection is back.' },
  { icon: 'toggle', title: 'Pay for what you use', text: 'Features switch on and off with your plan, so you only carry what you need.' },
]

export const plans = [
  { name: '7-day free trial', price: 'Free', blurb: 'Try Chilli Agent in your own restaurant for 7 days.', items: ['Orders, billing, KOT and GST invoices', 'Waiter app and kitchen screen', 'Reports for every day'], cta: 'Start free trial', href: '/signup' },
  { name: 'Pay as you go', price: '₹2,000 = 2,000 Chilli', blurb: 'After the trial, add Chilli to your account and use it order by order.', items: ['Pay ₹2,000 and 2,000 Chilli are added to your restaurant account', '5 Chilli are used for every order', 'Chilli are credited to the account that made the payment'], cta: 'Get started', href: '/signup', hot: true },
  { name: 'Multi-outlet', price: 'Custom', blurb: 'For groups with several locations.', items: ['Everything in Pay as you go', 'Multiple outlets', 'Own delivery with rider tracking', 'Priority support'], cta: 'Talk to sales' },
]

export const faqs = [
  { q: 'How does pricing work?', a: 'Chilli Agent is free for 7 days. After that it is pay as you go: pay ₹2,000 and 2,000 Chilli are added to your restaurant account, and every order uses 5 Chilli.' },
  { q: 'What devices does Chilli Agent run on?', a: 'The counter works in any modern browser, and waiters use the Chilli Staff app on Android and iOS.' },
  { q: 'What if the internet goes down?', a: 'The waiter app keeps taking orders offline and syncs them once you are back online, without creating duplicates.' },
  { q: 'Does it handle GST?', a: 'Yes. CGST, SGST and IGST are supported and switched on per restaurant, with a GST summary report.' },
  { q: 'Which payments can I accept?', a: 'Cash, card and UPI are recorded on the bill at the counter, split across methods if needed. The money goes straight to you.' },
  { q: 'Can I print KOT and bills?', a: 'Yes, on a thermal printer. A small print hub runs on a computer in your restaurant and sends tickets to the printer.' },
  { q: 'Can I run more than one outlet?', a: 'Yes. Staff, shifts and cash drawers are tracked per outlet.' },
]

// Sample digital menu shown on /menu. Dishes and prices are illustrative.
export const menuBook = [
  {
    tab: 'Starters & Thalis',
    pages: [
      { script: 'Hot', title: 'Starters', photos: [{ src: '/images/plates-640.webp', pos: 'tl' }], items: [
        { name: 'Paneer Tikka', price: 260, text: 'Cottage cheese, peppers and onion, marinated and charred in the tandoor.' },
        { name: 'Chicken 65', price: 280, text: 'Crisp fried chicken tossed with curry leaves and red chilli.' },
        { name: 'Tandoori Chicken', price: 340, text: 'Half chicken in yoghurt and Kashmiri chilli, served with mint chutney.' },
        { name: 'Seekh Kebab', price: 300, text: 'Minced lamb with ginger and green chilli, grilled on skewers.' },
        { name: 'Veg Pakora', price: 160, text: 'Onion, potato and spinach fritters in spiced gram flour.' },
      ] },
      { script: 'Chef\u2019s', title: 'Thalis', photos: [{ src: '/images/kitchen-curry-640.webp', pos: 'br' }], items: [
        { name: 'Veg Thali', price: 280, text: 'Two sabzis, dal, rice, two rotis, raita, salad and a sweet.' },
        { name: 'Non-Veg Thali', price: 360, text: 'Chicken curry, dal, rice, two rotis, raita and a sweet.' },
        { name: 'Mini Meal', price: 190, text: 'Dal, one sabzi, rice and two rotis. Ideal for lunch.' },
        { name: 'Family Combo', price: 990, text: 'Biryani, butter chicken, dal makhani, four naans and dessert for four.' },
      ] },
    ],
  },
  {
    tab: 'Biryani & Rolls',
    pages: [
      { script: 'Our', title: 'Biryani', photos: [{ src: '/menu/chicken-biryani.webp', pos: 'tl' }], items: [
        { name: 'Chicken Biryani', price: 320, text: 'Long-grain basmati, slow-cooked dum style with tender chicken, saffron and fried onions.' },
        { name: 'Mutton Biryani', price: 420, text: 'Hyderabadi spices, marinated mutton and rice layered and sealed in the handi.' },
        { name: 'Veg Dum Biryani', price: 260, text: 'Seasonal vegetables, mint and whole spices, served with raita.' },
        { name: 'Egg Biryani', price: 280, text: 'Masala-fried boiled eggs on fragrant biryani rice.' },
        { name: 'Jeera Rice', price: 160, text: 'Basmati tempered with cumin and ghee.' },
      ] },
      { script: 'Fresh', title: 'Rolls & Breads', photos: [{ src: '/menu/chicken-tikka-roll.webp', pos: 'br' }, { src: '/menu/garlic-naan.webp', pos: 'ml' }], items: [
        { name: 'Chicken Tikka Roll', price: 180, text: 'Charred tikka, onions and mint chutney in a flaky paratha.' },
        { name: 'Paneer Tikka Roll', price: 160, text: 'Tandoori paneer, peppers and tangy sauce.' },
        { name: 'Garlic Naan', price: 60, text: 'Tandoor-baked, brushed with garlic butter and coriander.' },
        { name: 'Butter Naan', price: 50, text: 'Soft, layered and finished with butter.' },
        { name: 'Lachha Paratha', price: 60, text: 'Crisp, flaky whole-wheat layers.' },
      ] },
    ],
  },
  {
    tab: 'Curries & Drinks',
    pages: [
      { script: 'Rich', title: 'Curries', photos: [{ src: '/menu/lamb-rogan-josh.webp', pos: 'tl' }, { src: '/menu/aloo-gobi.webp', pos: 'br' }], items: [
        { name: 'Lamb Rogan Josh', price: 420, text: 'Kashmiri chilli, yoghurt and slow-braised lamb.' },
        { name: 'Butter Chicken', price: 360, text: 'Tandoori chicken in a smooth tomato, butter and cream gravy.' },
        { name: 'Dal Makhani', price: 240, text: 'Black lentils simmered overnight with butter and cream.' },
        { name: 'Paneer Butter Masala', price: 280, text: 'Soft paneer cubes in a mildly sweet makhani gravy.' },
        { name: 'Aloo Gobi', price: 220, text: 'Potato and cauliflower with turmeric, ginger and green chilli.' },
      ] },
      { script: 'Cool', title: 'Drinks & Desserts', photos: [{ src: '/menu/lime-soda.webp', pos: 'br' }], items: [
        { name: 'Fresh Lime Soda', price: 90, text: 'Sweet, salted or mixed, with fresh mint.' },
        { name: 'Mango Lassi', price: 130, text: 'Alphonso mango blended with chilled yoghurt.' },
        { name: 'Masala Chai', price: 50, text: 'Strong tea brewed with ginger and cardamom.' },
        { name: 'Gulab Jamun', price: 90, text: 'Two warm dumplings in rose-cardamom syrup.' },
        { name: 'Kesar Kulfi', price: 100, text: 'Slow-reduced milk, saffron and pistachio.' },
      ] },
    ],
  },
]

/** Where "Prod" and "UAT" lead: each environment's business-app login. One website serves both; the addresses can be overridden at
 *  build time (VITE_PROD_APP_URL / VITE_UAT_APP_URL), the defaults are the two live environments. */
export const environments = [
  { label: 'Prod', title: 'Production: real restaurants and bills', url: import.meta.env.VITE_PROD_APP_URL || 'https://app.thechilli.zonov.ai/login' },
  { label: 'UAT', title: 'UAT: testing, nothing here is real', url: import.meta.env.VITE_UAT_APP_URL || 'https://app.testchilli.zonov.ai/login' },
]
