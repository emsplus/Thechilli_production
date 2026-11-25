import { useEffect, useMemo, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { Reveal } from '../../components/ui/Reveal.jsx'

const F = 'Poppins, Figtree, sans-serif'

function WaiterScene() {
  return (
    <svg viewBox="0 0 220 190" aria-hidden="true">
      {/* table */}
      <ellipse cx="166" cy="128" rx="40" ry="11" fill="#C98A4B" />
      <rect x="162" y="128" width="8" height="44" fill="#A86B35" />
      <ellipse cx="166" cy="173" rx="17" ry="4" fill="#A86B35" />
      <ellipse cx="158" cy="123" rx="14" ry="4.5" fill="#fff" />
      <ellipse cx="158" cy="121.5" rx="8" ry="2.6" fill="#F08A3A" />
      <rect x="176" y="108" width="8" height="15" rx="2" fill="#CFEFFF" opacity=".9" />
      {/* waiter */}
      <rect x="70" y="128" width="9" height="44" rx="4" fill="#1F2937" />
      <rect x="83" y="128" width="9" height="44" rx="4" fill="#1F2937" />
      <ellipse cx="74" cy="173" rx="7" ry="3" fill="#111820" />
      <ellipse cx="88" cy="173" rx="7" ry="3" fill="#111820" />
      <rect x="62" y="78" width="38" height="56" rx="14" fill="#fff" stroke="#EDE5DB" />
      <path d="M66 100h30v30q-15 7-30 0z" fill="#E50914" />
      <path d="M70 100l-4-18M92 100l4-18" stroke="#E50914" strokeWidth="2" />
      <rect x="76" y="68" width="10" height="12" rx="3" fill="#F2C4A0" />
      <path d="M74 79l7 7 7-7" fill="none" stroke="#E50914" strokeWidth="2" />
      <circle cx="81" cy="55" r="15" fill="#F5C9A6" />
      <path d="M66 56q0-21 16-21q16 0 16 19q-6-11-16-11q-10 0-16 13z" fill="#2B1B17" />
      <path d="M95 46q15 6 9 28q-4-13-11-17z" fill="#2B1B17" />
      <rect x="95" y="44" width="6" height="4" rx="2" fill="#E50914" transform="rotate(25 98 46)" />
      <circle cx="76" cy="56" r="1.7" fill="#2B1B17" />
      <circle cx="86" cy="56" r="1.7" fill="#2B1B17" />
      <circle cx="72.5" cy="61" r="2.4" fill="#F59E9E" opacity=".6" />
      <circle cx="89.5" cy="61" r="2.4" fill="#F59E9E" opacity=".6" />
      <path d="M77 62q4 3.5 8 0" fill="none" stroke="#7A3B2E" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M68 86q0 18 18 16" fill="none" stroke="#F2C4A0" strokeWidth="7" strokeLinecap="round" />
      <path d="M96 86q4 14-4 18" fill="none" stroke="#F2C4A0" strokeWidth="7" strokeLinecap="round" />
      <g transform="rotate(-10 92 100)">
        <rect x="84" y="86" width="17" height="27" rx="3.5" fill="#111820" />
        <rect x="86" y="89" width="13" height="20" rx="1.5" fill="#fff" />
        <rect x="88" y="92" width="9" height="2" rx="1" fill="#E50914" />
        <rect x="88" y="96" width="7" height="2" rx="1" fill="#CBD5E1" />
        <rect x="88" y="100" width="8" height="2" rx="1" fill="#CBD5E1" />
        <circle className="tap" cx="93" cy="105" r="2.4" fill="#FF5A1F" />
      </g>
      {/* order bubble */}
      <g className="bubble">
        <rect x="112" y="18" width="98" height="46" rx="10" fill="#fff" stroke="#F1E4D4" />
        <path d="M120 64l-6 9 14-9z" fill="#fff" />
        <text x="122" y="35" fontFamily={F} fontSize="9" fontWeight="700" fill="#111820">2× Chicken Biryani</text>
        <text x="122" y="49" fontFamily={F} fontSize="9" fontWeight="600" fill="#566070">3× Garlic Naan</text>
        <text x="122" y="59" fontFamily={F} fontSize="7" fontWeight="600" fill="#FF5A1F">Table 4</text>
      </g>
    </svg>
  )
}

function KitchenScene() {
  return (
    <svg viewBox="0 0 220 190" aria-hidden="true">
      <rect x="34" y="12" width="152" height="80" rx="9" fill="#111820" />
      <rect x="34" y="12" width="152" height="12" rx="6" fill="#1F2937" />
      <circle cx="44" cy="18" r="2" fill="#16A34A" />
      <text x="50" y="20.5" fontFamily={F} fontSize="6.5" fontWeight="600" fill="#9CA3AF">Kitchen display</text>
      <g className="kot-new">
        <rect x="42" y="30" width="66" height="54" rx="5" fill="#fff" />
        <rect x="42" y="30" width="66" height="13" rx="5" fill="#E50914" />
        <text x="48" y="39.5" fontFamily={F} fontSize="7.5" fontWeight="700" fill="#fff">KOT #128 · T4</text>
        <text x="48" y="54" fontFamily={F} fontSize="7" fontWeight="600" fill="#111820">2× Biryani</text>
        <text x="48" y="65" fontFamily={F} fontSize="7" fontWeight="600" fill="#111820">3× Garlic Naan</text>
        <text x="48" y="78" fontFamily={F} fontSize="6" fontWeight="600" fill="#FF5A1F">NEW · 0:12</text>
      </g>
      <rect x="114" y="30" width="64" height="54" rx="5" fill="#fff" opacity=".9" />
      <rect x="114" y="30" width="64" height="13" rx="5" fill="#16A34A" />
      <text x="120" y="39.5" fontFamily={F} fontSize="7.5" fontWeight="700" fill="#fff">KOT #127 · T2</text>
      <text x="120" y="54" fontFamily={F} fontSize="7" fontWeight="600" fill="#111820">1× Dal Makhani</text>
      <text x="120" y="65" fontFamily={F} fontSize="7" fontWeight="600" fill="#111820">2× Butter Naan</text>
      <text x="120" y="78" fontFamily={F} fontSize="6" fontWeight="600" fill="#16A34A">READY</text>
      <rect x="18" y="130" width="184" height="12" rx="3" fill="#E7D3B8" />
      <rect x="22" y="142" width="176" height="34" rx="2" fill="#CDAE88" />
      <rect x="40" y="150" width="40" height="18" rx="3" fill="#BF9E77" />
      <rect x="140" y="150" width="40" height="18" rx="3" fill="#BF9E77" />
      <g className="steam" fill="none" stroke="#C9CED6" strokeWidth="2.5" strokeLinecap="round">
        <path d="M70 100q-5-6 0-12t0-12" />
        <path d="M82 102q-5-6 0-12t0-12" />
        <path d="M94 100q-5-6 0-12t0-12" />
      </g>
      <rect x="58" y="106" width="48" height="25" rx="7" fill="#6B7280" />
      <rect x="58" y="106" width="48" height="7" rx="3" fill="#9CA3AF" />
      <rect x="50" y="113" width="10" height="5" rx="2" fill="#4B5563" />
      <rect x="104" y="113" width="10" height="5" rx="2" fill="#4B5563" />
      <rect className="print-ticket" x="146" y="88" width="30" height="24" rx="2" fill="#fff" stroke="#EDE5DB" />
      <rect x="138" y="108" width="46" height="23" rx="5" fill="#374151" />
      <rect x="144" y="110" width="34" height="3" rx="1.5" fill="#111820" />
      <circle cx="176" cy="123" r="2" fill="#16A34A" />
    </svg>
  )
}

function InvoiceScene() {
  const rows = [['Chicken Biryani ×2', '640.00'], ['Garlic Naan ×3', '180.00'], ['Lime Soda ×1', '80.00']]
  return (
    <svg viewBox="0 0 220 190" aria-hidden="true">
      <rect x="44" y="6" width="132" height="16" rx="6" fill="#374151" />
      <rect x="54" y="13" width="112" height="3" rx="1.5" fill="#111820" />
      <g className="receipt">
        <path d="M58 16h104v150l-6.5 6-6.5-6-6.5 6-6.5-6-6.5 6-6.5-6-6.5 6-6.5-6-6.5 6-6.5-6-6.5 6-6.5-6-6.5 6-6.5-6-6.5 6-6.5-6z" fill="#fff" stroke="#EDE5DB" />
        <text x="110" y="34" textAnchor="middle" fontFamily={F} fontSize="9" fontWeight="800" fill="#111820">thechilli<tspan fill="#E50914">.ai</tspan></text>
        <text x="110" y="44" textAnchor="middle" fontFamily={F} fontSize="6" fontWeight="500" fill="#6B7280">Tax invoice · Table 4</text>
        <line x1="66" y1="50" x2="154" y2="50" stroke="#D1D5DB" strokeDasharray="3 3" />
        {rows.map(([n, a], i) => (
          <g key={n}>
            <text x="66" y={63 + i * 12} fontFamily={F} fontSize="6.6" fontWeight="600" fill="#111820">{n}</text>
            <text x="154" y={63 + i * 12} textAnchor="end" fontFamily="JetBrains Mono, monospace" fontSize="6.4" fill="#111820">{a}</text>
          </g>
        ))}
        <line x1="66" y1="96" x2="154" y2="96" stroke="#D1D5DB" strokeDasharray="3 3" />
        <text x="66" y="108" fontFamily={F} fontSize="6.2" fill="#6B7280">CGST 2.5%</text>
        <text x="154" y="108" textAnchor="end" fontFamily="JetBrains Mono, monospace" fontSize="6.2" fill="#6B7280">22.50</text>
        <text x="66" y="119" fontFamily={F} fontSize="6.2" fill="#6B7280">SGST 2.5%</text>
        <text x="154" y="119" textAnchor="end" fontFamily="JetBrains Mono, monospace" fontSize="6.2" fill="#6B7280">22.50</text>
        <rect x="62" y="126" width="96" height="20" rx="5" fill="#FFE3E0" />
        <text x="68" y="139.5" fontFamily={F} fontSize="8" fontWeight="700" fill="#B1070F">Total</text>
        <text x="152" y="139.5" textAnchor="end" fontFamily="JetBrains Mono, monospace" fontSize="8.5" fontWeight="700" fill="#E50914">₹945.00</text>
        <text x="110" y="158" textAnchor="middle" fontFamily={F} fontSize="5.6" fill="#9CA3AF">GSTIN shown on every bill</text>
      </g>
    </svg>
  )
}

function useQr(n = 21, seed = 7) {
  return useMemo(() => {
    let s = seed
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280)
    const cells = []
    const finder = (x, y) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!finder(x, y) && rnd() > 0.52) cells.push([x, y])
    return cells
  }, [n, seed])
}

function QrScene() {
  const cells = useQr()
  const m = 3.2, ox = 76, oy = 42
  const fp = (x, y) => (
    <g key={`${x}-${y}`}>
      <rect x={ox + x * m} y={oy + y * m} width={7 * m} height={7 * m} rx="2" fill="#111820" />
      <rect x={ox + (x + 1) * m} y={oy + (y + 1) * m} width={5 * m} height={5 * m} rx="1.5" fill="#fff" />
      <rect x={ox + (x + 2) * m} y={oy + (y + 2) * m} width={3 * m} height={3 * m} rx="1" fill="#111820" />
    </g>
  )
  return (
    <svg viewBox="0 0 220 190" aria-hidden="true">
      <path d="M78 160h64l10 16H68z" fill="#E7D3B8" />
      <rect x="62" y="10" width="96" height="152" rx="12" fill="#fff" stroke="#EDE5DB" />
      <rect x="62" y="10" width="96" height="24" rx="12" fill="#E50914" />
      <rect x="62" y="24" width="96" height="10" fill="#E50914" />
      <text x="110" y="26" textAnchor="middle" fontFamily={F} fontSize="9" fontWeight="700" fill="#fff">Scan &amp; pay</text>
      {cells.map(([x, y]) => <rect key={`${x}.${y}`} x={ox + x * m} y={oy + y * m} width={m} height={m} fill="#111820" />)}
      {fp(0, 0)}{fp(14, 0)}{fp(0, 14)}
      <rect className="scanline" x="72" y="42" width="76" height="2.5" rx="1.2" fill="#FF5A1F" />
      <text x="110" y="128" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="11" fontWeight="700" fill="#111820">₹945.00</text>
      <text x="110" y="140" textAnchor="middle" fontFamily={F} fontSize="6.5" fontWeight="600" fill="#6B7280">Table 4</text>
      <g className="payer">
        <rect x="160" y="70" width="34" height="58" rx="6" fill="#111820" transform="rotate(14 177 99)" />
        <rect x="164" y="76" width="26" height="44" rx="3" fill="#EEF7EE" transform="rotate(14 177 99)" />
      </g>
      <g className="paid">
        <circle cx="178" cy="98" r="11" fill="#16A34A" />
        <path d="M172.5 98l4 4 7.5-8" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  )
}

const steps = [
  { title: 'Waiter takes the order', text: 'On the Chilli Staff app, right at the table.', Scene: WaiterScene },
  { title: 'Kitchen sees it instantly', text: 'KOT on the kitchen screen and the printer.', Scene: KitchenScene },
  { title: 'Invoice with exact GST', text: 'CGST and SGST worked out, ready to print.', Scene: InvoiceScene },
  { title: 'Guest scans the table QR', text: 'The menu and a quick review, straight from the table.', Scene: QrScene },
]

export default function Journey() {
  const reduce = useReducedMotion()
  const [on, setOn] = useState(0)
  const [hold, setHold] = useState(false)

  useEffect(() => {
    if (reduce || hold) return
    const t = setInterval(() => setOn((v) => (v + 1) % steps.length), 2800)
    return () => clearInterval(t)
  }, [reduce, hold])

  return (
    <section className="journey">
      <div className="wrap">
        <Reveal className="head center">
          <span className="eyebrow">One order, start to finish</span>
          <h2>From order to paid, in one flow</h2>
        </Reveal>
        <Reveal className="js-row" delay={0.1}>
          <div className="js-track" aria-hidden="true"><i style={{ width: `${(on / (steps.length - 1)) * 100}%` }} /></div>
          {steps.map((s, i) => (
            <button
              type="button"
              key={s.title}
              className={`js-step${i === on ? ' on' : ''}${i < on ? ' done' : ''}`}
              onMouseEnter={() => { setOn(i); setHold(true) }}
              onMouseLeave={() => setHold(false)}
              onFocus={() => { setOn(i); setHold(true) }}
              onBlur={() => setHold(false)}
              onClick={() => setOn(i)}
              aria-pressed={i === on}
            >
              <div className="js-stage">
                <div className="js-scene"><s.Scene /></div>
                <span className="js-base" />
              </div>
              <span className="js-num">{i + 1}</span>
              <b>{s.title}</b>
              <small>{s.text}</small>
            </button>
          ))}
        </Reveal>
      </div>
    </section>
  )
}
