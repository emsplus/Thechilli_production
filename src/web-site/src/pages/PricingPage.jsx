import PageHero from '../components/ui/PageHero.jsx'
import Pricing from '../sections/shared/Pricing.jsx'
import Cta from '../sections/shared/Cta.jsx'

export default function PricingPage() {
  return (
    <>
      <PageHero eyebrow="Pricing" title="Free for 7 days, then pay as you go." text="Try it free for 7 days. After that you add Chilli to your account and 5 Chilli are used for every order." />
      <Pricing />
      <Cta />
    </>
  )
}
