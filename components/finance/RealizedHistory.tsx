'use client';
import { useMemo, useState } from 'react';
import { appToday } from '@/lib/date';
import type { FinanceActivity, FinanceAsset, Position } from '@/lib/finance/types';
import { bucketSales, realizedSales, type RealizedSale } from '@/lib/finance/realized';
import { eur, signedEur, signedPct, gainColor } from './format';
import { Money } from './Privacy';
import { AssetIcon } from './AssetIcon';

type PositionGroup = { key: string; name: string; assetId?: string; identifier?: string; sales: RealizedSale[]; gainEur: number; gainPct: number | null };

function byPosition(sales: RealizedSale[]): PositionGroup[] {
  const map = new Map<string, RealizedSale[]>();
  for (const sale of sales) map.set(sale.key, [...(map.get(sale.key) || []), sale]);
  return [...map.entries()].map(([key, list]) => {
    const gainEur = list.reduce((sum, s) => sum + s.gainEur, 0);
    const basis = list.reduce((sum, s) => sum + s.costEur, 0);
    return { key, name: list[0].name, assetId: list[0].assetId, identifier: list[0].identifier, sales: list, gainEur, gainPct: basis > 0.005 ? gainEur / basis : null };
  }).sort((a, b) => b.sales[0].datetime.localeCompare(a.sales[0].datetime));
}

// Closed trades: the current year split into recent periods, older years folded away.
export function RealizedHistory({ activities, assets }: { activities: FinanceActivity[]; assets: FinanceAsset[] }) {
  const today = appToday();
  const year = Number(today.slice(0, 4));
  const sales = useMemo(() => realizedSales(activities), [activities]);
  const buckets = useMemo(() => bucketSales(sales, today), [sales, today]);
  const [openYears, setOpenYears] = useState<Set<number>>(() => new Set([year]));
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);

  const sum = (list: RealizedSale[]) => list.reduce((total, sale) => total + sale.gainEur, 0);
  const total = sum(sales);
  const thisYear = sales.filter((sale) => sale.datetime.startsWith(String(year)));
  const wins = sales.filter((sale) => sale.gainEur > 0).length;
  const years = [...new Set(buckets.map((bucket) => bucket.year))];

  function toggle<T>(set: Set<T>, value: T, update: (next: Set<T>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    update(next);
  }

  function iconFor(group: PositionGroup): Position {
    const asset = group.assetId ? assetById.get(group.assetId) : undefined;
    return { name: group.name, cls: asset?.cls || 'stocks', valueEur: 0, source: 'portfolio', identifier: asset?.identifier || group.identifier, symbol: asset?.symbol, coinId: asset?.coinId };
  }

  return <section className="finance-panel finance-history">
    <div className="finance-panel-head">
      <div>
        <h2>Verlauf</h2>
        <p className="finance-history__sub">Realisierte Gewinne und Verluste aus Verkäufen</p>
      </div>
    </div>

    {!sales.length ? <p className="text-secondary text-sm">Noch keine Verkäufe erfasst.</p> : <>
      <div className="finance-history__stats">
        <div><span>{year}</span><Money><strong style={{ color: gainColor(sum(thisYear)) }}>{signedEur(sum(thisYear))}</strong></Money><small>{thisYear.length} {thisYear.length === 1 ? 'Verkauf' : 'Verkäufe'}</small></div>
        <div><span>Gesamt</span><Money><strong style={{ color: gainColor(total) }}>{signedEur(total)}</strong></Money><small>{sales.length} Verkäufe</small></div>
        <div><span>Trefferquote</span><strong>{Math.round((wins / sales.length) * 100)} %</strong><small>{wins} im Plus · {sales.length - wins} im Minus</small></div>
      </div>

      <div className="finance-history__years">
        {years.map((y) => {
          const yearBuckets = buckets.filter((bucket) => bucket.year === y);
          const yearSales = yearBuckets.flatMap((bucket) => bucket.sales);
          const open = openYears.has(y);
          return <div key={y} className={`finance-history__year${open ? ' is-open' : ''}`}>
            <button type="button" className="finance-history__year-head" aria-expanded={open} onClick={() => toggle(openYears, y, setOpenYears)}>
              <span className="finance-realized-chevron" data-open={open} aria-hidden>›</span>
              <strong>{y}</strong>
              <span className="finance-history__count">{yearSales.length} {yearSales.length === 1 ? 'Verkauf' : 'Verkäufe'}</span>
              <Money className="finance-history__year-total"><span style={{ color: gainColor(sum(yearSales)) }}>{signedEur(sum(yearSales))}</span></Money>
            </button>
            {open && yearBuckets.map((bucket) => <div key={bucket.id} className="finance-history__bucket">
              {y === year && <div className="finance-history__bucket-head">
                <span>{bucket.label}</span>
                <Money><span style={{ color: gainColor(sum(bucket.sales)) }}>{signedEur(sum(bucket.sales))}</span></Money>
              </div>}
              {byPosition(bucket.sales).map((group) => {
                const rowKey = `${bucket.id}:${group.key}`;
                const expanded = openRows.has(rowKey);
                return <div key={rowKey} className="finance-history__row-wrap">
                  <button type="button" className="finance-history__row" aria-expanded={expanded} onClick={() => toggle(openRows, rowKey, setOpenRows)}>
                    <AssetIcon position={iconFor(group)} size={34} />
                    <span className="min-w-0 flex-1">
                      <strong>{group.name}</strong>
                      <small>{group.sales.length > 1 ? `${group.sales.length} Verkäufe · zuletzt ` : 'Verkauft am '}{fmtDate(group.sales[0].datetime)}</small>
                    </span>
                    <span className="finance-history__amount">
                      <Money><span style={{ color: gainColor(group.gainEur) }}>{signedEur(group.gainEur)}</span></Money>
                      {group.gainPct != null && <span className={`finance-history__pill ${group.gainEur >= 0 ? 'is-up' : 'is-down'}`}>{signedPct(group.gainPct)}</span>}
                    </span>
                  </button>
                  {expanded && <ul className="finance-history__sales">
                    {group.sales.map((sale) => <li key={sale.id}>
                      <span className="min-w-0 flex-1">
                        <b>{fmtDate(sale.datetime)}</b>
                        <small>{sale.shares.toLocaleString('de-AT', { maximumFractionDigits: 8 })} Anteile · Erlös <Money>{eur(sale.proceedsEur, { decimals: true })}</Money> · Einstand <Money>{eur(sale.costEur, { decimals: true })}</Money></small>
                      </span>
                      <span className="finance-history__amount">
                        <Money><span style={{ color: gainColor(sale.gainEur) }}>{signedEur(sale.gainEur)}</span></Money>
                        {sale.gainPct != null && <small style={{ color: gainColor(sale.gainPct) }}>{signedPct(sale.gainPct)}</small>}
                      </span>
                    </li>)}
                  </ul>}
                </div>;
              })}
            </div>)}
          </div>;
        })}
      </div>
      <p className="finance-footnote">Nach Gebühren und Steuern, Einstand zum Durchschnittspreis.</p>
    </>}
  </section>;
}

function fmtDate(iso: string): string {
  const d = iso.slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]}` : iso;
}
