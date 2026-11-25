import Icon from '../../components/ui/Icon.jsx'
import { Reveal, Stagger, StaggerItem } from '../../components/ui/Reveal.jsx'

/** One alternating photo/text row. `media` is any node; `flip` puts the media on the left. */
export default function Feature({ id, eyebrow, title, text, points, media, flip, tone }) {
  return (
    <section id={id} className={`feature ${tone || ''}`}>
      <div className={`wrap feature-grid${flip ? ' flip' : ''}`}>
        <div className="feature-copy">
          <Reveal><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p className="lead">{text}</p></Reveal>
          <Stagger as="ul" className="ticks" gap={0.09}>
            {points.map((p) => <StaggerItem as="li" key={p}><Icon name="check" size={16} />{p}</StaggerItem>)}
          </Stagger>
        </div>
        <Reveal className="feature-media" delay={0.12}>{media}</Reveal>
      </div>
    </section>
  )
}
