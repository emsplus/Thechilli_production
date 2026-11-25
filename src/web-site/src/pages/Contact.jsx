import PageHero from '../components/ui/PageHero.jsx'
import Cta from '../sections/shared/Cta.jsx'
import Faq from '../sections/shared/Faq.jsx'

export default function Contact() {
  return (
    <>
      <PageHero eyebrow="Book a demo" title="Let's look at your restaurant." text="Leave your details and we'll get in touch to set up a free walkthrough." />
      <Cta form />
      <Faq />
    </>
  )
}
