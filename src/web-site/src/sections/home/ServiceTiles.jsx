import { UtensilsCrossed, ShoppingBag, Bike, Coffee, Zap, Store } from 'lucide-react'
import { Stagger, StaggerItem } from '../../components/ui/Reveal.jsx'

const tiles = [
  { Icon: UtensilsCrossed, label: 'Dine-in' },
  { Icon: ShoppingBag, label: 'Takeaway' },
  { Icon: Bike, label: 'Delivery' },
  { Icon: Coffee, label: 'Cafés' },
  { Icon: Zap, label: 'Quick service' },
  { Icon: Store, label: 'Multi-outlet' },
]

export default function ServiceTiles() {
  return (
    <section className="tiles-sec" aria-label="Restaurant types">
      <Stagger className="wrap tiles" gap={0.05}>
        {tiles.map((t) => (
          <StaggerItem className="tile" key={t.label}>
            <span className="tile-ico"><t.Icon size={24} /></span>
            <b>{t.label}</b>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  )
}
