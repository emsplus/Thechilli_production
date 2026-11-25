import { Link } from 'react-router-dom'
import { VoiceTile, StatusTile, BillTile } from './LiveTiles.jsx'
import Icon from '../../components/ui/Icon.jsx'
import { Reveal } from '../../components/ui/Reveal.jsx'

// Same order as the live tiles on the left: voice order, kitchen status, instant bill.
const items = [
  { icon: 'mic', tone: 'purple', title: 'Voice ordering', text: 'Speak the order in Hindi or Hinglish. It lands on the bill as English menu items and the KOT goes to the kitchen.', to: '/waiter-app' },
  { icon: 'chef', tone: 'orange', title: 'Live kitchen screen', text: 'Every KOT shows on the kitchen screen and prints on the thermal printer the moment it is sent.', to: '/features' },
  { icon: 'receipt', tone: 'green', title: 'Instant GST bill', text: 'Bill in seconds with exact CGST and SGST, then print it or share it on WhatsApp.', to: '/gst-payments' },
]

export default function Categories() {
  return (
    <section className="cats">
      <div className="wrap cats-grid">
        <Reveal className="cat-photos" x={-70} y={0}>
          <div className="cat-big"><VoiceTile /></div>
          <div className="cat-small a"><StatusTile /></div>
          <div className="cat-small b"><BillTile /></div>
        </Reveal>
        <Reveal className="cat-list" x={70} y={0} delay={0.1}>
          <h2>Our Features</h2>
          {items.map((i) => (
            <Link to={i.to} className="cat-item" key={i.title}>
              <span className={`cat-ico ${i.tone}`}><Icon name={i.icon} size={26} /></span>
              <span><b>{i.title}</b><small>{i.text}</small></span>
            </Link>
          ))}
        </Reveal>
      </div>
    </section>
  )
}
