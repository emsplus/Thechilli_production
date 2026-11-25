import { useEffect, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { Mic, Check, ChefHat, Clock } from 'lucide-react'

/** Steps 0..n-1 on a timer, looping; frozen on the last step for reduced motion. */
function useLoop(times) {
  const reduce = useReducedMotion()
  const [step, setStep] = useState(reduce ? times.length - 1 : 0)
  useEffect(() => {
    if (reduce) return
    const t = setTimeout(() => setStep((s) => (s + 1) % times.length), times[step])
    return () => clearTimeout(t)
  }, [step, reduce, times])
  return step
}

function useTyped(text, on, speed = 45) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!on) { setN(0); return }
    if (n >= text.length) return
    const t = setTimeout(() => setN(n + 1), speed)
    return () => clearTimeout(t)
  }, [on, n, text, speed])
  return text.slice(0, on ? n : 0)
}

const VOICE_T = [600, 2600, 900, 900, 2600]
const said = 'Do butter chicken aur teen garlic naan, table 4'
const lines = [['Butter Chicken', 2, '560.00'], ['Garlic Naan', 3, '180.00']]

export function VoiceTile() {
  const step = useLoop(VOICE_T)
  const typed = useTyped(said, step >= 1)
  const listening = step === 1
  return (
    <div className="lt lt-voice">
      <span className="lt-title">Order by voice</span>
      <span className="lt-live"><i />LIVE</span>
      <div className={`lt-mic${listening ? ' on' : ''}`}>
        <span className="lt-orb"><Mic size={22} /></span>
        <span className="lt-wave">{Array.from({ length: 9 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 0.08}s` }} />)}</span>
      </div>
      <div className="lt-said"><small>Customer says</small>“{typed}<span className={`lt-caret${listening ? ' on' : ''}`} />”</div>
      <div className="lt-ticket">
        <div className="lt-th"><b>Table 4</b><span>New order</span></div>
        {lines.map(([n, q, p], i) => (
          <div key={n} className={`lt-line${step >= 2 + i ? ' in' : ''}`}><span>{q}×</span><b>{n}</b><em>₹{p}</em></div>
        ))}
        <div className={`lt-sent${step >= 4 ? ' in' : ''}`}><Check size={13} strokeWidth={3} />Sent to kitchen</div>
      </div>
    </div>
  )
}

const STATUS_T = [1600, 1600, 1600, 2200]
const stages = ['Received', 'Preparing', 'Ready', 'Served']

export function StatusTile() {
  const step = useLoop(STATUS_T)
  return (
    <div className="lt lt-status">
      <div className="ls-head">
        <span className="ls-ico"><ChefHat size={18} /></span>
        <p><b>KOT #128 · Table 4</b><small>2× Butter Chicken · 3× Garlic Naan</small></p>
        <span className="ls-time"><Clock size={12} />{['0:12', '4:30', '11:05', '13:40'][step]}</span>
      </div>
      <div className="ls-big" key={step}>
        <b>{stages[step]}</b>
        <small>{['Kitchen got the KOT', 'Chef is cooking', 'Waiter notified', 'On the table'][step]}</small>
      </div>
      <div className="ls-track">
        <i style={{ width: `${(step / (stages.length - 1)) * 100}%` }} />
        {stages.map((s, i) => (
          <span key={s} className={`ls-dot${i <= step ? ' done' : ''}${i === step ? ' now' : ''}`}>
            {i < step ? <Check size={11} strokeWidth={3.5} /> : null}
            <em>{s}</em>
          </span>
        ))}
      </div>
      <span className="lt-cap">Order status</span>
    </div>
  )
}

const BILL_T = [2200, 600, 600, 600, 700, 2800]
const billItems = [['Butter Chicken', 2, '280.00', '560.00'], ['Garlic Naan', 3, '60.00', '180.00']]

export function BillTile() {
  const step = useLoop(BILL_T)
  const typed = useTyped('Bhaiya, bill bana do', step === 0, 55)
  const show = (n) => (step >= n ? ' in' : '')
  return (
    <div className="lt lt-bill">
      <div className={`lb-ask${step === 0 ? ' in' : ''}`}>“{typed}”</div>
      <div className="lb-ipad">
        <div className="lb-screen">
          <div className="lb-head">
            <div><b>TAX INVOICE</b><small>INV/26-27/000128</small></div>
            <span className={step >= 1 ? 'ok' : ''}>{step >= 1 ? 'Generated' : 'Draft'}</span>
          </div>
          <div className="lb-meta"><span>Table 4 · Dine-in</span><span>01 Nov 2026, 8:42 PM</span></div>
          <div className="lb-table">
            <div className="lb-tr lb-thd"><span>Item</span><span>Qty</span><span>Rate</span><span>Amount</span></div>
            {billItems.map(([n, q, r, a], i) => (
              <div key={n} className={`lb-tr${show(1 + i)}`}><span>{n}</span><span>{q}</span><span>{r}</span><span>{a}</span></div>
            ))}
          </div>
          <div className={`lb-sum${show(3)}`}>
            <div><span>Subtotal</span><span>740.00</span></div>
            <div><span>CGST 2.5%</span><span>18.50</span></div>
            <div><span>SGST 2.5%</span><span>18.50</span></div>
          </div>
          <div className={`lb-total${show(4)}`}><span>Grand total</span><b>₹777.00</b></div>
        </div>
      </div>
      <span className="lt-cap">Instant bill on iPad</span>
    </div>
  )
}
