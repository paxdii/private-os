'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fetchCached } from '@/lib/fetchCache';
import type { AlertCurrency, FinanceActivity, FinanceAsset, Position } from '@/lib/finance/types';
import type { FinancePeriod } from '@/lib/finance/period';
import { AssetIcon } from './AssetIcon';
import { CLASS_LABEL, eur, gainColor, money, pct, signedEur, signedPct } from './format';
import { Money } from './Privacy';
import { AlertForm, AlertList, CurrencySwitch, useAlerts } from './PriceAlerts';
import { PeriodSelector } from './PeriodSelector';

type HistoryResponse = {
  ok: boolean;
  points: { date: string; value: number }[];
  currency: string;
  nativeCurrency?: string;
  limited: boolean;
  source: string | null;
  period: FinancePeriod;
  averageEntry: number | null;
};

const CURRENCY_KEY = 'finance-chart-currency';

function storedCurrency(): AlertCurrency {
  try { return localStorage.getItem(CURRENCY_KEY) === 'USD' ? 'USD' : 'EUR'; } catch { return 'EUR'; }
}

export function PositionDetail({
  position, period, activities, assets, onClose, onAdd,
}: {
  position: Position;
  period: FinancePeriod;
  activities: FinanceActivity[];
  assets: FinanceAsset[];
  onClose: () => void;
  onAdd?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [currency, setCurrency] = useState<AlertCurrency>('EUR');
  const [alertOpen, setAlertOpen] = useState(false);
  const [chartPeriod, setChartPeriod] = useState<FinancePeriod>(period);
  const alerts = useAlerts();
  useEffect(() => { setCurrency(storedCurrency()); }, []);
  function chooseCurrency(next: AlertCurrency) {
    setCurrency(next);
    try { localStorage.setItem(CURRENCY_KEY, next); } catch { /* private mode */ }
  }

  const isCash = position.cls === 'cash';
  const url = position.assetId && !isCash
    ? `/api/finance/price-history?assetId=${encodeURIComponent(position.assetId)}&period=${chartPeriod}&currency=${currency}`
    : null;
  const [history, setHistory] = useState<{ data?: HistoryResponse; loading: boolean; error: boolean }>({ loading: true, error: false });
  useEffect(() => {
    if (!url) { setHistory({ loading: false, error: false }); return; }
    let live = true;
    setHistory({ loading: true, error: false });
    void fetchCached<HistoryResponse>(url, 15 * 60_000).then(
      (data) => { if (live) setHistory({ data, loading: false, error: false }); },
      () => { if (live) setHistory({ loading: false, error: true }); },
    );
    return () => { live = false; };
  }, [url]);
  const currentHistory = history.data?.currency === currency && history.data.period === chartPeriod ? history.data : undefined;
  const points = currentHistory?.points || [];
  const averageEntry = currentHistory?.averageEntry;
  const first = points[0]?.value;
  const last = points.at(-1)?.value;
  const change = first && last ? last / first - 1 : null;
  // The axis follows the prices; reference lines outside that band are not drawn,
  // otherwise a far-off entry price flattens the chart.
  const values = points.map((point) => point.value);
  const min0 = values.length ? Math.min(...values) : 0;
  const max0 = values.length ? Math.max(...values) : 0;
  const entryInRange = averageEntry != null && points.length > 1 && averageEntry >= min0 - yPad(min0, max0) && averageEntry <= max0 + yPad(min0, max0);
  const priceTone = change == null || change >= 0 ? UP : DOWN;
  const lineColor = '#c9d1dd';
  const ownAlerts = alerts.active.filter((alert) => alert.assetId === position.assetId);
  const chartAlerts = ownAlerts.filter((alert) => alert.currency === currency);

  const allOwnActivities = activities
    .filter((activity) => (position.assetId ? activity.assetId === position.assetId : activity.identifier === position.identifier)
      && (!isCash || !position.openingBalanceDate || activity.datetime.slice(0, 10) > position.openingBalanceDate))
    .sort((a, b) => b.datetime.localeCompare(a.datetime));
  const ownActivities = allOwnActivities.slice(0, 12);
  const markers = allOwnActivities.filter((activity) => activity.type === 'buy' || activity.type === 'sell').map((activity) => {
    const date = activity.datetime.slice(0, 10);
    if (!points.length || date < points[0].date || date > points.at(-1)!.date) return null;
    const point = points.find((entry) => entry.date >= date) || points.at(-1);
    return point ? { id: activity.id, date: point.date, value: point.value, type: activity.type } : null;
  }).filter((item): item is { id: string; date: string; value: number; type: 'buy' | 'sell' } => item != null);

  async function copyIdentifier() {
    if (!position.identifier) return;
    try { await navigator.clipboard.writeText(position.identifier); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { setCopied(false); }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) { if (event.key === 'Escape') onClose(); }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;
  const subtitle = isCash ? 'Cash · EUR' : [CLASS_LABEL[position.cls], position.symbol || position.identifier].filter(Boolean).join(' · ');

  return createPortal(
    <div className="finance-overlay" onClick={onClose}>
      <div className="finance-detail" role="dialog" aria-modal="true" aria-label={`Position ${position.name}`} onClick={(event) => event.stopPropagation()}>
        <div className="finance-detail__head">
          <div className="flex items-center gap-3 min-w-0">
            <AssetIcon position={position} size={48} />
            <div className="min-w-0">
              <h2 className="finance-detail__title">{position.name}</h2>
              <p className="text-secondary text-xs mt-0.5">
                {subtitle}
                {position.identifier && !isCash && position.identifier !== position.symbol && <>
                  {' · '}<button type="button" className="finance-inline-link" onClick={copyIdentifier} aria-label={`${position.identifier} kopieren`}>{copied ? 'kopiert' : position.identifier}</button>
                </>}
              </p>
            </div>
          </div>
          <button type="button" className="finance-close" onClick={onClose} aria-label="Schließen">×</button>
        </div>

        <div className="finance-detail__stats">
          <Stat label={isCash ? 'Kontostand' : 'Marktwert'}><Money>{eur(position.valueEur, { decimals: true })}</Money></Stat>
          {isCash
            ? <Stat label={`Eröffnung · ${position.openingBalanceDate || 'Übernahme'}`}><Money>{eur(position.openingBalanceEur || 0, { decimals: true })}</Money></Stat>
            : <>
              <Stat label="Seit Kauf">
                <span style={{ color: gainColor(position.gainEur) }}>{position.gainPct != null ? signedPct(position.gainPct) : '—'}</span>
                {position.gainEur != null && <small><Money><span style={{ color: gainColor(position.gainEur) }}>{signedEur(position.gainEur)}</span></Money></small>}
              </Stat>
              <Stat label="Einstand"><Money>{position.costEur != null ? eur(position.costEur, { decimals: true }) : '—'}</Money>
                {!!position.realizedEur && <small>Realisiert <Money>{signedEur(position.realizedEur)}</Money></small>}
              </Stat>
              <Stat label="Anteile">{position.shares?.toLocaleString('de-AT', { maximumFractionDigits: 5 }) ?? '—'}
                <small>{pct(position.allocationPct || 0, 1)} vom Portfolio</small>
              </Stat>
            </>}
        </div>

        {isCash ? <div className="finance-cash-detail">
          <p className="text-secondary text-sm">Ein- und Auszahlungen ändern den Kontostand und erscheinen im Verlauf als Buchung, nicht als Gewinn oder Verlust.</p>
          {onAdd && <button type="button" className="btn-primary text-sm" onClick={onAdd}>Ein- oder Auszahlung buchen</button>}
        </div> : <>
          <div className="finance-detail__chart-head">
            <div className="min-w-0">
              <div className="finance-detail__price">
                {last != null ? money(last, currency) : '—'}
                {change != null && <span style={{ color: gainColor(change) }}>{signedPct(change)}</span>}
              </div>
              <p className="text-muted text-xs mt-1">
                {chartPeriod === 'ALL' ? 'Gesamter Verlauf' : `Verlauf ${chartPeriod === '1Y' ? '1 Jahr' : chartPeriod === '3Y' ? '3 Jahre' : chartPeriod}`}
                {history.data?.source ? ` · ${history.data.source}` : ''}
                {history.data?.nativeCurrency && history.data.nativeCurrency !== currency ? ` · umgerechnet aus ${history.data.nativeCurrency}` : ''}
              </p>
              {averageEntry != null && <p className="text-secondary text-xs mt-1" title="Anschaffungskosten des verbleibenden Bestands einschließlich Kaufgebühren und Steuern, geteilt durch die Anteile. Bei USD zum aktuellen Wechselkurs umgerechnet.">Ø Einstand {money(averageEntry, currency)} · aktueller Bestand</p>}
            </div>
            <CurrencySwitch value={currency} onChange={chooseCurrency} />
          </div>
          <div className="mt-3 mb-2"><PeriodSelector value={chartPeriod} onChange={setChartPeriod} label="Zeitraum für den Positionschart" /></div>
          <div className="finance-detail__chart">
            {history.loading && !points.length && !history.error ? <div className="finance-detail__empty">Kursdaten werden geladen…</div> : null}
            {history.error ? <div className="finance-detail__empty">Kursverlauf gerade nicht verfügbar.</div> : null}
            {!history.loading && !history.error && history.data && points.length < 2 ? <div className="finance-detail__empty">Für diese Position gibt es keine historischen Kurse.</div> : null}
            {points.length >= 2 && (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="financeDetailFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={lineColor} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="rgba(255,255,255,.055)" />
                  <XAxis dataKey="date" minTickGap={40} axisLine={false} tickLine={false} tick={{ fill: 'rgba(245,242,240,.34)', fontSize: 10 }} tickFormatter={shortDate} />
                  <YAxis width={52} domain={[(min: number) => min - (yPad(min, max0) || min * 0.02), (max: number) => max + (yPad(min0, max) || max * 0.02)]} axisLine={false} tickLine={false} tick={{ fill: 'rgba(245,242,240,.34)', fontSize: 10 }} tickFormatter={(value) => axisNumber(Number(value))} />
                  <Tooltip
                    contentStyle={{ background: '#2a272b', border: 0, borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,.4)', fontSize: 12 }}
                    labelStyle={{ color: 'rgba(245,242,240,.6)' }}
                    labelFormatter={(label) => longDate(String(label))}
                    formatter={(value: number) => [money(value, currency), 'Kurs']}
                  />
                  {chartAlerts.map((alert) => (
                    <ReferenceLine key={alert.id} y={alert.target} stroke="#e8a33d" strokeDasharray="5 4" strokeOpacity={0.8} ifOverflow="discard"
                      label={{ value: `Alarm ${money(alert.target, currency)}`, position: 'insideTopRight', fill: '#e8a33d', fontSize: 10 }} />
                  ))}
                  {markers.map((marker) => <ReferenceLine key={`line-${marker.id}`} x={marker.date} stroke={marker.type === 'buy' ? BUY : SELL} strokeWidth={1.5} strokeOpacity={0.75} />)}
                  <Area dataKey="value" type="monotone" stroke={lineColor} strokeWidth={2} fill="url(#financeDetailFill)" dot={false} />
                  {entryInRange && <ReferenceLine y={averageEntry!} stroke="#8fa6d6" strokeDasharray="6 4" ifOverflow="discard"
                    label={{ value: `Ø Einstand ${money(averageEntry, currency)}`, position: 'insideTopLeft', fill: "#8fa6d6", fontSize: 10 }} />}
                  {markers.map((marker) => <ReferenceDot key={marker.id} x={marker.date} y={marker.value} r={6} shape={(props: { cx?: number; cy?: number }) => <TradeMark cx={props.cx} cy={props.cy} type={marker.type} />} />)}
                  {last != null && <ReferenceLine y={last} stroke={priceTone} strokeDasharray="2 3" strokeOpacity={0.9} ifOverflow="discard"
                    label={(props: { viewBox?: { x: number; y: number; width: number } }) => <PriceTag viewBox={props.viewBox} text={last.toLocaleString('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(last) < 1 ? 4 : 2 })} color={priceTone} />} />}
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="finance-trade-legend">
            {markers.some((m) => m.type === 'buy') && <span><i className="finance-trade-legend__buy" /> Kauf</span>}
            {markers.some((m) => m.type === 'sell') && <span><i className="finance-trade-legend__sell" /> Verkauf</span>}
            {averageEntry != null && <span><i className="finance-trade-legend__entry" /> Ø Einstand{!entryInRange && ` ${money(averageEntry, currency)} ${averageEntry > max0 ? '↑ über' : '↓ unter'} dem Bereich`}</span>}
            {last != null && <span><i className="finance-trade-legend__now" style={{ borderColor: priceTone }} /> Aktueller Kurs</span>}
          </div>
          {position.cls === 'metals' && <p className="text-muted text-xs mt-2">Richtwert aus Börsen-Futures je gebuchter Einheit, ohne Münz-Aufschlag.</p>}

          <div className="finance-detail__section">
            <div className="finance-detail__section-head">
              <h3>Kursalarm</h3>
              {!alertOpen && position.assetId && <button type="button" className="btn-sm" onClick={() => setAlertOpen(true)}>Alarm setzen</button>}
            </div>
            <AlertList alerts={ownAlerts} onRemove={(id) => void alerts.remove(id)} />
            {!ownAlerts.length && !alertOpen && <p className="text-muted text-xs">Benachrichtigung per Push und oben im Dashboard, sobald ein Zielkurs erreicht ist.</p>}
            {alertOpen && position.assetId && <div className="finance-detail__alert-form">
              <AlertForm assets={assets} assetId={position.assetId} defaultCurrency={currency} onDone={() => setAlertOpen(false)} />
            </div>}
          </div>
        </>}

        <div className="finance-detail__section">
          <div className="finance-detail__section-head"><h3>Letzte Buchungen</h3></div>
          <div className="finance-detail__transactions">
            {ownActivities.length ? ownActivities.map((activity) => (
              <div key={activity.id}>
                <span><i className={`finance-tx-chip finance-tx-chip--${activity.type}`}>{activityLabel(activity.type)}</i><small>{tradeLine(activity)}</small></span>
                <span>{shortDateYear(activity.datetime.slice(0, 10))}</span>
                <span className="text-right">
                  <Money><span className={`finance-tx-amount finance-tx-amount--${activity.type}`}>{amountSign(activity.type)}{activity.currency && activity.currency !== 'EUR' && activity.amountOriginal != null ? money(activity.amountOriginal, activity.currency) : eur(activity.amount, { decimals: true })}</span></Money>
                  {activity.type === 'sell' && activity.realizedGainNet != null && <small><Money><span style={{ color: gainColor(activity.realizedGainNet) }}>{signedEur(activity.realizedGainNet)} realisiert</span></Money></small>}
                  {activity.currency && activity.currency !== 'EUR' && <small><Money>≈ {eur(activity.amount, { decimals: true })}</Money></small>}
                </span>
              </div>
            )) : <p className="text-secondary text-sm">{isCash ? 'Noch keine Kontobewegungen seit der Übernahme.' : 'Keine Buchungen für diese Position.'}</p>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const BUY = '#5fbf86';
const SELL = '#e8774f';
const UP = '#5fbf86';
const DOWN = '#e5604f';

function amountSign(type: FinanceActivity['type']) {
  return type === 'buy' || type === 'withdrawal' || type === 'transfer_out' || type === 'fees_taxes' ? '−' : type === 'sell' || type === 'dividend' || type === 'interest' || type === 'deposit' ? '+' : '';
}

// Buy: green triangle pointing up; sell: orange triangle pointing down.
function TradeMark({ cx, cy, type }: { cx?: number; cy?: number; type: 'buy' | 'sell' }) {
  if (cx == null || cy == null) return null;
  const color = type === 'buy' ? BUY : SELL;
  const path = type === 'buy'
    ? `M${cx},${cy - 7} L${cx + 6},${cy + 4} L${cx - 6},${cy + 4} Z`
    : `M${cx},${cy + 7} L${cx + 6},${cy - 4} L${cx - 6},${cy - 4} Z`;
  return <path d={path} fill={color} stroke="#211f22" strokeWidth={1.5} />;
}

// Price pill on the right edge, like a trading chart's last-price marker.
function PriceTag({ viewBox, text, color }: { viewBox?: { x: number; y: number; width: number }; text: string; color: string }) {
  if (!viewBox) return null;
  const width = Math.max(44, text.length * 6.6 + 12);
  const x = viewBox.x + viewBox.width - width;
  return <g>
    <rect x={x} y={viewBox.y - 9} width={width} height={18} rx={5} fill={color} />
    <text x={x + width / 2} y={viewBox.y + 4} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="#14231a">{text}</text>
  </g>;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><span>{label}</span><strong>{children}</strong></div>;
}

function tradeLine(activity: FinanceActivity) {
  if (activity.shares == null || !activity.shares) return '';
  const shares = `${activity.shares.toLocaleString('de-AT', { maximumFractionDigits: 8 })} Anteile`;
  if (activity.currency && activity.currency !== 'EUR' && activity.priceOriginal != null) return `${shares} · ${money(activity.priceOriginal, activity.currency)} je Anteil`;
  return activity.price != null ? `${shares} · ${money(activity.price)} je Anteil` : shares;
}

function yPad(min: number, max: number) {
  return (max - min) * 0.08;
}

function axisNumber(value: number) {
  return value.toLocaleString('de-AT', { maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0 });
}

function shortDate(date: string) {
  return new Intl.DateTimeFormat('de-AT', { day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`));
}
function shortDateYear(date: string) {
  return new Intl.DateTimeFormat('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date(`${date}T12:00:00Z`));
}
function longDate(date: string) {
  return new Intl.DateTimeFormat('de-AT', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
}

function activityLabel(type: FinanceActivity['type']) {
  const labels: Record<FinanceActivity['type'], string> = {
    buy: 'Kauf', sell: 'Verkauf', dividend: 'Dividende', interest: 'Zinsen',
    deposit: 'Einzahlung', withdrawal: 'Auszahlung', transfer_in: 'Übertrag ein',
    transfer_out: 'Übertrag aus', fees_taxes: 'Gebühren / Steuern',
  };
  return labels[type];
}
