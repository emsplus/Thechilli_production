import { motion } from 'motion/react'
import { modules } from '../../data/content.js'
import Icon from '../../components/ui/Icon.jsx'
import GlowCard from '../../components/ui/GlowCard.jsx'
import { Stagger } from '../../components/ui/Reveal.jsx'
import VoiceOrb from '../../components/ui/VoiceOrb.jsx'

const wide = new Set(['Orders & billing', 'Reports', 'Payments'])
const order = ['Orders & billing', 'Menu & tables', 'Inventory', 'Reports', 'Staff & roles', 'Voice ordering', 'Bill scan', 'India GST', 'Payments']

const Bars = () => (
  <div className="bv bars-v">
    {[38, 62, 48, 80, 58, 92, 70].map((h, i) => (
      <motion.i key={i} initial={{ scaleY: 0 }} whileInView={{ scaleY: 1 }} viewport={{ once: true }} transition={{ delay: 0.25 + i * 0.07, type: 'spring', stiffness: 120, damping: 14 }} style={{ height: `${h}%`, originY: 1 }} />
    ))}
  </div>
)
const Receipt = () => (
  <div className="bv receipt-v">
    <span><i />Chicken biryani × 2<b>640</b></span>
    <span><i />Garlic naan × 3<b>180</b></span>
    <span><i />Lime soda × 1<b>80</b></span>
    <span><i />CGST + SGST 5%<b>45</b></span>
    <span className="tot">Total<b>₹945</b></span>
  </div>
)
const Chips = ({ items }) => <div className="bv chips-v">{items.map((c) => <span key={c}>{c}</span>)}</div>

const visuals = {
  'Orders & billing': <Receipt />,
  Reports: <Bars />,
  'Voice ordering': <div className="bv orb-v"><VoiceOrb className="mini big" /></div>,
  'India GST': <Chips items={['CGST', 'SGST', 'IGST']} />,
  'Payments': <Chips items={['UPI', 'Card', 'Cash']} />,
  Inventory: <div className="bv stock-v"><span><i style={{ width: '72%' }} />Rice</span><span className="low"><i style={{ width: '18%' }} />Paneer</span></div>,
}

/** Bento grid of the product modules: mixed card sizes, a live mini-visual in many cards, spotlight + tilt on hover. */
export default function ModuleBento() {
  const byTitle = Object.fromEntries(modules.map((m) => [m.title, m]))
  return (
    <Stagger className="bento" gap={0.07}>
      {order.map((t) => {
        const m = byTitle[t]
        return (
          <GlowCard key={t} className={`mod${wide.has(t) ? ' w2' : ''}`}>
            <span className="mod-ico"><Icon name={m.icon} /></span>
            <h3>{m.title}</h3>
            <p>{m.text}</p>
            {visuals[t]}
          </GlowCard>
        )
      })}
    </Stagger>
  )
}
