import Shot from '../../components/ui/Shot.jsx'
import { Reveal, Stagger } from '../../components/ui/Reveal.jsx'
import GlowCard from '../../components/ui/GlowCard.jsx'
import { deliveryItems } from '../../data/content.js'

export default function Delivery() {
  return (
    <section>
      <div className="wrap feature-grid">
        <Reveal className="feature-media">
          <Shot name="delivery-pizza" focus="50% 50%" alt="A freshly baked pizza ready to go out for delivery" pos="bl">
            <span className="sc-row"><span className="dot" /><b>Rider on the way</b></span>
            <small>Arriving in 12 min</small>
            <span className="sc-bar"><i /></span>
          </Shot>
        </Reveal>
        <div className="feature-copy">
          <span className="eyebrow">Delivery & online orders</span>
          <h2>Bring every order into one place.</h2>
          <Stagger className="stack" gap={0.1}>
            {deliveryItems.map((d) => (
              <GlowCard tilt={false} className="row-card" key={d.title}>
                <div><h3>{d.title}</h3><p>{d.text}</p></div>
                <span className={`pill${d.tag === 'Coming soon' ? ' soon' : ''}`}>{d.tag}</span>
              </GlowCard>
            ))}
          </Stagger>
        </div>
      </div>
    </section>
  )
}
