import { motion, useReducedMotion } from 'motion/react'

export default function PageHero({ eyebrow, title, text }) {
  const reduce = useReducedMotion()
  const t = (d) => ({ initial: reduce ? false : { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, delay: d, ease: [0.22, 1, 0.36, 1] } })
  return (
    <section className="page-hero">
      <div className="wrap">
        <motion.span className="eyebrow" {...t(0)}>{eyebrow}</motion.span>
        <motion.h1 {...t(0.08)}>{title}</motion.h1>
        {text && <motion.p className="lead" {...t(0.16)}>{text}</motion.p>}
      </div>
    </section>
  )
}
