import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@chilli/tokens/fonts.css';
import '@chilli/tokens/tokens.css';
import '@chilli/ui/styles.css';
import '@chilli/ui/data.css';
import '@chilli/ui/kds.css';
import '@chilli/ui/auth.css';
import {
  Badge, Button, Card, FoodMark, Dialog, EmptyState, ErrorState, IconButton, Input, Money, NumberStepper, OfflineBanner,
  Select, Sheet, Skeleton, SkeletonGroup, StatusPill, SyncStatus, Table, Tabs, ToastProvider, orderStates,
  Checkbox, ConfirmDialog, DateInput, FeatureGate, FeatureGateProvider, Keypad, KpiTile, Notice, OutletSwitcher, PageHeader,
  PillTabs, QtyStepper, RadioGroup, Section, SegmentedControl, Spinner, StatCard, Switch, Textarea,
  setDensity, useToast, type Density, type Locale, type SyncState,
} from '@chilli/ui';
import { DataTable, FilterBar, type DataColumn } from '@chilli/ui/data';
import { brandCopy } from '@chilli/tokens';
import { AuthSplit, type AuthMediaItem } from '@chilli/ui/auth';
import { KdsBoard, KdsColumn, KdsTicket, useNow } from '@chilli/ui/kds';

const locales: Locale[] = ['en', 'hi', 'hinglish'];
const densities: Density[] = ['touch', 'comfortable', 'compact', 'far'];
const syncStates: SyncState[] = ['synced', 'queued', 'sending', 'failed', 'offline'];

function Demo({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBlock: 32 }}>
      <h2 style={{ fontSize: 'var(--text-xl)', margin: '0 0 12px' }}>{title}</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>{children}</div>
    </section>
  );
}

function ToastButton() {
  const toast = useToast();
  return (
    <>
      <Button onClick={() => toast.show('KOT sent', 'success')}>Success toast</Button>
      <Button onClick={() => toast.show('Printer not found. Check the cable.', 'danger')}>Error toast</Button>
    </>
  );
}

interface SaleRow { id: string; item: string; qty: number; amt: number }
const saleRows: SaleRow[] = [
  { id: '1', item: 'Paneer tikka', qty: 12, amt: 576000 },
  { id: '2', item: 'पनीर बटर मसाला', qty: 7, amt: 224350 },
  { id: '3', item: 'Chai', qty: 40, amt: 240000 },
  { id: '4', item: '=HYPERLINK("x")', qty: 1, amt: 9900 },
];
const saleCols: DataColumn<SaleRow>[] = [
  { key: 'item', header: 'Item', render: (r) => r.item, sortValue: (r) => r.item },
  { key: 'qty', header: 'Qty', align: 'end', render: (r) => r.qty, sortValue: (r) => r.qty },
  { key: 'amt', header: 'Sales', align: 'end', render: (r) => <Money value={r.amt} />, sortValue: (r) => r.amt, csv: (r) => r.amt / 100 },
  { key: 'wide1', header: 'Category', render: () => 'Starters' },
  { key: 'wide2', header: 'Station', render: () => 'Tandoor' },
  { key: 'wide3', header: 'Last sold', render: () => 'Today 8:42 pm' },
];

function Kitchen() {
  const now = useNow();
  const mins = (n: number) => now - n * 60_000;
  const items = [{ name: 'Paneer tikka', qty: 2, note: 'No onion' }, { name: 'Butter naan', qty: 4 }];
  return (
    <KdsBoard label="Kitchen screen">
      <KdsColumn title="New" state="new"><KdsTicket number={41} channel="Dine-in" table="T3" items={items} placedAt={mins(2)} now={now} state="new" onAdvance={() => {}} /></KdsColumn>
      <KdsColumn title="Preparing" state="prep">
        <KdsTicket number={39} channel="Swiggy" items={items} placedAt={mins(11)} now={now} state="prep" onAdvance={() => {}} />
        <KdsTicket number={37} channel="Dine-in" table="T7" items={items} placedAt={mins(19)} now={now} state="prep" onAdvance={() => {}} />
      </KdsColumn>
      <KdsColumn title="Ready" state="ready" />
    </KdsBoard>
  );
}

function App() {
  const [locale, setLocale] = useState<Locale>('en');
  const [qty, setQty] = useState(2);
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [offline, setOffline] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [pad, setPad] = useState('');
  const [tab, setTab] = useState('all');
  const [outlet, setOutlet] = useState('a');
  const [status, setStatus] = useState<'ready' | 'loading' | 'error'>('ready');
  const rows = [
    { id: '1', name: 'Paneer tikka', qty: 2, amt: 48000 },
    { id: '2', name: 'पनीर बटर मसाला', qty: 1, amt: 32050 },
    { id: '3', name: 'Chai', qty: 4, amt: 6000 },
  ];
  return (
    <ToastProvider locale={locale}>
      <div style={{ background: 'var(--c-bg)', color: 'var(--c-fg)', fontFamily: 'var(--font-sans)', minHeight: '100vh' }}>
        <OfflineBanner offline={offline} queued={3} locale={locale} />
        <main style={{ maxWidth: 960, margin: '0 auto', padding: 'var(--gutter)' }}>
          <h1>Chilli UI</h1>
          <Demo title="Controls">
            <Select label="Density" defaultValue="touch" onChange={(e) => setDensity(e.target.value as Density)}>
              {densities.map((d) => <option key={d}>{d}</option>)}
            </Select>
            {import.meta.env.VITE_ENABLE_LANGUAGES === 'true' && (
              <Select label="Language" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                {locales.map((l) => <option key={l}>{l}</option>)}
              </Select>
            )}
            <Button onClick={() => setOffline((o) => !o)}>Toggle offline</Button>
          </Demo>
          <Demo title="Sign-in shell (AuthSplit)"><a href="#auth" onClick={() => setTimeout(() => location.reload())}>Open the sign-in card full page</a></Demo>
          <Demo title="Brand: logo, badges, food marks, table tiles">
            <img src="./brand/logo-mark.png" alt="thechilli.ai mark" height={48} />
            <img src="./brand/logo-wordmark.png" alt="thechilli.ai" height={32} />
            <Badge tone="info">New</Badge><Badge tone="warning">Preparing</Badge><Badge tone="success">Ready</Badge><Badge>Served</Badge><Badge tone="danger">Voided</Badge>
            <Badge tone="outline">Cash</Badge><Badge tone="outline">UPI</Badge><Badge tone="ink">Aggregator</Badge><Badge tone="brand">Voice order</Badge><Badge tone="brand-outline">Pro plan</Badge>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><FoodMark type="veg" /> Veg</span>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><FoodMark type="non-veg" /> Non-veg</span>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><FoodMark type="egg" /> Egg</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 120px)', gap: 12, width: '100%' }}>
              <button type="button" className="ch-ttile" data-state="free">T-01<span className="ch-ttile__meta"><span>Free · 4 seats</span></span></button>
              <button type="button" className="ch-ttile" data-state="occupied">T-02<span className="ch-ttile__meta"><span>42 min</span><span className="ch-money">₹860</span></span></button>
              <button type="button" className="ch-ttile" data-state="billed">T-03<span className="ch-ttile__meta"><span>Bill printed</span><span className="ch-money">₹1,420</span></span></button>
              <button type="button" className="ch-ttile" data-state="reserved">T-05<span className="ch-ttile__meta"><span>Reserved · 8:30 PM</span></span></button>
              <button type="button" className="ch-ttile" data-state="occupied" aria-pressed="true">T-07<span className="ch-ttile__meta"><span>Selected</span><span className="ch-money">₹1,302</span></span></button>
            </div>
          </Demo>
          <Demo title="Buttons">
            <Button variant="primary">New order</Button><Button variant="danger">Void order</Button><Button variant="danger-solid">Void order</Button><Button disabled>Disabled</Button><Button>Secondary</Button><Button variant="ink">Send KOT</Button>
            <Button variant="ghost">Ghost</Button><Button variant="danger-soft">Void bill</Button><Button loading>Saving</Button>
            <Button variant="primary" size="pay">Pay <Money value={123456750} alwaysDecimals /></Button>
            <IconButton label="Close" icon={<span aria-hidden="true">×</span>} />
          </Demo>
          <Demo title="Forms">
            <Input label="Customer name" hint="Optional" />
            <Input label="Phone" inputMode="numeric" error="Enter 10 digits" />
            <NumberStepper label="Paneer tikka" value={qty} onChange={setQty} locale={locale} />
          </Demo>
          <Demo title="Money (lakh / crore)">
            <Money value={12345650} /><Money value={45000} /><Money value={-9900000} />
            <Money value={12345600} compact /><Money value={3400000000} compact />
          </Demo>
          <Demo title="Order states">
            {orderStates.map((s) => <StatusPill key={s} state={s} locale={locale} />)}
          </Demo>
          <Demo title="Sync">
            {syncStates.map((s) => <SyncStatus key={s} state={s} count={2} locale={locale} onRetry={() => {}} />)}
            <Badge tone="primary">Badge</Badge>
          </Demo>
          <Demo title="Card + table">
            <Card style={{ minWidth: 240 }}><strong>Today</strong><div style={{ fontSize: 'var(--text-3xl)' }}><Money value={8765400} compact /></div></Card>
            <div style={{ flex: 1, minWidth: 280 }}>
              <Table caption="Bill lines" rows={rows} getKey={(r) => r.id}
                columns={[
                  { key: 'n', header: 'Item', render: (r) => <span lang={/[ऀ-ॿ]/.test(r.name) ? 'hi' : undefined}>{r.name}</span> },
                  { key: 'q', header: 'Qty', align: 'end', render: (r) => r.qty },
                  { key: 'a', header: 'Amount', align: 'end', render: (r) => <Money value={r.amt} alwaysDecimals /> },
                ]} />
            </div>
          </Demo>
          <Demo title="Tabs">
            <div style={{ width: '100%' }}>
              <Tabs label="Order views" items={[{ value: 'o', label: 'Open', content: 'Open orders' }, { value: 'c', label: 'Closed', content: 'Closed orders' }]} />
            </div>
          </Demo>
          <Demo title="States">
            <EmptyState title="No orders yet" description="New orders appear here." actionLabel="New order" />
            <ErrorState title="Could not load orders" description="Check your network and try again." locale={locale} />
            <SkeletonGroup locale={locale}><Skeleton width={200} /><br /><Skeleton width={140} /></SkeletonGroup>
          </Demo>
          <Demo title="Selection controls">
            <Checkbox label="Include GST" hint="18% on food" />
            <Switch label="Accept online orders" defaultChecked />
            <RadioGroup legend="Pay with" defaultValue="cash" options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' }]} />
            <SegmentedControl legend="Channel" defaultValue="dine" options={[{ value: 'dine', label: 'Dine-in' }, { value: 'take', label: 'Takeaway' }, { value: 'del', label: 'Delivery' }]} />
            <Textarea label="Kitchen note" hint="Shown on the KOT" />
            <DateInput label="Report date" />
            <Select label="Table"><option>T1</option><option>T2</option></Select>
            <QtyStepper label="Butter naan" value={qty} onChange={setQty} locale={locale} />
          </Demo>
          <Demo title="Pill tabs">
            <PillTabs label="Order filter" value={tab} onValueChange={setTab} items={[{ value: 'all', label: 'All', count: 12 }, { value: 'open', label: 'Open', count: 5 }, { value: 'late', label: 'Late', count: 1 }]} />
          </Demo>
          <Section title="Page header and section" description="PageHeader owns the h1; Section is a labelled region.">
            <PageHeader title="Orders" description="Today so far" actions={<Button variant="primary">New order</Button>} />
            <Notice tone="info" title="Heads up">Prices include GST.</Notice>
            <Notice tone="warning" title="Printer low on paper" onDismiss={() => {}} locale={locale}>Replace the roll before the rush.</Notice>
            <Notice tone="danger" title="Card machine offline" action={<Button size="sm">Retry</Button>}>Take cash or UPI.</Notice>
            <Spinner locale={locale} />
          </Section>
          <Demo title="KPI tiles (compact lakh / crore)">
            <StatCard label="Sales today" money={1234567800} delta={12} deltaLabel="vs yesterday" locale={locale} />
            <KpiTile label="Food cost" money={45600000} delta={-3} lowerIsBetter locale={locale} />
            <StatCard label="Orders" value={248} delta={0} locale={locale} />
            <StatCard label="Avg bill" loading />
          </Demo>
          <Demo title="Outlet switcher and feature gate">
            <OutletSwitcher outlets={[{ id: 'a', name: 'Indiranagar' }, { id: 'b', name: 'Koramangala' }]} value={outlet} onChange={setOutlet} locale={locale} />
            <FeatureGateProvider can={(p) => p === 'reports.view'} flags={{ kds: true, loyalty: false }}>
              <FeatureGate perm="reports.view"><Badge tone="success">Reports: allowed</Badge></FeatureGate>
              <FeatureGate perm="orders.void" fallback={<Badge>Void: not allowed</Badge>}><Badge>Void</Badge></FeatureGate>
              <FeatureGate flag="loyalty" fallback={<Badge>Loyalty: not on plan</Badge>}><Badge>Loyalty</Badge></FeatureGate>
            </FeatureGateProvider>
          </Demo>
          <Demo title="Data table (sort, sticky first column, scroll cue, CSV export)">
            <div style={{ width: '100%', maxWidth: 520 }}>
              <FilterBar activeCount={status === 'ready' ? 0 : 1} onReset={() => setStatus('ready')} locale={locale}>
                <Select label="State" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                  <option value="ready">Ready</option><option value="loading">Loading</option><option value="error">Error</option>
                </Select>
              </FilterBar>
              <DataTable caption="Sales by item" columns={saleCols} rows={saleRows} getKey={(r) => r.id} status={status} onRetry={() => setStatus('ready')} exportName="sales" locale={locale} />
            </div>
          </Demo>
          <Demo title="Keypad (tendered and change)">
            <Keypad value={pad} onChange={setPad} total={46500} quick={[500, 1000, 2000]} locale={locale} />
          </Demo>
          <Demo title="Kitchen screen (far density, always dark)"><div style={{ width: '100%' }}><Kitchen /></div></Demo>
          <Demo title="Overlays">
            <Button onClick={() => setDialog(true)}>Open dialog</Button>
            <Button onClick={() => setSheet(true)}>Open sheet</Button>
            <Button onClick={() => setConfirm(true)}>Confirm (destructive)</Button>
            <ToastButton />
          </Demo>
          <Dialog open={dialog} onOpenChange={setDialog} title="Void this bill?" description="This cannot be undone." locale={locale}
            footer={<><Button onClick={() => setDialog(false)}>Cancel</Button><Button variant="danger-soft" onClick={() => setDialog(false)}>Void bill</Button></>} />
          <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete item?" description="Paneer tikka leaves the menu." confirmLabel="Delete" destructive onConfirm={() => setConfirm(false)} locale={locale} />
          <Sheet open={sheet} onOpenChange={setSheet} title="Pay" locale={locale}><p>Cash, card or UPI.</p></Sheet>
        </main>
      </div>
    </ToastProvider>
  );
}

/** Sign-in shell at `#auth`. Add `?media=test` to load locally generated showcase/public/test-*.webp (never committed). */
function AuthDemo() {
  document.body.style.margin = '0';
  const params = new URLSearchParams(location.search);
  const media: AuthMediaItem[] = params.get('media') === 'test'
    ? [1, 2, 3].map((n) => ({ type: 'image', src: `./test-${n}.webp`, alt: '', credit: n === 2 ? 'Local test image' : undefined }))
    : [];
  const [busy, setBusy] = useState(false);
  return (
    <AuthSplit
      logo={<img src="./brand/logo-wordmark.png" alt="thechilli.ai" height={36} />}
      shapeLogo={<img src="./brand/logo-wordmark.png" alt="" />}
      headline="Business Admin"
      tagline={brandCopy.tagline}
      title="Login to your account"
      subtitle="Welcome back! Enter your details to log in to your account"
      media={media}
      footer={<>Need access? Ask your administrator</>}
    >
      <form onSubmit={(e) => { e.preventDefault(); setBusy(true); setTimeout(() => setBusy(false), 800); }}>
        <Input variant="pill" label="Email" type="email" placeholder="Enter your email" autoComplete="username" />
        <Input variant="pill" label="Password" type="password" placeholder="Enter your password" autoComplete="current-password" />
        <Button type="submit" variant="primary" size="lg" loading={busy}>Sign in</Button>
      </form>
    </AuthSplit>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode>{location.hash === '#auth' ? <AuthDemo /> : <App />}</StrictMode>);
