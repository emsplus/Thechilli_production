import PageHero from '../components/ui/PageHero.jsx'
import Showcase from '../sections/shared/Showcase.jsx'
import AppPromo from '../sections/home/AppPromo.jsx'
import { Reveal, Stagger, StaggerItem } from '../components/ui/Reveal.jsx'
import GlowCard from '../components/ui/GlowCard.jsx'

const steps = [
  { n: '1', title: 'Pick a table', text: 'See every table in the restaurant and which are in use.' },
  { n: '2', title: 'Add dishes', text: 'Choose from the menu, with options, straight from the phone.' },
  { n: '3', title: 'Send to the kitchen', text: 'The order reaches the kitchen screen and the printer right away.' },
]

const screens = [
  { src: '/screens/waiter-tables.webp', alt: 'Tables screen in the Chilli Staff app', title: 'Tables', text: 'Every table and its status at a glance.' },
  { src: '/screens/waiter-voice.webp', alt: 'Voice order sheet in the Chilli Staff app with Auto, English, Hindi and Punjabi options and a Hold to talk button', title: 'Voice order', text: 'Hold to talk, or type instead.' },
  { src: '/screens/waiter-more.webp', alt: 'Sync queue in the Chilli Staff app showing orders and KOTs as synced', title: 'Sync queue', text: 'See what has reached the server.' },
]

export default function WaiterApp() {
  return (
    <>
      <PageHero eyebrow="Chilli Staff app" title="A simple app for your floor team." text="Waiters take orders at the table on Android or iOS, in English or Hindi." />
      <Showcase ids={['waiter']} />
      <section>
        <div className="wrap">
          <Reveal className="head center"><span className="eyebrow">How it works</span><h2>From table to kitchen in three steps.</h2></Reveal>
          <Stagger className="three steps">
            {steps.map((s) => (
              <GlowCard className="mod" key={s.n}><span className="num">{s.n}</span><h3>{s.title}</h3><p>{s.text}</p></GlowCard>
            ))}
          </Stagger>
          <Stagger className="screens" gap={0.15}>
            {screens.map((s) => (
              <StaggerItem as="figure" className="screen" key={s.src}>
                <div className="phone"><img src={s.src} alt={s.alt} width="402" height="874" loading="lazy" /></div>
                <figcaption><b>{s.title}</b><span>{s.text}</span></figcaption>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>
      <AppPromo />
    </>
  )
}
