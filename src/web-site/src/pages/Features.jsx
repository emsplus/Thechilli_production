import PageHero from '../components/ui/PageHero.jsx'
import Showcase from '../sections/shared/Showcase.jsx'
import Cta from '../sections/shared/Cta.jsx'
import ModuleBento from '../sections/shared/ModuleBento.jsx'

export default function Features() {
  return (
    <>
      <PageHero eyebrow="Features" title="Everything a restaurant runs on." text="Billing, kitchen, stock, staff and reports, all working from the same menu and the same data." />
      <section className="tight">
        <div className="wrap">
          <ModuleBento />
        </div>
      </section>
      <Showcase ids={['counter', 'kitchen', 'voice', 'inventory']} />
      <Cta />
    </>
  )
}
