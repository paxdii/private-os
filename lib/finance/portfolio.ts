// Independent portfolio ledger stored in Supabase. Server-side only.
import {
  db, FIN_ASSETS, FIN_PORTFOLIO_META, FIN_TRANSACTIONS, FIN_VALUE_HISTORY,
} from '@/lib/db';
import type { FinanceAsset, FinanceTransaction, ValuePoint } from './types';

const now = () => Date.now();

export type PortfolioMeta = {
  importedAt?: number;
  importSource?: string;
  returns?: Record<string, number | null>;
  capital?: Record<string, number>;
  valuationReconciledAt?: number;
};

export async function listAssets(): Promise<FinanceAsset[]> {
  const snap = await db().collection(FIN_ASSETS).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<FinanceAsset, 'id'>) }));
}

export async function createAsset(asset: Partial<FinanceAsset>): Promise<string> {
  const ref = await db().collection(FIN_ASSETS).add(normalizeAsset(asset));
  return ref.id;
}

export async function updateAsset(id: string, patch: Partial<FinanceAsset>) {
  const allowed = [
    'name', 'cls', 'identifier', 'isin', 'symbol', 'yahooSymbol', 'metalYahooSymbol', 'coinId',
    'currency', 'active', 'importedDummy', 'shares', 'costEur', 'realizedEur', 'quoteMultiplier',
    'importedPriceEur', 'importedValueEur', 'openingBalanceEur', 'openingBalanceDate',
  ];
  const clean = Object.fromEntries(Object.entries(patch).filter(([key, value]) => allowed.includes(key) && value !== undefined));
  await db().collection(FIN_ASSETS).doc(id).set({ ...clean, updatedAt: now() }, { merge: true });
}

export async function deleteAsset(id: string) {
  await db().collection(FIN_ASSETS).doc(id).delete();
}

export async function listTransactions(): Promise<FinanceTransaction[]> {
  const snap = await db().collection(FIN_TRANSACTIONS).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<FinanceTransaction, 'id'>) }))
    .sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
}

export async function createTransaction(tx: Partial<FinanceTransaction>): Promise<string> {
  const ref = await db().collection(FIN_TRANSACTIONS).add(normalizeTransaction(tx));
  return ref.id;
}

export async function updateTransaction(id: string, patch: Partial<FinanceTransaction>) {
  const allowed = ['assetId', 'type', 'datetime', 'name', 'identifier', 'shares', 'price', 'amount', 'amountNet', 'currency', 'tax', 'fee', 'realizedGainNet', 'note', 'priceOriginal', 'amountOriginal', 'feeOriginal', 'taxOriginal', 'fxRate'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([key, value]) => allowed.includes(key) && value !== undefined));
  await db().collection(FIN_TRANSACTIONS).doc(id).set({ ...clean, updatedAt: now() }, { merge: true });
}

export async function deleteTransaction(id: string) {
  await db().collection(FIN_TRANSACTIONS).doc(id).delete();
}

export async function recalculateAssetFromLedger(assetId: string) {
  const [asset] = (await listAssets()).filter((item) => item.id === assetId);
  if (!asset) return;
  const rows = (await listTransactions())
    .filter((tx) => tx.assetId === assetId)
    .sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''));
  if (asset.cls === 'cash') {
    await updateAsset(assetId, { shares: calculateCashBalance(asset, rows), active: true });
    return;
  }
  let shares = 0;
  let cost = 0;
  let realized = 0;
  for (const tx of rows) {
    const quantity = Math.abs(Number(tx.shares) || 0);
    if (tx.type === 'buy' || tx.type === 'transfer_in') {
      shares += quantity;
      if (tx.type === 'buy') cost += Math.abs(Number(tx.amount) || 0) + Math.abs(Number(tx.fee) || 0) + Math.abs(Number(tx.tax) || 0);
    } else if (tx.type === 'sell' || tx.type === 'transfer_out') {
      const removed = Math.min(shares, quantity);
      const averageCost = shares > 0 ? cost / shares : 0;
      shares = Math.max(0, shares - quantity);
      cost = Math.max(0, cost - averageCost * removed);
      // Sales booked here get their gain at average cost; imported ones keep theirs.
      if (tx.type === 'sell' && tx.realizedGainNet == null && removed > 0) {
        const fees = Math.abs(Number(tx.fee) || 0) + Math.abs(Number(tx.tax) || 0);
        tx.realizedGainNet = Math.abs(Number(tx.amount) || 0) - fees - averageCost * removed;
        await updateTransaction(tx.id, { realizedGainNet: tx.realizedGainNet });
      }
    }
    realized += Number(tx.realizedGainNet) || 0;
  }
  await updateAsset(assetId, { shares, costEur: cost, realizedEur: realized, active: shares > 1e-10 && !asset.importedDummy });
}

export function calculateCashBalance(
  asset: Pick<FinanceAsset, 'openingBalanceEur' | 'openingBalanceDate'>,
  rows: Pick<FinanceTransaction, 'type' | 'datetime' | 'amount'>[],
): number {
  // The opening balance already includes every movement before migration.
  // Work in cents so repeated deposits and withdrawals cannot drift.
  let cents = Math.round((Number(asset.openingBalanceEur) || 0) * 100);
  for (const tx of rows) {
    if (asset.openingBalanceDate && tx.datetime.slice(0, 10) <= asset.openingBalanceDate) continue;
    const amount = Math.round(Math.abs(Number(tx.amount) || 0) * 100);
    if (tx.type === 'deposit') cents += amount;
    if (tx.type === 'withdrawal') cents -= amount;
  }
  return cents / 100;
}

export async function listValueHistory(): Promise<ValuePoint[]> {
  const snap = await db().collection(FIN_VALUE_HISTORY).get();
  return snap.docs
    .map((d) => ({ date: d.id, ...(d.data() as Omit<ValuePoint, 'date'>) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function saveValuePoint(point: ValuePoint) {
  await db().collection(FIN_VALUE_HISTORY).doc(point.date).set({
    value: Number(point.value) || 0,
    invested: point.invested == null ? null : Number(point.invested) || 0,
    updatedAt: now(),
  }, { merge: true });
}

export async function getPortfolioMeta(): Promise<PortfolioMeta | null> {
  const snap = await db().collection(FIN_PORTFOLIO_META).doc('current').get();
  return snap.exists ? (snap.data() as PortfolioMeta) : null;
}

function normalizeAsset(asset: Partial<FinanceAsset>) {
  return {
    name: asset.name || 'Unbekannt',
    cls: asset.cls || 'stocks',
    identifier: asset.identifier || asset.isin || asset.symbol || '',
    isin: asset.isin || null,
    symbol: asset.symbol || null,
    yahooSymbol: asset.yahooSymbol || null,
    metalYahooSymbol: asset.metalYahooSymbol || null,
    quoteMultiplier: asset.quoteMultiplier == null ? 1 : Number(asset.quoteMultiplier),
    coinId: asset.coinId || null,
    currency: asset.currency || 'EUR',
    active: asset.active !== false,
    importedDummy: !!asset.importedDummy,
    shares: Number(asset.shares) || 0,
    costEur: Number(asset.costEur) || 0,
    realizedEur: Number(asset.realizedEur) || 0,
    importedPriceEur: asset.importedPriceEur == null ? null : Number(asset.importedPriceEur),
    importedValueEur: asset.importedValueEur == null ? null : Number(asset.importedValueEur),
    openingBalanceEur: asset.openingBalanceEur == null ? null : Number(asset.openingBalanceEur),
    openingBalanceDate: asset.openingBalanceDate || null,
    createdAt: now(), updatedAt: now(),
  };
}

function normalizeTransaction(tx: Partial<FinanceTransaction>) {
  return {
    assetId: tx.assetId || null,
    type: tx.type || 'buy',
    datetime: tx.datetime || new Date().toISOString(),
    name: tx.name || null,
    identifier: tx.identifier || null,
    shares: tx.shares == null ? null : Number(tx.shares),
    price: tx.price == null ? null : Number(tx.price),
    amount: Number(tx.amount) || 0,
    amountNet: tx.amountNet == null ? null : Number(tx.amountNet),
    currency: tx.currency || 'EUR',
    tax: tx.tax == null ? null : Number(tx.tax),
    fee: tx.fee == null ? null : Number(tx.fee),
    realizedGainNet: tx.realizedGainNet == null ? null : Number(tx.realizedGainNet),
    note: tx.note || null,
    ...(tx.fxRate != null && {
      priceOriginal: tx.priceOriginal == null ? null : Number(tx.priceOriginal),
      amountOriginal: tx.amountOriginal == null ? null : Number(tx.amountOriginal),
      feeOriginal: tx.feeOriginal == null ? null : Number(tx.feeOriginal),
      taxOriginal: tx.taxOriginal == null ? null : Number(tx.taxOriginal),
      fxRate: Number(tx.fxRate),
    }),
    createdAt: now(), updatedAt: now(),
  };
}
