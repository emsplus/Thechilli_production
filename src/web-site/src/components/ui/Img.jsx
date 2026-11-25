const WIDTHS = [640, 960, 1400]

/** Responsive photo: srcset of WebP sizes from public/images, with a focal point for cropping. */
export default function Img({ name, alt, sizes = '(min-width: 900px) 560px, 92vw', focus = '50% 50%', eager = false, className = '' }) {
  const set = WIDTHS.map((w) => `/images/${name}-${w}.webp ${w}w`).join(', ')
  return (
    <img
      className={className}
      src={`/images/${name}-960.webp`}
      srcSet={set}
      sizes={sizes}
      alt={alt}
      width="1400"
      height="933"
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      style={{ objectPosition: focus }}
    />
  )
}
