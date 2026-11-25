import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react'
import VoiceOrb from '../../components/ui/VoiceOrb.jsx'

const SAY = '“Do chicken biryani, teen garlic naan aur ek lime soda”'
const LINES = [['2 ×', 'Chicken biryani'], ['3 ×', 'Garlic naan'], ['1 ×', 'Lime soda']]
const LABEL = { listen: 'Listening…', think: 'Understanding…', bill: 'Added to the bill' }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Looping voice-order demo: the orb listens, the sentence types out, then the bill fills in. Starts when scrolled into view. */
export default function VoiceDemo() {
  const ref = useRef(null)
  const inView = useInView(ref, { margin: '-80px' })
  const reduce = useReducedMotion()
  const [phase, setPhase] = useState('listen')
  const [chars, setChars] = useState(0)
  const [lines, setLines] = useState(0)

  useEffect(() => {
    if (reduce) { setPhase('bill'); setChars(SAY.length); setLines(LINES.length); return }
    if (!inView) return
    let dead = false
    ;(async () => {
      while (!dead) {
        setPhase('listen'); setLines(0); setChars(0)
        for (let i = 1; i <= SAY.length && !dead; i++) { setChars(i); await wait(42) }
        await wait(250); if (dead) return
        setPhase('think'); await wait(1000); if (dead) return
        setPhase('bill')
        for (let k = 1; k <= LINES.length && !dead; k++) { setLines(k); await wait(600) }
        await wait(3400)
      }
    })()
    return () => { dead = true }
  }, [inView, reduce])

  return (
    <div className="voice-card" ref={ref}>
      <div className={`voice-stage ${phase}`}>
        <div className="orb-wrap">
          <span className="ring r1" /><span className="ring r2" /><span className="ring r3" />
          <VoiceOrb />
        </div>
        <span className="mono" aria-live="polite">{LABEL[phase]}</span>
      </div>
      <div className="voice-row said">
        <small>You say</small>
        <p>{SAY.slice(0, chars)}<span className={`caret${phase === 'listen' ? ' on' : ''}`} /></p>
      </div>
      <div className="voice-row got">
        <small>On the bill</small>
        <ul>
          <AnimatePresence>
            {LINES.slice(0, lines).map(([q, n]) => (
              <motion.li key={n} initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
                <b>{q}</b> {n}
              </motion.li>
            ))}
          </AnimatePresence>
          {lines === 0 && <li className="muted">Waiting for the order…</li>}
        </ul>
      </div>
    </div>
  )
}
