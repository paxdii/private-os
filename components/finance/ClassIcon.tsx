import type { AssetClass } from '@/lib/finance/types';
import { CLASS_COLOR } from './format';

// Small line icons for the asset classes, drawn in each class's chart colour.
const PATHS: Record<AssetClass, React.ReactNode> = {
  // Rising line chart
  stocks: <><path d="M3 17l5-5 4 3 7-8" /><path d="M15 7h4v4" /></>,
  // Basket of holdings
  etf: <><circle cx="12" cy="12" r="8" /><path d="M12 4v8l6 4.5" /></>,
  // Coin with a hash-like mark
  crypto: <><circle cx="12" cy="12" r="8" /><path d="M10 8.5h3.2a1.8 1.8 0 0 1 0 3.5H10m0 0h3.6a1.8 1.8 0 0 1 0 3.5H10V8.5M11 7v1.5m0 7V17" /></>,
  // Stacked ingots
  metals: <><path d="M4 18l2-4h5l2 4z" /><path d="M11 18l2-4h5l2 4z" /><path d="M7.5 13l2-4h5l2 4z" /></>,
  // Banknote
  cash: <><rect x="3.5" y="7" width="17" height="10" rx="2" /><circle cx="12" cy="12" r="2.2" /></>,
};

export function ClassIcon({ cls, size = 14 }: { cls: AssetClass; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={CLASS_COLOR[cls]} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {PATHS[cls]}
  </svg>;
}
