import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react'
import { Play, Sparkles, WifiOff, ShoppingCart, BarChart3, SlidersHorizontal } from 'lucide-react'
import { heroPoints } from '../../data/content.js'
import Icon from '../../components/ui/Icon.jsx'
import VoiceOrb from '../../components/ui/VoiceOrb.jsx'
import AiStatus from './AiStatus.jsx'

const ease = [0.22, 1, 0.36, 1]

// Real screens from Chilli Agent (demo outlet), shown in the hero window.
const shots = [
  { key: 'pos', label: 'Billing', Icon: ShoppingCart, src: '/screens/app-pos.webp', alt: 'Chilli Agent: menu grid with dishes, categories and the order summary' },
  { key: 'reports', label: 'Reports', Icon: BarChart3, src: '/screens/app-reports.webp', alt: 'Chilli Agent reports: gross sales, net sales, GST collected and order types' },
  { key: 'manage', label: 'Manage', Icon: SlidersHorizontal, src: '/screens/app-manage.webp', alt: 'Chilli Agent manage: checking the lines of a scanned purchase invoice' },
]

export default function Hero() {
  const reduce = useReducedMotion()
  const [shot, setShot] = useState(0)
  const [hold, setHold] = useState(false)
  useEffect(() => {
    if (reduce || hold) return
    const t = setInterval(() => setShot((v) => (v + 1) % shots.length), 4200)
    return () => clearInterval(t)
  }, [reduce, hold])
  const { scrollY } = useScroll()
  const plateY = useTransform(scrollY, [0, 700], [0, 70])
  const plateR = useTransform(scrollY, [0, 700], [0, 3])
  const glassY = useTransform(scrollY, [0, 700], [0, -70])
  const copyY = useTransform(scrollY, [0, 700], [0, 60])
  const copyO = useTransform(scrollY, [0, 500], [1, 0.2])
  const up = (d) => (reduce ? {} : { initial: { opacity: 0, y: 30 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.8, delay: d, ease } })
  const pop = (d) => (reduce ? {} : { initial: { opacity: 0, scale: 0.7 }, animate: { opacity: 1, scale: 1 }, transition: { duration: 0.9, delay: d, ease } })
  return (
    <section className="hero">
      <div className="aurora" aria-hidden="true"><i /><i /><i /></div>
      <div className="wrap hero-grid">
        <motion.div className="hero-copy" style={reduce ? undefined : { y: copyY, opacity: copyO }}>
          <motion.span className="ai-pill" {...up(0)}><VoiceOrb className="mini" /><span className="ai-shimmer">AI-powered restaurant billing</span></motion.span>
          <motion.h1 {...up(0.05)}>AI agents run <span className="hl-o">Indian</span> restaurants.</motion.h1>
          <motion.p className="hero-lead" {...up(0.18)}>Take orders at the counter and on the floor, send them to the kitchen, bill with GST and get paid by UPI, card or cash. One system, in the cloud.</motion.p>
          <motion.div className="cta-row" {...up(0.3)}>
            <a href="/signup" className="btn btn-primary btn-lg btn-ai"><Sparkles size={17} />Get started</a>
            <Link to="/contact" className="btn btn-dark btn-lg">Book a demo</Link>
            <Link to="/features" className="play-btn" aria-label="See what's inside"><Play size={18} fill="currentColor" /></Link>
          </motion.div>
          <ul className="chips">
            {heroPoints.map((p) => <li key={p}><Icon name="check" size={14} />{p}</li>)}
          </ul>
        </motion.div>

        <motion.div className="hero-visual pos-visual" {...pop(0.15)} onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(false)}>
          <span className="blob b1" />
          <motion.div className="pos-window" style={reduce ? undefined : { y: plateY, rotate: plateR }}>
            <div className="pw-bar">
              <span className="pw-dots"><i /><i /><i /></span>
              <div className="pw-tabs" role="tablist" aria-label="Product screens">
                {shots.map((sh, k) => (
                  <button key={sh.key} type="button" role="tab" aria-selected={k === shot} className={k === shot ? 'on' : ''} onClick={() => setShot(k)}>
                    <sh.Icon size={13} />{sh.label}
                  </button>
                ))}
              </div>
              <span className="pw-live"><i />Live</span>
            </div>
            <AiStatus />
            <div className="pw-screen">
              {shots.map((sh, k) => <img key={sh.key} src={sh.src} alt={k === shot ? sh.alt : ''} width="1600" height="860" className={k === shot ? 'on' : ''} fetchpriority={k === 0 ? 'high' : undefined} loading={k === 0 ? 'eager' : 'lazy'} />)}
            </div>
          </motion.div>
          <motion.div className="pay-card" style={reduce ? undefined : { y: glassY }}>
            <img src="/screens/app-payment.webp" alt="Payment complete screen with a ₹400 tax invoice" width="520" height="835" />
          </motion.div>
          <div className="offline-chip"><span className="gi"><WifiOff size={16} /></span><p><b>Works offline</b><small>Orders sync when internet returns</small></p></div>
        </motion.div>
      </div>
    </section>
  )
}
