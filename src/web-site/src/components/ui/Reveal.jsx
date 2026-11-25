import { useRef } from 'react'
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react'

const ease = [0.22, 1, 0.36, 1]
const container = (gap) => ({ hidden: {}, show: { transition: { staggerChildren: gap } } })
export const revealItem = {
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 140, damping: 22 } },
}
const child = revealItem
const viewport = { once: true, margin: '-70px' }

/** Fade in when scrolled into view; slides from `x`/`y` and grows from `scale`. */
export function Reveal({ children, delay = 0, y = 26, x = 0, scale = 1, className, as = 'div' }) {
  const reduce = useReducedMotion()
  const Tag = motion[as]
  return (
    <Tag className={className} initial={reduce ? false : { opacity: 0, y, x, scale }} whileInView={{ opacity: 1, y: 0, x: 0, scale: 1 }} viewport={viewport} transition={{ duration: 0.8, delay, ease }}>
      {children}
    </Tag>
  )
}

/** Parent that staggers its StaggerItem children as it scrolls into view. */
export function Stagger({ children, className, gap = 0.08, as = 'div' }) {
  const reduce = useReducedMotion()
  const Tag = motion[as]
  return (
    <Tag className={className} variants={container(gap)} initial={reduce ? 'show' : 'hidden'} whileInView="show" viewport={viewport}>
      {children}
    </Tag>
  )
}

export function StaggerItem({ children, className, as = 'div' }) {
  const Tag = motion[as]
  return <Tag className={className} variants={child}>{children}</Tag>
}

/** Moves its child against the scroll: positive `speed` drifts up as the page scrolls down. */
export function Parallax({ children, speed = 0.15, className, style }) {
  const reduce = useReducedMotion()
  const ref = useRef(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const y = useTransform(scrollYProgress, [0, 1], [speed * 260, speed * -260])
  return <motion.div ref={ref} className={className} style={reduce ? style : { ...style, y }}>{children}</motion.div>
}
