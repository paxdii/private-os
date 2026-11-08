import { NextRequest, NextResponse } from 'next/server';
import { listAssets } from '@/lib/finance/portfolio';
import { COINGECKO_KEY } from '@/lib/finance/config';
import { cryptoYahooSymbol, fxHistory, fxRate } from '@/lib/finance/prices';
import { resolveMarketAsset } from '@/lib/finance/asset-search';
import type { FinanceAsset } from '@/lib/finance/types';
import type { FinancePeriod } from '@/lib/finance/period';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RANGES: Record<FinancePeriod, { yahoo: string; coinDays: number }> = {
  '1W': { yahoo: '5d', coinDays: 7 },
  '1M': { yahoo: '1mo', coinDays: 30 },
  '3M': { yahoo: '3mo', coinDays: 90 },
  '6M': { yahoo: '6mo', coinDays: 180 },
  '1Y': { yahoo: '1y', coinDays: 365 },
  '3Y': { yahoo: '3y', coinDays: 1095 },
  YTD: { yahoo: '1y', coinDays: 365 },
  ALL: { yahoo: 'max', coinDays: 365 },
};

type PricePoint = { date: string; value: number };

function sample(points: PricePoint[], max = 320) {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  return points.filter((_, index) => index % step === 0 || index === points.length - 1);
}

async function yahooSeries(symbol: string, range: string, interval: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, next: { revalidate: 3600 } });
  if (!response.ok) throw new Error(`Kursquelle antwortet mit HTTP ${response.status}`);
  const result = (await response.json())?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp || [];
  const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
  const points = timestamps.flatMap((timestamp, index) => {
    const value = closes[index];
    return typeof value === 'number' && Number.isFinite(value)
      ? [{ date: new Date(timestamp * 1000).toISOString().slice(0, 10), value }]
      : [];
  });
  return { points, currency: String(result?.meta?.currency || 'EUR') };
}

// Converts a series quoted in `from` into `to` with the day's exchange rate
// (last known rate for days the FX market has no close, e.g. crypto weekends).
async function convertSeries(points: PricePoint[], from: string, to: string, range: string, interval: string) {
  if (from === to || !points.length) return points;
  const rates = await fxHistory(from, to, range, interval);
  if (!rates.length) throw new Error(`Kein Wechselkurs ${from}/${to} verfügbar`);
  let index = 0;
  let rate = rates[0][1];
  return points.map((point) => {
    while (index < rates.length && rates[index][0] <= point.date) rate = rates[index++][1];
    return { date: point.date, value: point.value * rate };
  });
}

export async function GET(req: NextRequest) {
  const assetId = req.nextUrl.searchParams.get('assetId');
  const symbol = req.nextUrl.searchParams.get('symbol');
  const period = req.nextUrl.searchParams.get('period') as FinancePeriod;
  const currency = (req.nextUrl.searchParams.get('currency') || 'EUR').toUpperCase();
  if ((!assetId && !symbol) || !Object.hasOwn(RANGES, period) || !['EUR', 'USD'].includes(currency)) {
    return NextResponse.json({ ok: false, error: 'invalid_asset_or_period' }, { status: 400 });
  }
  try {
    const asset: Partial<FinanceAsset> | undefined = assetId
      ? (await listAssets()).find((item) => item.id === assetId)
      : await resolveMarketAsset(symbol!);
    if (!asset) return NextResponse.json({ ok: false, error: 'asset_not_found' }, { status: 404 });

    let points: PricePoint[] = [];
    let nativeCurrency = currency;
    let limited = false;
    let source: string | null = null;
    const range = RANGES[period].yahoo;
    const interval = period === 'ALL' ? '1wk' : '1d';
    const multiplier = asset.quoteMultiplier ?? 1;
    const yahooSymbol = asset.yahooSymbol || asset.metalYahooSymbol;

    if (!yahooSymbol && asset.cls === 'crypto' && asset.symbol) {
      // Yahoo quotes coins directly in either currency — no conversion needed.
      try {
        const series = await yahooSeries(cryptoYahooSymbol(asset.symbol, currency), range, interval);
        points = series.points.map((point) => ({ date: point.date, value: point.value * multiplier }));
        source = 'Yahoo Finance';
      } catch { points = []; }
    }
    if (!points.length && yahooSymbol) {
      const series = await yahooSeries(yahooSymbol, range, interval);
      nativeCurrency = series.currency;
      points = await convertSeries(series.points.map((point) => ({ date: point.date, value: point.value * multiplier })), series.currency, currency, range, interval);
      source = asset.cls === 'metals' ? 'Yahoo Finance · Futures-Richtkurs' : 'Yahoo Finance';
    } else if (!points.length && asset.coinId) {
      const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(asset.coinId)}/market_chart?vs_currency=${currency.toLowerCase()}&days=${RANGES[period].coinDays}`;
      const headers: Record<string, string> = { accept: 'application/json' };
      if (COINGECKO_KEY) headers['x-cg-demo-api-key'] = COINGECKO_KEY;
      const response = await fetch(url, { headers, next: { revalidate: 3600 } });
      if (!response.ok) throw new Error(`Kursquelle antwortet mit HTTP ${response.status}`);
      const prices: [number, number][] = (await response.json())?.prices || [];
      limited = period === 'ALL';
      const daily = new Map<string, number>();
      for (const [timestamp, value] of prices) {
        if (Number.isFinite(value)) daily.set(new Date(timestamp).toISOString().slice(0, 10), value);
      }
      points = [...daily].map(([date, value]) => ({ date, value }));
      source = 'CoinGecko';
    }
    if (period === 'YTD') points = points.filter((point) => point.date >= `${new Date().getUTCFullYear()}-01-01`);
    const averageEntry = asset.shares && asset.shares > 0 && asset.costEur != null
      ? asset.costEur / asset.shares * await fxRate('EUR', currency) : null;
    return NextResponse.json({
      ok: true, points: sample(points), currency, nativeCurrency, limited, source, period, averageEntry,
    }, { headers: { 'Cache-Control': 'private, max-age=900' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'price_history_unavailable' }, { status: 502 });
  }
}
