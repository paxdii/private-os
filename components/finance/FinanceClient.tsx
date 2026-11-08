'use client';
import { useEffect, useMemo, useState } from 'react';
import { appToday } from '@/lib/date';
import { useCachedFetch, bustCache } from '@/lib/fetchCache';
import { selectPeriod, type FinancePeriod } from '@/lib/finance/period';
import type { FinanceAsset, FinanceSummary, Position } from '@/lib/finance/types';
import { DEMO_SUMMARY } from '@/lib/finance/demoData';
import { PrivacyProvider, PrivacyToggle } from './Privacy';
import { PortfolioHero } from './PortfolioHero';
import { ValueChart } from './ValueChart';
import { PositionsTable } from './PositionsTable';
import { LedgerModal } from './Modals';
import { PositionDetail } from './PositionDetail';
import { PeriodSummary } from './PeriodSummary';
import { ReturnsPanel } from './ReturnsPanel';
import { ActivityExplorer } from './ActivityExplorer';
import { PerformanceAnalysis } from './PerformanceAnalysis';
import { AlertBanner } from './PriceAlerts';
import { RealizedHistory } from './RealizedHistory';

type SummaryResp = { ok: boolean } & FinanceSummary;
type AssetsResp = { ok: boolean; assets: FinanceAsset[] };

export function FinanceClient() {
  const [demo, setDemo] = useState(false);
  const [period, setPeriod] = useState<FinancePeriod>('1Y');
  const [showEntry, setShowEntry] = useState(false);
  const [entryAssetId, setEntryAssetId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Position | null>(null);
  useEffect(() => { setDemo(new URLSearchParams(window.location.search).get('demo') === '1'); }, []);

  const summaryQ = useCachedFetch<SummaryResp>(demo ? null : '/api/finance/summary', 60_000);
  const assetsQ = useCachedFetch<AssetsResp>(demo ? null : '/api/finance/assets', 60_000);
  const raw = demo ? DEMO_SUMMARY : summaryQ.data;
  const summary = useMemo<FinanceSummary | undefined>(() => raw ? {
    ...raw,
    allocation: raw.allocation ?? [],
    positions: raw.positions ?? [],
    activities: raw.activities ?? [],
    valueSeries: raw.valueSeries ?? [],
    returns: raw.returns ?? null,
  } : undefined, [raw]);
  const today = appToday();
  const view = useMemo(
    () => summary ? selectPeriod(summary.valueSeries, summary.activities, period, today, summary.valuationReconciled ? null : summary.historyCutoverDate) : null,
    [summary, period, today],
  );
  const assets = assetsQ.data?.assets || [];

  function refresh() {
    bustCache('/api/finance/summary');
    bustCache('/api/finance/assets');
    void summaryQ.refresh();
    void assetsQ.refresh();
    setShowEntry(false);
    setEntryAssetId(null);
  }

  return (
    <PrivacyProvider>
      <main className="finance-shell max-w-[1440px] mx-auto px-4 md:px-8 pt-8 pb-12">
        <header className="finance-page-head">
          <h1 className="h1">Finanzen</h1>
          <div className="control-row">
            <PrivacyToggle />
            {!demo && <button className="btn-primary text-sm" onClick={() => { setEntryAssetId(null); setShowEntry(true); }}>+ Hinzufügen</button>}
          </div>
        </header>

        {!demo && <AlertBanner />}
        {demo && <p className="text-muted text-xs mb-4">Demo-Ansicht mit Beispieldaten.</p>}
        {!demo && summaryQ.loading && !summary && <div className="finance-panel h-64 animate-pulse" />}
        {!demo && summaryQ.error && !summary && <div className="notice notice--error"><p className="text-red text-sm">{summaryQ.error.message}</p></div>}
        {!demo && summary && !summary.portfolioReady && <p className="text-secondary text-sm mb-4">Noch kein Portfolio angelegt. Über „Hinzufügen“ die erste Buchung erfassen.</p>}

        {summary && view && (
          <div className="finance-stack">
            <PortfolioHero summary={summary} view={view} period={period} onPeriod={setPeriod} />

            <div className="finance-workspace">
              <div className="finance-workspace__main">
                <section className="finance-panel">
                  <div className="finance-panel-head"><h2>Positionen</h2><span className="finance-count">{summary.positions.filter((p) => p.cls !== 'cash' || p.valueEur > 0.005).length}</span></div>
                  <PositionsTable positions={summary.positions} onSelect={setSelected} />
                  {!demo && !!summary.unresolvedHoldings?.length && (
                    <p className="finance-footnote">Ohne aktuellen Kurs und nicht im Gesamtwert: {summary.unresolvedHoldings.map((item) => item.name).join(', ')}.</p>
                  )}
                </section>

                <section className="finance-panel finance-panel--chart">
                  <div className="finance-panel-head"><h2>Wertentwicklung</h2></div>
                  <div className="h-[16rem] md:h-[21rem]">
                    <ValueChart
                      series={view.series}
                      cutoverDate={view.crossesCutover ? summary.historyCutoverDate : null}
                      hideInvested={!!summary.valuationReconciled && !!summary.historyCutoverDate && view.from < summary.historyCutoverDate && view.to >= summary.historyCutoverDate}
                    />
                  </div>
                </section>

                <PerformanceAnalysis series={view.series} activities={view.activities} cutoverDate={summary.historyCutoverDate} />
              </div>

              <aside className="finance-workspace__rail">
                <PeriodSummary view={view} />
                <section className="finance-panel">
                  <div className="finance-panel-head"><h2>Rendite gesamt</h2></div>
                  <ReturnsPanel returns={summary.returns} capital={summary.capital} />
                </section>
                <ActivityExplorer activities={view.activities} />
              </aside>
            </div>

            <RealizedHistory activities={summary.activities} assets={assets} />
          </div>
        )}

        {showEntry && <LedgerModal assets={assets} initialAssetId={entryAssetId} onClose={() => { setShowEntry(false); setEntryAssetId(null); }} onSaved={refresh} />}
        {selected && <PositionDetail
          key={`${selected.assetId || selected.name}-${period}`}
          position={selected} period={period} activities={summary?.activities || []} assets={assets}
          onClose={() => setSelected(null)}
          onAdd={selected.cls === 'cash' && selected.assetId ? () => { setEntryAssetId(selected.assetId!); setSelected(null); setShowEntry(true); } : undefined}
        />}
      </main>
    </PrivacyProvider>
  );
}
