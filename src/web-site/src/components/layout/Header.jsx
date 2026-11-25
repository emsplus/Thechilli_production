import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Menu, X, Search, LogIn } from 'lucide-react'
import { environments, navLinks } from '../../data/content.js'
import Logo from './Logo.jsx'

export default function Header() {
  const [open, setOpen] = useState(false)
  return (
    <>
    <div className="env-bar">
      <div className="wrap env-bar-in">
        <span>Sign in to</span>
        {environments.map((e) => <a key={e.label} href={e.url} title={e.title} rel="noopener">{e.label}</a>)}
      </div>
    </div>
    <header className="site-header">
      <div className="wrap nav">
        <Link to="/" aria-label="thechilli.ai home" onClick={() => setOpen(false)}><Logo size={34} /></Link>
        <nav className={`links${open ? ' open' : ''}`} aria-label="Main">
          {navLinks.map((l) => <NavLink key={l.to} to={l.to} end={l.to === '/'} onClick={() => setOpen(false)}>{l.label}</NavLink>)}
          <a href="/signup" className="btn btn-primary btn-sm nav-cta-m">Get started</a>
          <Link to="/contact" className="btn btn-dark btn-sm nav-cta-m" onClick={() => setOpen(false)}>Book a demo</Link>
        </nav>
        <div className="nav-right">
          <Link to="/features" className="search-pill" aria-label="Browse features"><Search size={16} /><span>Search features</span></Link>
          <Link to="/contact" className="btn btn-dark btn-sm nav-cta"><LogIn size={15} />Book a demo</Link>
          <a href="/signup" className="btn btn-primary btn-sm nav-cta">Get started</a>
          <button className="menu-btn" type="button" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>
    </header>
    </>
  )
}
