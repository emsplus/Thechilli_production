import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useReducedMotion } from 'motion/react'
import { Check, Smartphone, ArrowRight } from 'lucide-react'
import { Reveal, Parallax } from '../../components/ui/Reveal.jsx'

const screens = [
  { src: '/screens/waiter-tables.webp', alt: 'Tables screen in the Chilli Staff app' },
  { src: '/screens/waiter-voice.webp', alt: 'Voice order sheet in the Chilli Staff app' },
  { src: '/screens/waiter-more.webp', alt: 'Sync queue in the Chilli Staff app' },
]

/** App download banner: copy and store buttons, a floating dish, and a tilted phone cycling through real app screens. */
export default function AppPromo() {
  const reduce = useReducedMotion()
  const [shot, setShot] = useState(0)

  useEffect(() => {
    if (reduce) return
    const t = setInterval(() => setShot((s) => (s + 1) % screens.length), 3200)
    return () => clearInterval(t)
  }, [reduce])

  return (
    <section className="app-promo">
      <div className="wrap ap-grid">
        <Reveal className="ap-copy" x={-60} y={0}>
          <span className="eyebrow">Chilli Staff app</span>
          <h2>Run the floor from your pocket</h2>
          <p>Waiters take orders at the table, send the KOT to the kitchen and keep working when the internet drops. In English or Hindi.</p>
          <ul className="ap-ticks">
            <li><Check size={16} strokeWidth={3} />Works offline, syncs later</li>
            <li><Check size={16} strokeWidth={3} />Hindi &amp; Hinglish voice orders</li>
          </ul>
          <div className="store-row">
            <Link to="/waiter-app" className="store"><Smartphone size={24} /><span><small>Chilli Staff app for</small>Android</span></Link>
            <Link to="/waiter-app" className="store"><Smartphone size={24} /><span><small>Chilli Staff app for</small>iOS</span></Link>
          </div>
          <Link to="/contact" className="ap-demo">Book a free demo <ArrowRight size={16} /></Link>
        </Reveal>

        <div className="ap-visual" aria-hidden="false">
          <span className="ap-blob" />
          <Parallax className="ap-layer" speed={-0.12}><div className="ap-dish">
            <img src="/menu/chicken-biryani.webp" alt="" width="360" height="240" />
            <i className="sp s1" /><i className="sp s2" /><i className="sp s3" /><i className="sp s4" />
          </div></Parallax>
          <div className="ap-toast t1"><span className="tick"><Check size={12} strokeWidth={3} /></span>KOT sent · Table 4</div>
          <div className="ap-toast t2"><span className="tick"><Check size={12} strokeWidth={3} /></span>₹945 paid by UPI</div>
          <Parallax className="ap-layer" speed={0.18}><div className="ap-phone">
            <div className="ap-screen">
              {screens.map((s, i) => <img key={s.src} src={s.src} alt={i === shot ? s.alt : ''} width="690" height="1500" loading="lazy" className={i === shot ? 'on' : ''} />)}
              <span className="ap-notch" />
            </div>
          </div></Parallax>
        </div>
      </div>
    </section>
  )
}
