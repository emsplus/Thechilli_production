import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useReducedMotion } from 'motion/react'
import { Monitor, Smartphone, ChefHat, Receipt, Mic, Bike, ChevronLeft, ChevronRight } from 'lucide-react'
import { Reveal } from '../../components/ui/Reveal.jsx'

const cards = [
  { Icon: Monitor, title: 'Counter billing', text: 'Dine-in, takeaway and delivery on one screen.', sample: 'Table 4 · 3 items · ₹945', to: '/features', tone: 'pink' },
  { Icon: Smartphone, title: 'Waiter app', text: 'Orders from the table, even when the internet drops.', sample: 'T7 → 2 × Paneer Tikka', to: '/waiter-app', tone: 'blue' },
  { Icon: ChefHat, title: 'Kitchen display', text: 'Every KOT on screen and on the printer.', sample: 'KOT #128 · 2 min ago', to: '/features', tone: 'sky' },
  { Icon: Receipt, title: 'GST billing', text: 'CGST, SGST and IGST, rounded exactly.', sample: 'CGST 2.5% ₹22.50', to: '/gst-payments', tone: 'mint' },
  { Icon: Mic, title: 'Voice orders', text: 'Speak in Hindi or Hinglish, bill in English.', sample: '“do butter naan, ek dal”', to: '/features', tone: 'lilac' },
  { Icon: Bike, title: 'Delivery', text: 'Your own riders with a live tracking link.', sample: 'Rider on the way · 12 min', to: '/delivery', tone: 'lemon' },
]
const N = cards.length

/** Fanned card carousel: drag, use the arrows or let it turn. */
export default function FanCards() {
  const reduce = useReducedMotion()
  const [active, setActive] = useState(2)
  const [paused, setPaused] = useState(false)
  const drag = useRef(null)

  const go = (d) => setActive((a) => (a + d + N) % N)

  useEffect(() => {
    if (reduce || paused) return
    const t = setInterval(() => go(1), 3200)
    return () => clearInterval(t)
  }, [reduce, paused])

  const down = (e) => { drag.current = e.clientX; setPaused(true) }
  const up = (e) => {
    if (drag.current == null) return
    const dx = e.clientX - drag.current
    drag.current = null
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1)
  }

  return (
    <section className="fan-sec">
      <div className="wrap">
        <Reveal className="fan-head" x={-50} y={0}>
          <span className="eyebrow">Use cases</span>
          <h2>Made for the way restaurants run.</h2>
          <p>Six places Chilli Agent fits. Drag, use the arrows, or let it turn.</p>
        </Reveal>
        <div
          className="fan"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => { setPaused(false); drag.current = null }}
          onPointerDown={down}
          onPointerUp={up}
          onKeyDown={(e) => { if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1) }}
          tabIndex={0}
          role="region"
          aria-roledescription="carousel"
          aria-label="Use cases"
        >
          {cards.map((c, i) => {
            let o = i - active
            if (o > N / 2) o -= N
            if (o < -N / 2) o += N
            const a = Math.abs(o)
            return (
              <article
                key={c.title}
                className={`fan-card ${c.tone}${o === 0 ? ' on' : ''}`}
                style={{ '--o': o, '--a': a, zIndex: 10 - a, opacity: a > 2 ? 0 : 1 }}
                aria-hidden={o !== 0}
                onClick={() => o !== 0 && setActive(i)}
              >
                <span className="fc-ico"><c.Icon size={22} /></span>
                <small>0{i + 1}</small>
                <h3>{c.title}</h3>
                <p>{c.text}</p>
                <code>{c.sample}</code>
                <Link to={c.to} className="fc-btn" tabIndex={o === 0 ? 0 : -1}>See it live</Link>
              </article>
            )
          })}
        </div>
        <div className="fan-nav">
          <button type="button" aria-label="Previous" onClick={() => go(-1)}><ChevronLeft size={20} /></button>
          <div className="fan-dots">{cards.map((c, i) => <button key={c.title} type="button" aria-label={c.title} className={i === active ? 'on' : ''} onClick={() => setActive(i)} />)}</div>
          <button type="button" aria-label="Next" onClick={() => go(1)}><ChevronRight size={20} /></button>
        </div>
      </div>
    </section>
  )
}
