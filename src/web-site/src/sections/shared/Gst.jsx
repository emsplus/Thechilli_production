import { gstPoints } from '../../data/content.js'
import { Reveal, Stagger } from '../../components/ui/Reveal.jsx'
import GlowCard from '../../components/ui/GlowCard.jsx'

export default function Gst() {
  return (
    <section className="dark-band">
      <div className="wrap">
        <Reveal className="head">
          <span className="eyebrow">Built for India</span>
          <h2>Three things we handle for you.</h2>
        </Reveal>
        <Stagger className="three">
          {gstPoints.map((g) => (
            <GlowCard dark className="dcard" key={g.title}><h3>{g.title}</h3><p>{g.text}</p></GlowCard>
          ))}
        </Stagger>
      </div>
    </section>
  )
}
