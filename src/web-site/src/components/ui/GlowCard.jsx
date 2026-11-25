import { useRef } from 'react'
import { motion, useSpring, useReducedMotion } from 'motion/react'
import { revealItem } from './Reveal.jsx'

/**
 * Card with a cursor-following spotlight, a border that lights up near the pointer and (optionally) a small spring 3D tilt.
 * Pointer effects are skipped for touch and reduced-motion. Use inside <Stagger> to inherit the scroll reveal.
 */
export default function GlowCard({ as = 'article', className = '', tilt = false, dark = false, children }) {
  const ref = useRef(null)
  const reduce = useReducedMotion()
  const rx = useSpring(0, { stiffness: 220, damping: 22 })
  const ry = useSpring(0, { stiffness: 220, damping: 22 })
  const Tag = motion[as]

  const move = (e) => {
    if (reduce || e.pointerType === 'touch' || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    ref.current.style.setProperty('--mx', `${x}px`)
    ref.current.style.setProperty('--my', `${y}px`)
    if (tilt) { ry.set((x / r.width - 0.5) * 7); rx.set(-(y / r.height - 0.5) * 7) }
  }
  const leave = () => { rx.set(0); ry.set(0) }

  return (
    <Tag
      ref={ref}
      variants={revealItem}
      className={`glow${dark ? ' dark' : ''} ${className}`}
      onPointerMove={move}
      onPointerLeave={leave}
      style={tilt && !reduce ? { rotateX: rx, rotateY: ry, transformPerspective: 900 } : undefined}
    >
      {children}
    </Tag>
  )
}
