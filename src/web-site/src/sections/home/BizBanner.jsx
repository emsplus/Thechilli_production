import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useReducedMotion } from 'motion/react'
import { ArrowRight } from 'lucide-react'
import Img from '../../components/ui/Img.jsx'
import { Reveal } from '../../components/ui/Reveal.jsx'

const photos = [
  { name: 'interior-modern', label: 'Fine dining', alt: 'A modern restaurant dining room' },
  { name: 'hero-restaurant', label: 'Casual dining', alt: 'Guests dining in a warmly lit restaurant' },
  { name: 'cafe', label: 'Café', alt: 'An outdoor café terrace by the water' },
  { name: 'dining', label: 'Table service', alt: 'A plated dish served at a restaurant table' },
  { name: 'counter-payment', label: 'Quick service', alt: 'A guest paying by phone at a counter' },
]

export default function BizBanner() {
  const reduce = useReducedMotion()
  const [cur, setCur] = useState(0)
  const [hold, setHold] = useState(false)

  useEffect(() => {
    if (reduce || hold) return
    const t = setInterval(() => setCur((c) => (c + 1) % photos.length), 3500)
    return () => clearInterval(t)
  }, [reduce, hold])

  return (
    <section className="biz-sec">
      <div className="wrap">
        <Reveal className="biz" scale={0.92} y={40}>
          <div className="biz-copy">
            <span className="eyebrow">Multi-outlet</span>
            <h2>Running more than one outlet?</h2>
            <p>Staff, shifts, cash drawers and reports for every location, from one login. Add your own delivery with live rider tracking.</p>
            <Link to="/contact" className="btn btn-primary">Talk to sales <ArrowRight size={17} /></Link>
          </div>
          <div className="biz-photo" onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(false)}>
            {photos.map((p, i) => (
              <div key={p.name} className={`biz-slide${i === cur ? ' on' : ''}`} aria-hidden={i !== cur}>
                <Img name={p.name} alt={p.alt} sizes="(min-width: 900px) 620px, 92vw" eager={i < 2} />
              </div>
            ))}
            <span className="biz-label" key={photos[cur].label}>{photos[cur].label}</span>
            <div className="biz-dots">
              {photos.map((p, i) => (
                <button key={p.name} type="button" aria-label={`Show ${p.label}`} className={i === cur ? 'on' : ''} onClick={() => setCur(i)}>
                  {i === cur && !reduce && !hold && <i />}
                </button>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
