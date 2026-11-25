/** Swirling "listening" orb used in place of a mic button. Pure CSS (see .orb in base.css). */
export default function VoiceOrb({ className = '' }) {
  return (
    <span className={`orb ${className}`} aria-hidden="true">
      <span className="orb-glow" />
      <span className="orb-swirl a" />
      <span className="orb-swirl b" />
      <span className="orb-core" />
      <span className="orb-rim" />
    </span>
  )
}
