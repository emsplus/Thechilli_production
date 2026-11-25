import { useEffect, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { Sparkles } from 'lucide-react'

const lines = ['Listening to Table 4…', 'Matching 2 dishes to your menu', 'KOT sent to the kitchen', 'Bill ready · GST added']

/** "AI is working" strip: sparkle, shimmering status text that changes every couple of seconds. */
export default function AiStatus() {
  const reduce = useReducedMotion()
  const [i, setI] = useState(0)
  useEffect(() => {
    if (reduce) return
    const t = setInterval(() => setI((v) => (v + 1) % lines.length), 2200)
    return () => clearInterval(t)
  }, [reduce])
  return (
    <div className="ai-status" aria-live="polite">
      <Sparkles size={14} className="ai-spark" />
      <span className="ai-shimmer" key={i}>{lines[i]}</span>
      <span className="ai-dots"><i /><i /><i /></span>
    </div>
  )
}
