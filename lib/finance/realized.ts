// Realized gains per sale, grouped by position — the "Verlauf" of closed trades.
import type { FinanceActivity } from './types';

export type RealizedSale = {
  id: string;
  key: string;           // position key (assetId, else identifier or name)
  assetId?: string;
  name: string;
  identifier?: string;
  datetime: string;
  shares: number;
  proceedsEur: number;   // net of fees and taxes
  costEur: number;       // average cost of the sold shares
  gainEur: number;
  gainPct: number | null; // 0..1, null without a cost basis
};

export type RealizedGroup = {
  key: string;
  assetId?: string;
  name: string;
  identifier?: string;
  sales: RealizedSale[];
  sharesSold: number;
  proceedsEur: number;
  gainEur: number;
  gainPct: number | null;
  lastSale: string;
  closed: boolean;       // no shares left after the last sale
};

// Replays the ledger per position with average cost, the same method the
// asset recalculation uses. A gain stored on the sale itself (imported from
// Parqet) wins over the replay, since older buys may be missing there.
export function realizedHistory(activities: FinanceActivity[]): RealizedGroup[] {
  const byKey = new Map<string, FinanceActivity[]>();
  for (const a of activities) {
    if (!['buy', 'sell', 'transfer_in', 'transfer_out'].includes(a.type)) continue;
    const key = a.assetId || a.identifier || a.name || '';
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) || []), a]);
  }

  const groups: RealizedGroup[] = [];
  for (const [key, rows] of byKey) {
    rows.sort((a, b) => a.datetime.localeCompare(b.datetime));
    let shares = 0;
    let cost = 0;
    const sales: RealizedSale[] = [];
    for (const tx of rows) {
      const qty = Math.abs(Number(tx.shares) || 0);
      const fees = Math.abs(Number(tx.fee) || 0) + Math.abs(Number(tx.tax) || 0);
      if (tx.type === 'buy' || tx.type === 'transfer_in') {
        shares += qty;
        if (tx.type === 'buy') cost += Math.abs(tx.amount) + fees;
        continue;
      }
      const removed = Math.min(shares, qty);
      const avg = shares > 0 ? cost / shares : 0;
      const soldCost = avg * removed;
      shares = Math.max(0, shares - qty);
      cost = Math.max(0, cost - soldCost);
      if (tx.type !== 'sell') continue;
      const proceeds = Math.abs(tx.amount) - fees;
      const gain = tx.realizedGainNet != null ? tx.realizedGainNet : proceeds - soldCost;
      const basis = proceeds - gain;
      sales.push({
        id: tx.id, key, assetId: tx.assetId, name: rows[rows.length - 1].name || tx.name || key, identifier: tx.identifier, datetime: tx.datetime, shares: qty, proceedsEur: proceeds, costEur: basis, gainEur: gain,
        gainPct: basis > 0.005 ? gain / basis : null,
      });
    }
    if (!sales.length) continue;
    const last = rows[rows.length - 1];
    const proceedsEur = sales.reduce((s, x) => s + x.proceedsEur, 0);
    const gainEur = sales.reduce((s, x) => s + x.gainEur, 0);
    const basis = proceedsEur - gainEur;
    sales.reverse();
    groups.push({
      key, assetId: last.assetId, name: last.name || key, identifier: last.identifier,
      sales, sharesSold: sales.reduce((s, x) => s + x.shares, 0), proceedsEur, gainEur,
      gainPct: basis > 0.005 ? gainEur / basis : null,
      lastSale: sales[0].datetime, closed: shares <= 1e-10,
    });
  }
  return groups.sort((a, b) => b.lastSale.localeCompare(a.lastSale));
}

/** Every sale with its gain, newest first. */
export function realizedSales(activities: FinanceActivity[]): RealizedSale[] {
  return realizedHistory(activities).flatMap((group) => group.sales.map((sale) => ({ ...sale, name: group.name })))
    .sort((a, b) => b.datetime.localeCompare(a.datetime));
}

export type SaleBucket = { id: string; label: string; year: number; sales: RealizedSale[] };

/**
 * Sales of the current year split into recent periods (this week, last week,
 * this month …); earlier years get one bucket each. `today` is YYYY-MM-DD.
 */
export function bucketSales(sales: RealizedSale[], today: string): SaleBucket[] {
  const day = (iso: string) => iso.slice(0, 10);
  const t = new Date(`${today}T12:00:00Z`);
  const year = t.getUTCFullYear();
  const shift = (days: number) => { const d = new Date(t); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const weekStart = shift(-((t.getUTCDay() + 6) % 7));
  const lastWeekStart = shift(-((t.getUTCDay() + 6) % 7) - 7);
  const month = t.getUTCMonth();
  const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const lastMonthStart = month === 0 ? `${year}-01-01` : `${year}-${String(month).padStart(2, '0')}-01`;
  const quarterStart = `${year}-${String(Math.floor(month / 3) * 3 + 1).padStart(2, '0')}-01`;
  const recent: [string, string, string][] = [
    ['week', 'Diese Woche', weekStart],
    ['last-week', 'Letzte Woche', lastWeekStart],
    ['month', 'Diesen Monat', monthStart],
    ['last-month', 'Letzten Monat', lastMonthStart],
    ['quarter', 'Dieses Quartal', quarterStart],
    ['year', `Früher in ${year}`, `${year}-01-01`],
  ];
  const buckets = new Map<string, SaleBucket>();
  for (const sale of sales) {
    const d = day(sale.datetime);
    const saleYear = Number(d.slice(0, 4));
    let id = String(saleYear);
    let label = String(saleYear);
    if (saleYear === year) {
      const hit = recent.find(([, , from]) => d >= from) || recent[recent.length - 1];
      [id, label] = hit;
    }
    if (!buckets.has(id)) buckets.set(id, { id, label, year: saleYear, sales: [] });
    buckets.get(id)!.sales.push(sale);
  }
  const order = (b: SaleBucket) => b.year === year ? recent.findIndex(([id]) => id === b.id) : 100 + (year - b.year);
  return [...buckets.values()].sort((a, b) => order(a) - order(b));
}
