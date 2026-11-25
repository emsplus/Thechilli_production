import { useEffect } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import Header from './components/layout/Header.jsx'
import Footer from './components/layout/Footer.jsx'
import ToTop from './components/layout/ToTop.jsx'
import ScrollProgress from './components/layout/ScrollProgress.jsx'
import Home from './pages/Home.jsx'
import Features from './pages/Features.jsx'
import WaiterApp from './pages/WaiterApp.jsx'
import GstPayments from './pages/GstPayments.jsx'
import DeliveryPage from './pages/DeliveryPage.jsx'
import PricingPage from './pages/PricingPage.jsx'
import Contact from './pages/Contact.jsx'
import MenuPage from './pages/MenuPage.jsx'
import { Terms, Privacy, Refund } from './pages/Legal.jsx'

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return null
}

export default function App() {
  return (
    <>
      <ScrollToTop />
      <ScrollProgress />
      <Header />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/menu" element={<MenuPage />} />
          <Route path="/features" element={<Features />} />
          <Route path="/waiter-app" element={<WaiterApp />} />
          <Route path="/gst-payments" element={<GstPayments />} />
          <Route path="/delivery" element={<DeliveryPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/refund" element={<Refund />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      <Footer />
      <ToTop />
    </>
  )
}
