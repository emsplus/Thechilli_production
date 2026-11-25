import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useReducedMotion } from 'motion/react'
import { ChevronLeft, ChevronRight, QrCode } from 'lucide-react'
import { menuBook } from '../data/content.js'

function MenuPageSide({ page, side }) {
  return (
    <div className={`mb-page ${side}`}>
      {page.photos.map((ph) => <img key={ph.src} className={`mb-photo ${ph.pos}`} src={ph.src} alt="" width="360" height="240" />)}
      <div className="mb-title"><span>{page.script}</span><b>{page.title}</b></div>
      <ul className="mb-items">
        {page.items.map((it) => (
          <li key={it.name}>
            <div className="mb-row"><b>{it.name}</b><i /><span>₹{it.price}</span></div>
            <p>{it.text}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function MenuPage() {
  const reduce = useReducedMotion()
  const [i, setI] = useState(0)
  const [flip, setFlip] = useState(null) // { dir: 1 | -1, to }
  const n = menuBook.length

  const go = (to, dir = to > i ? 1 : -1) => {
    to = (to + n) % n
    if (flip || to === i) return
    const instant = reduce || window.matchMedia('(max-width: 760px)').matches
    if (instant) { setI(to); return }
    setFlip({ dir, to })
  }
  const done = () => { setI(flip.to); setFlip(null) }

  useEffect(() => {
    const k = (e) => { if (e.key === 'ArrowRight') go(i + 1, 1); if (e.key === 'ArrowLeft') go(i - 1, -1) }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const cur = menuBook[i].pages
  const nxt = flip ? menuBook[flip.to].pages : null
  // What sits under the turning leaf, and what is printed on its two faces.
  const left = flip && flip.dir < 0 ? nxt[0] : cur[0]
  const right = flip && flip.dir > 0 ? nxt[1] : cur[1]
  const front = flip && (flip.dir > 0 ? cur[1] : cur[0])
  const back = flip && (flip.dir > 0 ? nxt[0] : nxt[1])

  return (
    <>
      <section className="menu-hero">
        <div className="wrap menu-hero-in">
          <span className="eyebrow">Digital menu</span>
          <h1><em>Food</em> <b>MENU</b></h1>
          <p>What your guests see when they scan the QR on the table. Updated from Chilli Agent the moment you change a dish or a price.</p>
        </div>
      </section>

      <section className="menu-book-sec">
        <div className="wrap">
          <div className="mb-tabs" role="tablist" aria-label="Menu sections">
            {menuBook.map((s, k) => <button key={s.tab} type="button" role="tab" aria-selected={k === (flip ? flip.to : i)} className={k === (flip ? flip.to : i) ? 'on' : ''} onClick={() => go(k)}>{s.tab}</button>)}
          </div>

          <div className="mb-layout">
            <div className="mb-cover" aria-label="Menu cover">
              <span className="mbc-strip" />
              <div className="mbc-brand">thechilli<small>.ai</small></div>
              <span className="mbc-swash" />
              <div className="mbc-plate"><img src="/images/kitchen-curry-960.webp" alt="Curry and rice in copper bowls" width="1400" height="933" /></div>
              <div className="mbc-band">
                <span className="mbc-today">Today's</span>
                <b>SPECIAL</b>
                <span className="mbc-label">FOOD MENU</span>
              </div>
            </div>

            <div className="mb-book">
              <div className="mb-spread">
                <div className="mb-side" onClick={() => go(i - 1, -1)} title="Previous page"><MenuPageSide page={left} side="left" /></div>
                <div className="mb-side" onClick={() => go(i + 1, 1)} title="Next page"><MenuPageSide page={right} side="right" /></div>
                {flip && (
                  <div className={`leaf ${flip.dir > 0 ? 'fwd' : 'back'}`} onAnimationEnd={(e) => e.target === e.currentTarget && done()}>
                    <div className="face front"><MenuPageSide page={front} side={flip.dir > 0 ? 'right' : 'left'} /></div>
                    <div className="face rear"><MenuPageSide page={back} side={flip.dir > 0 ? 'left' : 'right'} /></div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mb-nav">
            <button type="button" aria-label="Previous page" onClick={() => go(i - 1, -1)}><ChevronLeft size={20} /></button>
            <span>{(flip ? flip.to : i) + 1} / {n}</span>
            <button type="button" aria-label="Next page" onClick={() => go(i + 1, 1)}><ChevronRight size={20} /></button>
          </div>
          <p className="mb-note">Sample menu. Dishes and prices are illustrative.</p>
        </div>
      </section>

      <section className="menu-cta">
        <div className="wrap">
          <div className="mcta">
            <span className="mcta-ico"><QrCode size={40} /></span>
            <div><h2>Your menu, on every table.</h2><p>One QR per table. Guests browse, you update prices from Chilli Agent.</p></div>
            <Link to="/contact" className="btn btn-primary">Get this for my restaurant</Link>
          </div>
        </div>
      </section>
    </>
  )
}
