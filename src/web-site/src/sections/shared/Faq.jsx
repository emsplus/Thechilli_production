import { faqs } from '../../data/content.js'
import { Reveal, Stagger, StaggerItem } from '../../components/ui/Reveal.jsx'

export default function Faq() {
  return (
    <section className="faq">
      <div className="wrap narrow">
        <Reveal className="head center"><span className="eyebrow">FAQ</span><h2>Questions, answered.</h2></Reveal>
        <Stagger gap={0.07}>{faqs.map((f) => <StaggerItem key={f.q}><details><summary>{f.q}</summary><p>{f.a}</p></details></StaggerItem>)}</Stagger>
      </div>
    </section>
  )
}
