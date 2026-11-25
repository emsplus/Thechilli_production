import { Receipt, LayoutGrid, Package, Users, BarChart3, Mic, ScanLine, Percent, CreditCard, ShieldCheck, Wifi, ToggleRight, Check, ArrowRight, ChefHat } from 'lucide-react'

const icons = { receipt: Receipt, grid: LayoutGrid, box: Package, users: Users, chart: BarChart3, mic: Mic, scan: ScanLine, percent: Percent, card: CreditCard, shield: ShieldCheck, wifi: Wifi, toggle: ToggleRight, check: Check, arrow: ArrowRight, chef: ChefHat }

export default function Icon({ name, size = 22 }) {
  const Cmp = icons[name]
  return <Cmp size={size} strokeWidth={1.9} aria-hidden="true" />
}
