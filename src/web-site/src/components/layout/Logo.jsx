/** thechilli.ai logo: a chilli-pepper mark + "thechilli.ai" wordmark. tone="light" is for dark backgrounds. */
export function ChilliMark({ size = 36 }) {
  // mark is ~1.67:1; `size` is its height
  // Wrapper carries the animation: a gentle sway and pulses on the three circuit nodes.
  return (
    <span className="chilli-mark" style={{ height: size }} aria-hidden="true">
      <img src="/chilli-mark.png" height={size} alt="" style={{ height: size, width: 'auto' }} />
      <i className="cm-node n1" /><i className="cm-node n2" /><i className="cm-node n3" />
    </span>
  )
}

export default function Logo({ tone = 'dark', size = 36 }) {
  const src = tone === 'light' ? '/wordmark-light.png' : '/wordmark.png'
  return (
    <span className={`logo-lockup ${tone}`}>
      <ChilliMark size={size} />
      <img src={src} alt="thechilli.ai" className="logo-word-img" style={{ height: size * 0.62, width: 'auto' }} />
    </span>
  )
}
