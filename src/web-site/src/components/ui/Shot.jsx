import Img from './Img.jsx'

/** A graded photo with an optional product card floating on it, so the picture shows the product, not just mood. */
export default function Shot({ name, alt, focus, children, pos = 'bl' }) {
  return (
    <figure className="shot">
      <Img name={name} alt={alt} focus={focus} className="photo" />
      {children && <figcaption className={`shot-card ${pos}`}>{children}</figcaption>}
    </figure>
  )
}
