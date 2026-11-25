import { Link } from 'react-router-dom'
import { Mail, ArrowUpRight, MapPin } from 'lucide-react'
import { site } from '../../data/content.js'
import Logo from './Logo.jsx'
import { Reveal } from '../ui/Reveal.jsx'

const cols = [
  { title: 'Product', links: [['Features', '/features'], ['Waiter app', '/waiter-app'], ['GST & payments', '/gst-payments'], ['Delivery', '/delivery']] },
  { title: 'Explore', links: [['Home', '/'], ['Menu', '/menu'], ['Pricing', '/pricing'], ['Contact', '/contact']] },
]

export default function Footer() {
  return (
    <footer>
      <div className="wrap">
        <Reveal className="foot-panel" y={60} scale={0.97}>
          <div className="foot-top">
            <div className="foot-brand">
              <Logo tone="light" size={34} />
              <p>Chilli Agent for Indian restaurants. Counter, waiter app, kitchen, GST and payments in one system.</p>
              <a href="/signup" className="btn btn-primary btn-sm">Get started <ArrowUpRight size={16} /></a>
            </div>
            {cols.map((c) => (
              <nav key={c.title} aria-label={c.title}>
                <h4>{c.title}</h4>
                {c.links.map(([label, to]) => <Link key={to} to={to}>{label}</Link>)}
              </nav>
            ))}
            <div className="foot-contact">
              <h4>Get in touch</h4>
              <a href={`mailto:${site.email}`}><span className="fc-i"><Mail size={16} /></span>{site.email}</a>
              <span className="foot-loc"><span className="fc-i"><MapPin size={16} /></span>Made in India, for Indian restaurants</span>
            </div>
          </div>
          <div className="foot-word" aria-hidden="true">thechilli.ai</div>
          <div className="foot-bottom">
            <span>© 2026 thechilli.ai. All rights reserved.</span>
            <span className="foot-legal"><Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link> · <Link to="/refund">Refund policy</Link></span>
            <span>Where Restaurants Meet Intelligence.</span>
          </div>
        </Reveal>
      </div>
    </footer>
  )
}
