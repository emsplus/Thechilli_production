import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Heart, Star } from 'lucide-react'
import { Reveal } from '../../components/ui/Reveal.jsx'

const dishes = [
  { name: 'Chicken Biryani', price: '320.00', img: 'chicken-biryani', tone: 'coral', cat: 'Mains' },
  { name: 'Garlic Naan', price: '60.00', img: 'garlic-naan', tone: 'orange', cat: 'Breads' },
  { name: 'Tikka Roll', price: '180.00', img: 'chicken-tikka-roll', tone: 'green', cat: 'Rolls' },
  { name: 'Rogan Josh', price: '420.00', img: 'lamb-rogan-josh', tone: 'purple', cat: 'Mains' },
  { name: 'Aloo Gobi', price: '220.00', img: 'aloo-gobi', tone: 'green', cat: 'Mains' },
  { name: 'Lime Soda', price: '90.00', img: 'lime-soda', tone: 'purple', cat: 'Drinks' },
]
const cats = ['All', 'Mains', 'Breads', 'Rolls', 'Drinks']

/** Menu carousel: shows how items look on the counter and waiter app. */
export default function MenuStrip() {
  const ref = useRef(null)
  const [cat, setCat] = useState('All')
  const shown = cat === 'All' ? dishes : dishes.filter((d) => d.cat === cat)
  const go = (dir) => {
    const el = ref.current
    if (el) el.scrollBy({ left: dir * (el.firstElementChild?.getBoundingClientRect().width + 22 || 230), behavior: 'smooth' })
  }
  return (
    <section className="menu-strip">
      <div className="wrap">
        <Reveal y={60} scale={0.96}>
          <div className="tabs" role="tablist" aria-label="Menu categories">
            {cats.map((c) => (
              <button key={c} type="button" role="tab" aria-selected={cat === c} className={cat === c ? 'on' : ''} onClick={() => { setCat(c); ref.current?.scrollTo({ left: 0 }) }}>{c}</button>
            ))}
          </div>
          <div className="panel-wrap">
            <button type="button" className="arrow l" aria-label="Previous dishes" onClick={() => go(-1)}><ChevronLeft size={24} /></button>
            <div className="panel">
            <div className="dish-row" ref={ref} tabIndex={0} aria-label="Sample menu items">
              {shown.map((d) => (
                <article className={`dish ${d.tone}`} key={d.name}>
                  <img src={`/menu/${d.img}.webp`} alt={d.name} width="360" height="240" loading="lazy" />
                  <h3>{d.name}</h3>
                  <div className="dish-price">
                    <b>₹{d.price}</b>
                    <span className="heart"><Heart size={13} fill="currentColor" /></span>
                  </div>
                  <div className="dish-foot">
                    <span className="order">Add to bill <ChevronRight size={12} strokeWidth={3} /></span>
                    <span className="rate"><Star size={11} fill="currentColor" /> 5.0</span>
                  </div>
                </article>
              ))}
            </div>
            </div>
            <button type="button" className="arrow r" aria-label="Next dishes" onClick={() => go(1)}><ChevronRight size={24} /></button>
          </div>
          <div className="center-link"><Link to="/menu" className="btn btn-outline">View full menu</Link></div>
        </Reveal>
      </div>
    </section>
  )
}
