import Feature from './Feature.jsx'
import VoiceDemo from './VoiceDemo.jsx'
import Shot from '../../components/ui/Shot.jsx'
import Img from '../../components/ui/Img.jsx'
import { counterPoints, waiterPoints, kitchenPoints, voicePoints, stockPoints } from '../../data/content.js'

export default function Showcase({ ids }) {
  const show = (id) => !ids || ids.includes(id)
  return (
    <>
      {show('counter') && (
      <Feature
        id="counter"
        eyebrow="Counter & billing"
        title="Fast at the counter, careful with the money."
        text="Take any kind of order, bill it in seconds and keep every cancellation accountable."
        points={counterPoints}
        media={
          <Shot name="counter-payment" focus="50% 28%" alt="Cashier taking a contactless payment from a customer at the counter">
            <span className="sc-row"><span className="dot" /><b>Paid · ₹945</b></span>
            <small>UPI · Table 4 · bill closed</small>
          </Shot>
        }
      />
      )}
      {show('waiter') && (
      <Feature
        id="waiter"
        flip
        tone="alt"
        eyebrow="Chilli Staff app"
        title="Waiters take orders at the table, even offline."
        text="A simple mobile app for your floor team. Orders reach the kitchen right away, and nothing is lost when Wi-Fi is."
        points={waiterPoints}
        media={
          <div className="duo">
            <Shot name="dining" focus="50% 60%" alt="Plated dishes being served at a restaurant table" />
            <div className="phone duo-phone"><img src="/screens/waiter-welcome.webp" alt="Chilli Staff sign-in screen" width="402" height="874" loading="lazy" /></div>
          </div>
        }
      />
      )}
      {show('kitchen') && (
      <Feature
        id="kitchen"
        eyebrow="Kitchen & printing"
        title="Orders reach the kitchen the moment they're sent."
        text="Cooks see a live screen, and tickets print on the printer next to them."
        points={kitchenPoints}
        media={
          <Shot name="kitchen-curry" focus="50% 45%" alt="Freshly served Indian curries with rice, ready to go out" pos="tr">
            <span className="sc-row"><b>KOT #128 · Table 4</b><span className="pill">Preparing</span></span>
            <ul className="sc-list"><li>2 × Chicken biryani</li><li>3 × Garlic naan</li></ul>
          </Shot>
        }
      />
      )}
      {show('voice') && (
      <Feature
        id="voice"
        flip
        tone="alt"
        eyebrow="Voice ordering"
        title="Just say the order."
        text="Speak in Hindi or Hinglish. Chilli Agent turns it into the right items on the bill."
        points={voicePoints}
        media={
          <div className="voice-duo">
            <VoiceDemo />
            <figure className="screen">
              <div className="phone"><img src="/screens/waiter-voice.webp" alt="Voice order sheet in the Chilli Staff app, with a Hold to talk button" width="402" height="874" loading="lazy" /></div>
              <figcaption><span>From the real app</span></figcaption>
            </figure>
          </div>
        }
      />
      )}
      {show('inventory') && (
      <Feature
        id="inventory"
        eyebrow="Inventory"
        title="Know what's in the kitchen without counting twice."
        text="Stock moves as you sell and as you buy, so you can see problems before they hit a shift."
        points={stockPoints}
        media={
          <Shot name="plates" focus="50% 40%" alt="Prepared dishes on a table beside fresh ingredients" pos="br">
            <span className="sc-row"><b>Low stock</b><span className="pill soon">Reorder</span></span>
            <small>Paneer · 2 kg left</small>
          </Shot>
        }
      />
      )}
    </>
  )
}
