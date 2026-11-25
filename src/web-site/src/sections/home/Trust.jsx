import { trust } from '../../data/content.js'
import Icon from '../../components/ui/Icon.jsx'
import { Reveal, Stagger } from '../../components/ui/Reveal.jsx'
import GlowCard from '../../components/ui/GlowCard.jsx'

export default function Trust() {
  return (
    <section className="trust">
      <div className="wrap">
        <Reveal className="head center">
          <span className="brand-small">thechilli.ai</span>
          <h2>Built to be trusted</h2>
        </Reveal>
        <Stagger className="three">
          {trust.map((t) => (
            <GlowCard className="mod" key={t.title}>
              <span className="mod-ico"><Icon name={t.icon} /></span>
              <h3>{t.title}</h3>
              <p>{t.text}</p>
            </GlowCard>
          ))}
        </Stagger>
      </div>
    </section>
  )
}
