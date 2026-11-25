import PageHero from '../components/ui/PageHero.jsx'
import Delivery from '../sections/shared/Delivery.jsx'
import Cta from '../sections/shared/Cta.jsx'

export default function DeliveryPage() {
  return (
    <>
      <PageHero eyebrow="Delivery & online orders" title="Every order, one place." text="Run your own delivery today, with marketplace orders on the way." />
      <Delivery />
      <Cta />
    </>
  )
}
