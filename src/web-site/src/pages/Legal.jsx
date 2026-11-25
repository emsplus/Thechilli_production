import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import PageHero from '../components/ui/PageHero.jsx'
import { site } from '../data/content.js'

const COMPANY = 'GROWIT AI TECHNOLOGY PRIVATE LIMITED'
const UPDATED = '13 November 2026'

function Legal({ title, eyebrow, intro, children }) {
  useEffect(() => { document.title = `${title} | thechilli.ai` }, [title])
  return (
    <>
      <PageHero eyebrow={eyebrow} title={title} text={intro} />
      <section>
        <div className="wrap legal">
          <p className="legal-meta">Last updated: {UPDATED}</p>
          {children}
          <p className="legal-meta">
            Questions about this page? Write to <a href={`mailto:${site.email}`}>{site.email}</a>.
            See also: <Link to="/terms">Terms of Service</Link> · <Link to="/privacy">Privacy Policy</Link> · <Link to="/refund">Refund and Cancellation Policy</Link>.
          </p>
        </div>
      </section>
    </>
  )
}

export function Terms() {
  return (
    <Legal eyebrow="Legal" title="Terms of Service" intro="The simple rules for using Chilli Agent.">
      <h2>1. Who we are</h2>
      <p>Chilli Agent (thechilli.ai) is billing, waiter, kitchen, inventory and GST software for restaurants and cafes in India. It is provided by {COMPANY} ("we", "us"). By creating an account or using Chilli Agent you ("you", the restaurant or business) agree to these terms.</p>

      <h2>2. Your account</h2>
      <p>You must give correct details when you sign up and keep your login details safe. You are responsible for what happens under your account, including what your staff do. Tell us at once if you think someone else has your password.</p>

      <h2>3. Free trial and Chilli credits</h2>
      <ul>
        <li><b>Free trial:</b> every new restaurant can use Chilli Agent free for 7 days.</li>
        <li><b>Chilli credits:</b> after the trial, you pay as you go. You recharge your account in rupees through Razorpay. One rupee paid adds one Chilli. The smallest recharge is shown on the Billing screen (currently ₹2,000).</li>
        <li><b>Use:</b> every bill uses 5 Chilli. If your balance reaches zero you can still create 20 more orders; after that, new orders are paused until you recharge. A bill that is already open can always be finished and paid.</li>
        <li><b>Credits are prepaid:</b> they can only be used inside Chilli Agent, cannot be transferred or exchanged for cash, and are added to the account that made the payment. See the <Link to="/refund">Refund and Cancellation Policy</Link>.</li>
        <li><b>Taxes:</b> GST is charged as required by law and shown on your receipt.</li>
        <li>We may change prices and the number of Chilli used per bill. We will show the new terms in the app or on this site before they apply to your next recharge.</li>
      </ul>

      <h2>4. What you may and may not do</h2>
      <ul>
        <li>Use Chilli Agent only for your own lawful business.</li>
        <li>Do not try to break, overload, copy or reverse-engineer the service, or access another restaurant's data.</li>
        <li>Do not use it to store anything unlawful, or to send spam or fake bills.</li>
        <li>You are responsible for the correctness of your menu, prices, tax settings, invoices and anything you tell your customers.</li>
      </ul>

      <h2>5. Your data</h2>
      <p>Your restaurant data (menu, orders, bills, customers, staff) belongs to you. We store and process it only to run the service for you, as explained in the <Link to="/privacy">Privacy Policy</Link>. You can ask us for an export of your data or for its deletion when you stop using the service.</p>

      <h2>6. Service availability</h2>
      <p>We work to keep Chilli Agent running and the waiter and counter apps are built to keep taking orders when the internet is down and to sync afterwards. We do not promise that the service will be free of interruptions or errors. We may do maintenance and updates, and we will try to do this at quiet times.</p>

      <h2>7. AI features</h2>
      <p>Voice ordering, bill scanning and the AI helper use automated systems that can make mistakes. They never place an order or change money without your staff confirming it. Please check what they suggest before you confirm.</p>

      <h2>8. Ending the service</h2>
      <p>You can stop using Chilli Agent at any time. We may suspend or end an account that breaks these terms, is used for fraud, or puts the service or other users at risk. We will tell you why where we can. On ending, you can ask for your data export (see section 5).</p>

      <h2>9. Our responsibility</h2>
      <p>To the extent the law allows, we are not liable for indirect or consequential losses (such as lost sales or profit), and our total liability for any claim about the service is limited to the amount you paid us in the three months before the claim. Nothing here limits liability that cannot be limited by law.</p>

      <h2>10. Changes to these terms</h2>
      <p>We may update these terms. The date at the top shows the latest version. If you keep using Chilli Agent after a change, you accept the new terms. For important changes we will also tell you in the app or by email.</p>

      <h2>11. Law and disputes</h2>
      <p>These terms follow the laws of India. Please write to us first at <a href={`mailto:${site.email}`}>{site.email}</a> so we can try to fix the problem. If it cannot be settled, the courts in India that have jurisdiction over our registered office will decide it.</p>
    </Legal>
  )
}

export function Privacy() {
  return (
    <Legal eyebrow="Legal" title="Privacy Policy" intro="What we collect, why, and the choices you have.">
      <h2>1. Who is responsible</h2>
      <p>{COMPANY} ("we", "us") runs Chilli Agent (thechilli.ai). For the account and business details you give us, we decide how the data is used. For the information your restaurant enters about its own guests and staff, your restaurant decides why it is collected and we process it for you.</p>

      <h2>2. What we collect</h2>
      <ul>
        <li><b>Account and business:</b> your name, email, phone number, restaurant name, city, GSTIN (if you add it), and your plan and billing history.</li>
        <li><b>Staff:</b> names, phone numbers, roles and login records of the people you add.</li>
        <li><b>Restaurant data:</b> menu, tables, orders, bills, payments recorded, stock, reports. If you add guest names or phone numbers (for example for a bill or a booking), that is stored for your restaurant.</li>
        <li><b>Voice and scans:</b> if you use voice ordering, the short audio or text of the order is sent to an AI service to turn it into text. If you scan a supplier bill, the image is sent to an AI service to read it. We use the result only to fill in the order or purchase for you.</li>
        <li><b>Device and usage:</b> app version, device type, errors and security logs, so we can keep the service safe and fix problems.</li>
        <li><b>Payments:</b> recharges are paid through Razorpay. We receive the payment status and the amount. We never see or store your full card number or UPI PIN.</li>
        <li><b>Messages to us:</b> what you write in the contact form or to {site.email}.</li>
      </ul>

      <h2>3. Why we use it</h2>
      <ul>
        <li>To provide, secure and improve Chilli Agent and to give support.</li>
        <li>To bill you, send receipts and service messages (for example a low Chilli balance).</li>
        <li>To follow the law, for example tax and accounting rules.</li>
        <li>To prevent fraud and misuse.</li>
      </ul>

      <h2>4. Who we share it with</h2>
      <p>We do not sell your data. We use a few service providers who process data for us, only as needed: cloud hosting in India (Mumbai region), email delivery, Razorpay for payments, and AI providers (Google Gemini) for voice and bill scanning. We may also share data when the law or a court requires it.</p>

      <h2>5. Where it is stored and for how long</h2>
      <p>Your data is stored on servers in India. Each restaurant's data is kept separate from every other restaurant's data. We keep data while your account is active and for as long as the law requires afterwards (for example tax records). You can ask us to delete your data when you leave, except what we must keep by law.</p>

      <h2>6. Security</h2>
      <p>Data is encrypted in transit, access is limited by roles, sensitive actions can need a PIN, and we keep logs of important actions. No system is perfectly secure, so please use a strong password and keep your devices locked.</p>

      <h2>7. Your rights</h2>
      <p>You can ask us to show, correct, export or delete your personal data, to withdraw a consent you gave, or to raise a complaint. Write to <a href={`mailto:${site.email}`}>{site.email}</a>. We aim to reply within 3 working days.</p>

      <h2>8. Children</h2>
      <p>Chilli Agent is for businesses. It is not meant for children, and we do not knowingly collect their data.</p>

      <h2>9. Cookies</h2>
      <p>Our website and apps use only the cookies and local storage needed to sign you in, keep your session and remember your settings. We do not use advertising cookies.</p>

      <h2>10. Changes</h2>
      <p>If we change this policy, we will update the date at the top and, for important changes, tell you in the app or by email.</p>
    </Legal>
  )
}

export function Refund() {
  return (
    <Legal eyebrow="Legal" title="Refund and Cancellation Policy" intro="How refunds and cancellations work for Chilli credits.">
      <h2>1. Free trial</h2>
      <p>The 7-day trial is free. There is nothing to cancel and nothing to refund.</p>

      <h2>2. Chilli credits are prepaid</h2>
      <p>When you recharge, the amount you pay is added to your account as Chilli (₹1 = 1 Chilli). Once Chilli have been added to your account and are available to use, they are not refundable and cannot be exchanged for cash or moved to another account.</p>

      <h2>3. When we do refund</h2>
      <p>We will refund you if:</p>
      <ul>
        <li>your payment was taken twice for the same recharge (duplicate payment), or</li>
        <li>your payment was taken but the Chilli were not added to your account, or</li>
        <li>there was a technical fault on our side that cost you Chilli you should not have lost.</li>
      </ul>
      <p>In these cases, write to <a href={`mailto:${site.email}`}>{site.email}</a> within 7 days with your restaurant name, the date and amount, and the Razorpay payment ID if you have it. We will check and, if the claim is right, refund the amount to the same payment method you used. Banks usually take 5 to 7 working days to show a refund after we send it.</p>

      <h2>4. Cancelling</h2>
      <p>You can stop using Chilli Agent whenever you like; there is no contract and no cancellation fee. Chilli that are left in your account when you stop are not refunded, except as described in section 3. You can ask us to delete your data (see the <Link to="/privacy">Privacy Policy</Link>).</p>

      <h2>5. How to reach us</h2>
      <p>Email <a href={`mailto:${site.email}`}>{site.email}</a>. We aim to reply within 3 working days.</p>
    </Legal>
  )
}
