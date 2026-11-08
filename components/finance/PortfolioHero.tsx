'use client';
import type { FinanceSummary } from '@/lib/finance/types';
import type { FinancePeriod, PeriodView } from '@/lib/finance/period';
import { CLASS_COLOR, eur, gainColor, pct, signedEur, signedPct } from './format';
import { Money } from './Privacy';
import { PeriodSelector } from './PeriodSelector';
import { ClassIcon } from './ClassIcon';

const PERIOD_TEXT: Record<FinancePeriod, string> = {
  '1W': 'in 1 Woche', '1M': 'in 1 Monat', '3M': 'in 3 Monaten', '6M': 'in 6 Monaten',
  '1Y': 'in 1 Jahr', YTD: 'seit Jahresbeginn', ALL: 'gesamt',
};

export function PortfolioHero({ summary, view, period, onPeriod }: {
  summary: FinanceSummary; view: PeriodView; period: FinancePeriod; onPeriod: (period: FinancePeriod) => void;
}) {
  const slices = summary.allocation.filter((slice) => slice.valueEur > 0);
  const asOf = summary.pricesAsOf ? new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' }).format(new Date(summary.pricesAsOf)) : null;

  return (
    <section className="finance-hero">
      <div className="finance-hero__top">
        <div className="min-w-0">
          <div className="label">Portfoliowert</div>
          <Money strong className="finance-net-worth">{eur(summary.netWorthEur)}</Money>
          <div className="finance-hero__deltas">
            {summary.dayChangePct != null && (
              <span className="finance-delta" style={{ color: gainColor(summary.dayChangePct) }}>
                {signedPct(summary.dayChangePct, 2)} <span>heute</span>
              </span>
            )}
            {view.available && (
              <span className="finance-delta">
                <Money><b style={{ color: gainColor(view.netGain) }}>{signedEur(view.netGain)}</b></Money>
                {view.returnPct != null && <b style={{ color: gainColor(view.netGain) }}>{signedPct(view.returnPct)}</b>}
                <span>{PERIOD_TEXT[period]}</span>
              </span>
            )}
          </div>
        </div>
        <PeriodSelector value={period} onChange={onPeriod} />
      </div>

      {!!slices.length && (
        <div className="finance-alloc" aria-label="Aufteilung nach Anlageklasse">
          <div className="finance-alloc__bar" aria-hidden>
            {slices.map((slice) => (
              <span key={slice.cls} style={{ width: `${Math.max(slice.pct * 100, 0.8)}%`, background: CLASS_COLOR[slice.cls] }} />
            ))}
          </div>
          <ul className="finance-alloc__legend">
            {slices.map((slice) => (
              <li key={slice.cls}>
                <ClassIcon cls={slice.cls} />
                <span>{slice.label}</span>
                <b>{pct(slice.pct, 0)}</b>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="finance-hero__foot">
        {view.available ? `${formatDate(view.from)} – ${formatDate(view.to)}` : 'Keine Werte in diesem Zeitraum'}
        {asOf && <> · Kurse {summary.stale ? 'teilweise vom' : 'von'} {asOf} Uhr</>}
      </p>
    </section>
  );
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat('de-AT', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
}
