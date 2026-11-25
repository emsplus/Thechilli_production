import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Smartphone } from 'lucide-react'
import { site } from '../../data/content.js'

// Public lead form of the marketing service (CORS allows this site; the site's CSP connect-src lists the API host). The lead shows up in the Partner portal.
const LEAD_URL = 'https://api.thechilli.zonov.ai/marketing/api/v1/public/leads'

/** Bottom banner. With `form`, shows the email demo form; otherwise links to the Contact page. */
export default function Cta({ form = false }) {
  const [f, setF] = useState({ business_name: '', contact_name: '', phone: '', email: '', city: '' })
  const [state, setState] = useState('idle')   // idle | sending | sent | error
  const [msg, setMsg] = useState('')
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    if (!f.business_name.trim() || !f.contact_name.trim()) { setState('error'); setMsg('Please give your restaurant name and your name.'); return }
    if (!f.phone.trim() && !f.email.trim()) { setState('error'); setMsg('Please give a phone number or an email so we can reach you.'); return }
    setState('sending'); setMsg('')
    const body = { business_name: f.business_name.trim(), contact_name: f.contact_name.trim() }
    for (const k of ['phone', 'email', 'city']) if (f[k].trim()) body[k] = f[k].trim()
    try {
      const r = await fetch(LEAD_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (r.status === 202) { setState('sent'); return }
      setState('error')
      setMsg(r.status === 422 ? 'Please check the phone number and email.' : r.status === 429 ? 'Too many tries. Please wait a minute and try again.' : 'Something went wrong. Please try again in a minute.')
    } catch {
      setState('error'); setMsg('We could not reach the server. Check your internet and try again.')
    }
  }

  return (
    <section className="cta-sec">
      <div className="wrap cta">
        <div className="cta-copy">
          <h2>Ready to turn up the heat?</h2>
          <p>See Chilli Agent in action. We'll set up a free walkthrough for your restaurant.</p>
          {form ? (
            state === 'sent' ? (
              <p className="lead-ok" role="status">Thank you! We have your details and will get in touch to set up the walkthrough.</p>
            ) : (
              <>
              <form className="demo lead-form" onSubmit={submit} noValidate>
                <input value={f.business_name} onChange={set('business_name')} placeholder="Restaurant name" required maxLength={160} aria-label="Restaurant name" />
                <input value={f.contact_name} onChange={set('contact_name')} placeholder="Your name" required maxLength={120} aria-label="Your name" />
                <input type="tel" value={f.phone} onChange={set('phone')} placeholder="Phone" maxLength={40} aria-label="Phone" autoComplete="tel" />
                <input type="email" value={f.email} onChange={set('email')} placeholder="Email" maxLength={254} aria-label="Email" autoComplete="email" />
                <input value={f.city} onChange={set('city')} placeholder="City (optional)" maxLength={80} aria-label="City" />
                <button className="btn btn-primary" type="submit" disabled={state === 'sending'}>{state === 'sending' ? 'Sending…' : 'Book my demo'}</button>
                {state === 'error' && <p className="lead-err" role="alert">{msg}</p>}
              </form>
              <p className="lead-alt">Prefer email? Write to <a href={`mailto:${site.email}`}>{site.email}</a> and we will review it and get back to you.</p>
              </>
            )
          ) : (
            <><a href="/signup" className="btn btn-primary btn-lg">Get started</a> <Link to="/contact" className="btn btn-dark btn-lg">Book a demo</Link></>
          )}
          <div className="store-row">
            <Link to="/waiter-app" className="store"><Smartphone size={22} /><span><small>Chilli Staff app for</small>Android</span></Link>
            <Link to="/waiter-app" className="store"><Smartphone size={22} /><span><small>Chilli Staff app for</small>iOS</span></Link>
          </div>
        </div>
        <div className="cta-visual">
          <span className="blob b1" />
          <div className="phone cta-phone"><img src="/screens/waiter-tables.webp" alt="Chilli Staff waiter app showing the table list" width="402" height="874" loading="lazy" /></div>
          <img className="cta-dish" src="/menu/chicken-tikka-roll.webp" alt="" width="360" height="240" loading="lazy" />
        </div>
      </div>
    </section>
  )
}
