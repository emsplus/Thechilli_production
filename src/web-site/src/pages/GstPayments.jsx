import PageHero from '../components/ui/PageHero.jsx'
import Gst from '../sections/shared/Gst.jsx'
import Cta from '../sections/shared/Cta.jsx'
import Shot from '../components/ui/Shot.jsx'

export default function GstPayments() {
  return (
    <>
      <PageHero eyebrow="GST & payments" title="Tax and payments, handled in rupees." text="Correct GST on every bill, and the payment methods your guests actually use." />
      <Gst />
      <section>
        <div className="wrap feature-grid">
          <div className="feature-media"><Shot name="counter-payment" focus="50% 28%" alt="Customer paying with a phone at the counter" pos="br">
              <span className="sc-row"><b>Total ₹945</b></span>
              <small>CGST 2.5% · SGST 2.5% included</small>
            </Shot></div>
          <div className="feature-copy">
            <span className="eyebrow">At the counter</span>
            <h2>Cash, card and UPI on one bill.</h2>
            <p className="lead">Split a single bill across payment methods, and keep a clear record of every cancellation with a credit note.</p>
          </div>
        </div>
      </section>
      <Cta />
    </>
  )
}
