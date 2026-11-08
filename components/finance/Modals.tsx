'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AlertCurrency, FinanceAsset, Position } from '@/lib/finance/types';
import type { AssetSuggestion } from '@/lib/finance/trade';
import { AssetIcon } from './AssetIcon';
import { Money } from './Privacy';
import { AlertForm, CurrencySwitch } from './PriceAlerts';
import { CLASS_LABEL, money } from './format';
import { ImportForm } from './ImportForm';

// ─── Shared modal shell (matches ConfirmDialog styling) ────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="finance-overlay fade-in" onClick={onClose}>
      <div
        className="finance-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="finance-sheet__head">
          <p className="font-semibold">{title}</p>
          <button type="button" className="finance-close" onClick={onClose} aria-label="Schließen">×</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ─── Add sheet: a booking or a price alert ─────────────────
export function LedgerModal({ assets, initialAssetId, initialMode = 'booking', onClose, onSaved }: {
  assets: FinanceAsset[]; initialAssetId?: string | null; initialMode?: 'booking' | 'alert'; onClose: () => void; onSaved: () => void;
}) {
  const [mode, setMode] = useState<'booking' | 'alert'>(initialMode);
  const [importing, setImporting] = useState(false);
  return (
    <Modal title={mode === 'alert' ? 'Kursalarm' : importing ? 'Aus Datei übernehmen' : 'Buchung hinzufügen'} onClose={onClose}>
      {!initialAssetId && !importing && <div className="finance-seg finance-seg--wide mb-4" role="group" aria-label="Was hinzufügen">
        <button type="button" className={mode === 'booking' ? 'is-active' : ''} aria-pressed={mode === 'booking'} onClick={() => setMode('booking')}>Buchung</button>
        <button type="button" className={mode === 'alert' ? 'is-active' : ''} aria-pressed={mode === 'alert'} onClick={() => setMode('alert')}>Kursalarm</button>
      </div>}
      {mode === 'alert'
        ? <AlertForm assets={assets} onDone={() => window.setTimeout(onClose, 900)} />
        : <>
          {!importing && <BookingForm assets={assets} initialAssetId={initialAssetId} onSaved={onSaved} />}
          {!assets.find((asset) => asset.id === initialAssetId && asset.cls === 'cash') && <>
            {!importing && <div className="finance-or" aria-hidden><span>oder</span></div>}
            <ImportForm onSaved={onSaved} onActive={setImporting} />
          </>}
        </>}
    </Modal>
  );
}

type Picked =
  | { kind: 'existing'; asset: FinanceAsset }
  | { kind: 'market'; suggestion: Extract<AssetSuggestion, { kind: 'market' }> };

function pickedPosition(picked: Picked): Position {
  if (picked.kind === 'existing') {
    const a = picked.asset;
    return { assetId: a.id, name: a.name, cls: a.cls, valueEur: 0, source: 'portfolio', identifier: a.identifier, symbol: a.symbol, coinId: a.coinId };
  }
  const m = picked.suggestion;
  return { name: m.name, cls: m.cls, valueEur: 0, source: 'portfolio', identifier: m.symbol, symbol: m.symbol };
}

function suggestionPosition(item: AssetSuggestion): Position {
  return item.kind === 'existing'
    ? { assetId: item.assetId, name: item.name, cls: item.cls, valueEur: 0, source: 'portfolio', identifier: item.identifier, symbol: item.symbol, coinId: item.coinId }
    : { name: item.name, cls: item.cls, valueEur: 0, source: 'portfolio', identifier: item.symbol, symbol: item.symbol };
}

const fmtShares = (n: number) => n.toLocaleString('de-AT', { maximumFractionDigits: 6 });
const round = (n: number, digits: number) => String(Number(n.toFixed(digits)));


// One search box over the ledger and Yahoo: held and former assets first, then
// new listings that can be added straight away.
function AssetPicker({ assets, onPick }: { assets: FinanceAsset[]; onPick: (picked: Picked) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AssetSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setResults([]);
    if (query.trim().length < 2) { setLoading(false); return; }
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/finance/asset-suggest?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        const json = await response.json();
        if (json.ok) { setResults(json.results); setActive(0); }
      } catch { /* aborted or offline */ } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);

  function choose(item: AssetSuggestion) {
    if (item.kind === 'existing') {
      const asset = assets.find((entry) => entry.id === item.assetId);
      if (asset) onPick({ kind: 'existing', asset });
    } else onPick({ kind: 'market', suggestion: item });
  }
  // Ledger matches are filtered here so they show while typing; Yahoo results follow.
  const q = query.trim().toLocaleLowerCase('de-AT');
  const existing: AssetSuggestion[] = assets
    .filter((asset) => !asset.importedDummy)
    .filter((asset) => q ? `${asset.name} ${asset.identifier} ${asset.symbol || ''} ${asset.isin || ''} ${asset.yahooSymbol || ''}`.toLocaleLowerCase('de-AT').includes(q) : asset.active)
    .map((asset) => ({ kind: 'existing' as const, assetId: asset.id, name: asset.name, cls: asset.cls, symbol: asset.symbol, identifier: asset.identifier,
      held: asset.active && (asset.cls === 'cash' || asset.shares > 1e-10), shares: asset.shares, coinId: asset.coinId }))
    .sort((a, b) => Number(b.held) - Number(a.held) || a.name.localeCompare(b.name, 'de-AT'))
    .slice(0, q ? 8 : 12);
  const market = q.length >= 2 ? results.filter((item) => item.kind === 'market') : [];
  const ordered = [...existing, ...market];

  return <div className="finance-picker">
    <input ref={inputRef} className="input" type="search" role="combobox" aria-expanded aria-controls="finance-picker-list" aria-label="Asset suchen"
      placeholder="Aktie, ETF oder Krypto suchen…" value={query}
      onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, ordered.length - 1)); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
        if (event.key === 'Enter' && ordered[active]) { event.preventDefault(); choose(ordered[active]); }
      }} />
    <div className="finance-picker__list" id="finance-picker-list" role="listbox">
      {!!existing.length && <p className="finance-picker__group">{query.trim() ? 'In deinem Depot' : 'Aktuelle Positionen'}</p>}
      {existing.map((item) => <Option key={item.kind === 'existing' ? item.assetId : ''} item={item} active={ordered.indexOf(item) === active} onChoose={() => choose(item)} />)}
      {(!!market.length || loading) && <p className="finance-picker__group">Neu hinzufügen</p>}
      {loading && <p className="finance-picker__empty">Suche an der Börse…</p>}
      {market.map((item) => <Option key={item.kind === 'market' ? item.yahooSymbol : ''} item={item} active={ordered.indexOf(item) === active} onChoose={() => choose(item)} />)}
      {!loading && query.trim().length >= 2 && !ordered.length && <p className="finance-picker__empty">Nichts gefunden. Ticker oder ISIN probieren.</p>}
    </div>
  </div>;
}

function Option({ item, active, onChoose }: { item: AssetSuggestion; active: boolean; onChoose: () => void }) {
  const meta = item.kind === 'existing'
    ? item.cls === 'cash' ? 'Konto' : item.held ? `Im Depot · ${fmtShares(item.shares)}` : 'Früher gehalten'
    : `${CLASS_LABEL[item.cls]} · ${item.symbol}${item.exchange ? ` · ${item.exchange}` : ''}`;
  return <button type="button" role="option" aria-selected={active} className={`finance-picker__option${active ? ' is-active' : ''}`} onClick={onChoose}>
    <AssetIcon position={suggestionPosition(item)} size={30} />
    <span className="min-w-0 flex-1"><strong>{item.name}</strong><small>{meta}</small></span>
    {item.kind === 'market' && <span className="finance-picker__add" aria-hidden>+</span>}
  </button>;
}

type Field = 'shares' | 'price' | 'amount';

function BookingForm({ assets, initialAssetId, onSaved }: { assets: FinanceAsset[]; initialAssetId?: string | null; onSaved: () => void }) {
  const initial = assets.find((asset) => asset.id === initialAssetId);
  const [picked, setPicked] = useState<Picked | null>(initial ? { kind: 'existing', asset: initial } : null);
  const [type, setType] = useState(initial?.cls === 'cash' ? 'deposit' : 'buy');
  const [datetime, setDatetime] = useState(localNow());
  const [currencyChoice, setCurrencyChoice] = useState<AlertCurrency>('EUR');
  const [values, setValues] = useState<Record<Field | 'fee' | 'tax', string>>({ shares: '', price: '', amount: '', fee: '', tax: '' });
  // Which of shares/amount the user typed last decides what a price change recomputes.
  const [driver, setDriver] = useState<'shares' | 'amount'>('shares');
  const [priceManual, setPriceManual] = useState(false);
  const [quote, setQuote] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; date?: string; source?: string }>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCash = picked?.kind === 'existing' && picked.asset.cls === 'cash';
  const currency: AlertCurrency = isCash ? 'EUR' : currencyChoice;
  const symbol = currency === 'USD' ? '$' : '€';
  const tradeDate = datetime.slice(0, 10);
  const hasUnits = type === 'buy' || type === 'sell';
  const pickedKey = picked ? picked.kind === 'existing' ? picked.asset.id : picked.suggestion.yahooSymbol : '';

  // Recompute the dependent field: amount = shares × price, or shares = amount ÷ price.
  function derive(next: Record<Field | 'fee' | 'tax', string>, changed: Field, by: 'shares' | 'amount'): Record<Field | 'fee' | 'tax', string> {
    const shares = Number(next.shares); const price = Number(next.price); const amount = Number(next.amount);
    if (changed === 'shares' && shares > 0 && price > 0) return { ...next, amount: round(shares * price, 2) };
    if (changed === 'amount' && amount > 0 && price > 0) return { ...next, shares: round(amount / price, 8) };
    if (changed === 'price' && price > 0) {
      if (by === 'shares' && shares > 0) return { ...next, amount: round(shares * price, 2) };
      if (by === 'amount' && amount > 0) return { ...next, shares: round(amount / price, 8) };
    }
    return next;
  }
  function edit(field: Field | 'fee' | 'tax', value: string) {
    setValues((current) => {
      const next = { ...current, [field]: value };
      if (field === 'fee' || field === 'tax') return next;
      if (field === 'price') { setPriceManual(value !== ''); return derive(next, 'price', driver); }
      setDriver(field === 'amount' ? 'amount' : 'shares');
      return derive(next, field, field === 'amount' ? 'amount' : 'shares');
    });
  }

  // Market price on the trade date fills the price unless the user typed one.
  useEffect(() => {
    if (!picked || isCash || !hasUnits || priceManual || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) { if (!picked || isCash) setQuote({ state: 'idle' }); return; }
    const controller = new AbortController();
    setQuote({ state: 'loading' });
    const params = new URLSearchParams({ date: tradeDate, currency });
    if (picked.kind === 'existing') params.set('assetId', picked.asset.id); else params.set('symbol', picked.suggestion.yahooSymbol);
    fetch(`/api/finance/quote?${params}`, { signal: controller.signal }).then((response) => response.json()).then((json) => {
      if (!json.ok) { setQuote({ state: 'error' }); return; }
      const digits = json.price < 1 ? 6 : 2;
      setValues((current) => derive({ ...current, price: round(json.price, digits) }, 'price', driver));
      setQuote({ state: 'ok', date: json.date, source: json.source });
    }).catch(() => { if (!controller.signal.aborted) setQuote({ state: 'error' }); });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey, tradeDate, currency, priceManual, hasUnits, isCash]);

  const [fx, setFx] = useState<number | null>(null);
  useEffect(() => {
    setFx(null);
    if (currency === 'EUR' || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) return;
    let live = true;
    fetch(`/api/finance/fx?from=${currency}&to=EUR&date=${tradeDate}`).then((res) => res.json())
      .then((json) => { if (live && json.ok) setFx(json.rate); }).catch(() => undefined);
    return () => { live = false; };
  }, [currency, tradeDate]);

  function pick(next: Picked) {
    setPicked(next);
    setError(null);
    setPriceManual(false);
    const cls = next.kind === 'existing' ? next.asset.cls : next.suggestion.cls;
    setType(cls === 'cash' ? 'deposit' : 'buy');
    if (next.kind === 'existing' && next.asset.currency === 'USD' && cls !== 'crypto') setCurrencyChoice('USD');
    if (next.kind === 'market' && cls !== 'crypto' && !/\.[A-Z]+$/.test(next.suggestion.yahooSymbol)) setCurrencyChoice('USD');
    if (next.kind === 'market' && /\.(DE|F|MU|VI|AS|PA|MI|MC|BR)$/.test(next.suggestion.yahooSymbol)) setCurrencyChoice('EUR');
    if (cls === 'crypto') setCurrencyChoice('EUR');
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      if (!picked) throw new Error('Bitte zuerst ein Asset suchen und auswählen.');
      const amount = Number(values.amount || (Number(values.shares) * Number(values.price)));
      if (!datetime || !(amount > 0)) throw new Error('Datum und Gesamtbetrag sind erforderlich.');
      if (hasUnits && !(Number(values.shares) > 0)) throw new Error('Für Kauf und Verkauf sind positive Anteile erforderlich.');
      if (type === 'sell' && picked.kind === 'existing' && Number(values.shares) > picked.asset.shares + 1e-9) {
        throw new Error(`Im Depot sind nur ${fmtShares(picked.asset.shares)} Anteile.`);
      }
      let assetId: string;
      let name: string;
      let identifier: string;
      if (picked.kind === 'existing') {
        ({ id: assetId, name, identifier } = picked.asset);
      } else {
        const m = picked.suggestion;
        if (type !== 'buy') throw new Error('Ein neues Asset beginnt mit einem Kauf.');
        const created = await api('POST', '/api/finance/assets', {
          name: m.name, cls: m.cls, identifier: m.symbol, symbol: m.symbol, yahooSymbol: m.yahooSymbol,
          currency: m.cls === 'crypto' ? 'EUR' : currency, active: false,
        });
        assetId = String(created.id);
        name = m.name; identifier = m.symbol;
        setPicked({ kind: 'existing', asset: { id: assetId, name, cls: m.cls, identifier, symbol: m.symbol, yahooSymbol: m.yahooSymbol, active: false, shares: 0, costEur: 0, realizedEur: 0 } });
      }
      await api('POST', '/api/finance/transactions', {
        assetId, type, datetime: new Date(datetime).toISOString(), name, identifier,
        shares: hasUnits ? Number(values.shares) : undefined, price: hasUnits ? Number(values.price) : undefined, amount,
        fee: isCash ? 0 : Number(values.fee) || 0, tax: isCash ? 0 : Number(values.tax) || 0, currency,
      });
      onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setSaving(false); }
  }

  if (!picked) return <AssetPicker assets={assets} onPick={pick} />;

  const typedTotal = Number(values.amount || (Number(values.shares) * Number(values.price))) || 0;
  const cls = picked.kind === 'existing' ? picked.asset.cls : picked.suggestion.cls;
  const selectedMeta = picked.kind === 'existing'
    ? cls === 'cash' ? `Kontostand ${money(picked.asset.shares || 0)}` : picked.asset.shares > 1e-10 ? `Im Depot · ${fmtShares(picked.asset.shares)} Anteile` : 'Früher gehalten'
    : `Neu · ${CLASS_LABEL[cls]} · ${picked.suggestion.symbol}`;

  return (
    <div className="space-y-3">
      <div className="finance-picked">
        <AssetIcon position={pickedPosition(picked)} size={38} />
        <span className="min-w-0 flex-1"><strong>{pickedPosition(picked).name}</strong><small>{selectedMeta}</small></span>
        {!initialAssetId && <button type="button" className="btn-ghost text-xs" onClick={() => { setPicked(null); setValues({ shares: '', price: '', amount: '', fee: '', tax: '' }); setPriceManual(false); }}>Ändern</button>}
      </div>
      {isCash && picked.kind === 'existing' && <p className="text-secondary text-xs">Buchungen ab dem {picked.asset.openingBalanceDate || 'Eröffnungsdatum'}.</p>}
      <div className="finance-seg finance-seg--wide" role="group" aria-label="Art">
        {(isCash ? [['deposit', 'Einzahlung'], ['withdrawal', 'Auszahlung']] : picked.kind === 'market' ? [['buy', 'Kauf']] : [['buy', 'Kauf'], ['sell', 'Verkauf'], ['dividend', 'Dividende']]).map(([key, label]) => (
          <button key={key} type="button" className={type === key ? `is-active is-${key}` : ''} aria-pressed={type === key} onClick={() => setType(key)}>{label}</button>
        ))}
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
        <Field label="Datum"><input className="input" type="datetime-local" value={datetime} onChange={(event) => setDatetime(event.target.value)} /></Field>
        {!isCash && <div><span className="field-label">Währung</span><CurrencySwitch value={currency} onChange={setCurrencyChoice} /></div>}
      </div>
      {hasUnits && <div className="grid grid-cols-2 gap-3">
        <Field label="Anteile"><input className="input" type="number" inputMode="decimal" step="any" value={values.shares} onChange={(event) => edit('shares', event.target.value)} /></Field>
        <Field label={`Preis je Anteil (${symbol})`}><input className="input" type="number" inputMode="decimal" step="any" value={values.price} onChange={(event) => edit('price', event.target.value)} placeholder={quote.state === 'loading' ? 'Kurs wird geladen…' : ''} /></Field>
      </div>}
      {hasUnits && <p className="finance-quote-hint">
        {quote.state === 'loading' && 'Kurs wird geladen…'}
        {quote.state === 'ok' && !priceManual && <>Schlusskurs vom {quote.date?.split('-').reverse().join('.')} · Yahoo Finance. Mit dem tatsächlichen Preis überschreiben.</>}
        {priceManual && <>Eigener Preis. <button type="button" className="finance-inline-link" onClick={() => setPriceManual(false)}>Marktkurs verwenden</button></>}
        {quote.state === 'error' && !priceManual && 'Kein Marktkurs gefunden. Bitte Preis eingeben.'}
      </p>}
      <Field label={`Gesamtbetrag (${symbol})`}><input className="input" type="number" inputMode="decimal" step="any" value={values.amount} onChange={(event) => edit('amount', event.target.value)} placeholder={hasUnits ? 'Oder Betrag eingeben, Anteile werden berechnet' : 'Betrag'} /></Field>
      {!isCash && <div className="grid grid-cols-2 gap-3">
        <Field label={`Gebühr (${symbol})`}><input className="input" type="number" inputMode="decimal" step="any" value={values.fee} onChange={(event) => edit('fee', event.target.value)} /></Field>
        <Field label={`Steuer (${symbol})`}><input className="input" type="number" inputMode="decimal" step="any" value={values.tax} onChange={(event) => edit('tax', event.target.value)} /></Field>
      </div>}
      {currency !== 'EUR' && <p className="text-secondary text-xs">
        {fx ? <>Wechselkurs vom {tradeDate.split('-').reverse().join('.')}: 1 $ = {money(fx, 'EUR', { decimals: 4 })}{typedTotal > 0 && <> · verbucht als <Money>{money(typedTotal * fx, 'EUR')}</Money></>}</> : 'Wechselkurs wird geladen…'}
      </p>}
      {error && <p className="text-red text-xs">{error}</p>}
      <button className="btn btn-primary w-full" onClick={save} disabled={saving}>
        {saving ? 'Speichern…' : picked.kind === 'market' ? `${picked.suggestion.symbol} hinzufügen und Kauf speichern` : isCash ? 'Kontobewegung speichern' : 'Buchung speichern'}
      </button>
    </div>
  );
}

// datetime-local wants local wall time, not UTC.
function localNow() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
