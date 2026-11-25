import { useEffect, useState } from 'react'
import { ArrowUp } from 'lucide-react'

export default function ToTop() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const on = () => setShow(window.scrollY > 700)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  return (
    <button type="button" className={`to-top${show ? ' on' : ''}`} aria-label="Back to top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
      <ArrowUp size={20} />
    </button>
  )
}
