import { Link } from 'react-router-dom'
import Hero from '../sections/home/Hero.jsx'
import ServiceTiles from '../sections/home/ServiceTiles.jsx'
import MenuStrip from '../sections/home/MenuStrip.jsx'
import Journey from '../sections/home/Journey.jsx'
import BizBanner from '../sections/home/BizBanner.jsx'
import Categories from '../sections/home/Categories.jsx'
import Faq from '../sections/shared/Faq.jsx'
import FanCards from '../sections/home/FanCards.jsx'
import Trust from '../sections/home/Trust.jsx'
import AppPromo from '../sections/home/AppPromo.jsx'
import Img from '../components/ui/Img.jsx'
import { Reveal, Stagger, StaggerItem } from '../components/ui/Reveal.jsx'

const teasers = [
  { to: '/waiter-app', img: 'dining', title: 'Waiter app', text: 'Take orders at the table, even offline.' },
  { to: '/gst-payments', img: 'counter-payment', title: 'GST & payments', text: 'Exact tax, UPI and cards in rupees.' },
  { to: '/delivery', img: 'delivery-pizza', title: 'Delivery', text: 'Your own riders, with live tracking links.' },
  { to: '/features', img: 'kitchen-curry', title: 'Kitchen', text: 'Live screen and KOT on your thermal printer.' },
]

export default function Home() {
  return (
    <>
      <Hero />
      <ServiceTiles />
      <MenuStrip />
      <Categories />
      <Journey />
      <FanCards />
      <Trust />
      <BizBanner />
      <Faq />
      <AppPromo />
    </>
  )
}
