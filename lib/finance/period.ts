import type { FinanceActivity, ValuePoint } from './types';

export type FinancePeriod = '1W' | '1M' | '3M' | '6M' | '1Y' | '3Y' | 'YTD' | 'ALL';
export const FINANCE_PERIODS: { key: FinancePeriod; label: string }[] = [
  { key: '1W', label: '1W' },
  { key: '1M', label: '1M' },
  { key: '3M', label: '3M' },
  { key: '6M', label: '6M' },
  { key: '1Y', label: '1J' },
  { key: '3Y', label: '3J' },
  { key: 'YTD', label: 'YTD' },
  { key: 'ALL', label: 'Gesamt' },
];

export type PeriodView = {
  series: ValuePoint[];
  activities: FinanceActivity[];
  from: string;
  to: string;
  openingValue: number;
  closingValue: number;
  contributions: number;
  withdrawals: number;
  income: number;
  charges: number;
  netGain: number;
  returnPct: number | null;
  available: boolean;
  crossesCutover: boolean;
};

export function periodStart(period: FinancePeriod, today: string): string | null {
  if (period === 'ALL') return null;
  const date = new Date(`${today}T12:00:00Z`);
  if (period === 'YTD') return `${today.slice(0, 4)}-01-01`;
  if (period === '1W') date.setUTCDate(date.getUTCDate() - 7);
  if (period === '1M') shiftMonths(date, -1);
  if (period === '3M') shiftMonths(date, -3);
  if (period === '6M') shiftMonths(date, -6);
  if (period === '1Y') shiftMonths(date, -12);
  if (period === '3Y') shiftMonths(date, -36);
  return date.toISOString().slice(0, 10);
}

function shiftMonths(date: Date, months: number) {
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
}

export function selectPeriod(
  values: ValuePoint[],
  activities: FinanceActivity[],
  period: FinancePeriod,
  today: string,
  cutoverDate?: string | null,
): PeriodView {
  const points = [...values].filter((point) => Number.isFinite(point.value)).sort((a, b) => a.date.localeCompare(b.date));
  const requested = periodStart(period, today);
  const baseline = requested
    ? [...points].reverse().find((point) => point.date <= requested) || points[0]
    : points[0];
  const available = !!baseline;
  const series = baseline ? points.filter((point) => point.date >= baseline.date && point.date <= today) : [];
  const first = series[0];
  const last = series.at(-1);
  const from = first?.date ?? requested ?? today;
  const relevant = activities.filter((activity) => activity.datetime?.slice(0, 10) > from && activity.datetime.slice(0, 10) <= today);

  const totals = sumFlows(relevant);
  const { contributions, withdrawals, income, charges } = totals;
  const cutoverIndex = cutoverDate ? series.findIndex((point) => point.date >= cutoverDate) : -1;
  const crossesCutover = cutoverIndex > 0;
  let cutoverGain = 0;
  if (crossesCutover) {
    const before = series[cutoverIndex - 1];
    const after = series[cutoverIndex];
    const transition = sumFlows(relevant.filter((activity) =>
      activity.datetime.slice(0, 10) > before.date && activity.datetime.slice(0, 10) <= after.date));
    cutoverGain = after.value - before.value
      - transition.contributions + transition.withdrawals + transition.income - transition.charges;
  }
  const openingValue = first?.value ?? 0;
  const closingValue = last?.value ?? 0;
  // The first own snapshot and the imported history use different valuation
  // bases. Their transition is omitted from gain instead of shown as a trade loss.
  const netGain = closingValue - openingValue - contributions + withdrawals + income - charges - cutoverGain;
  const capitalAtWork = openingValue + contributions;
  return {
    series, activities: relevant, from, to: last?.date ?? today,
    openingValue, closingValue, contributions, withdrawals, income, charges,
    netGain, returnPct: available && capitalAtWork > 0 ? netGain / capitalAtWork : null,
    available, crossesCutover,
  };
}

function sumFlows(activities: FinanceActivity[]) {
  let contributions = 0;
  let withdrawals = 0;
  let income = 0;
  let charges = 0;
  for (const activity of activities) {
    const amount = Math.abs(activity.amount || 0);
    if (activity.type === 'buy' || activity.type === 'deposit' || activity.type === 'transfer_in') contributions += amount;
    if (activity.type === 'sell' || activity.type === 'withdrawal' || activity.type === 'transfer_out') withdrawals += amount;
    if (activity.type === 'dividend' || activity.type === 'interest') income += amount;
    charges += Math.abs(activity.fee || 0) + Math.abs(activity.tax || 0);
    if (activity.type === 'fees_taxes') charges += amount;
  }
  return { contributions, withdrawals, income, charges };
}
