import { Link } from 'react-router-dom'
import { plans } from '../../data/content.js'
import Icon from '../../components/ui/Icon.jsx'
import { Stagger } from '../../components/ui/Reveal.jsx'
import GlowCard from '../../components/ui/GlowCard.jsx'

export default function Pricing() {
  return (
    <section>
      <div className="wrap">
        <Stagger className="three plans">
          {plans.map((p) => (
            <GlowCard tilt={false} className={`plan${p.hot ? ' hot' : ''}`} key={p.name}>
              {p.hot && <span className="badge">Most popular</span>}
              <h3>{p.name}</h3>
              <div className="amt">{p.price}</div>
              <p>{p.blurb}</p>
              <ul>{p.items.map((i) => <li key={i}><Icon name="check" size={16} />{i}</li>)}</ul>
              {p.href
                ? <a href={p.href} className={`btn ${p.hot ? 'btn-primary' : 'btn-outline'}`}>{p.cta}</a>
                : <Link to="/contact" className={`btn ${p.hot ? 'btn-primary' : 'btn-outline'}`}>{p.cta}</Link>}
            </GlowCard>
          ))}
        </Stagger>
      </div>
    </section>
  )
}
