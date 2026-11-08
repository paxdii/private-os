// Shared trade helpers for the booking dialog, the file import and the agent
// API: one asset search over the ledger and Yahoo, the price on a given day,
// and booking a trade (creating the asset when it is new). Server-side only.
import { searchMarketAssets } from './asset-search';
import { createAsset, createTransaction, listAssets, recalculateAssetFromLedger } from './portfolio';
import { cryptoYahooSymbol, fxRateOn } from './prices';
import type { ActivityType, AssetClass, FinanceAsset, FinanceTransaction } from './types';

export type AssetSuggestion =
  | { kind: 'existing'; assetId: string; name: string; cls: AssetClass; symbol?: string; identifier: string; held: boolean; shares: number; coinId?: string }
  | { kind: 'market'; name: string; cls: 'stocks' | 'etf' | 'crypto'; symbol: string; yahooSymbol: string; exchange?: string };

const norm = (value?: string | null) => (value || '').trim().toUpperCase();
const cryptoBase = (symbol: string) => norm(symbol).replace(/-(EUR|USD|USDT|USDC|GBP)$/, '');
// "NVIDIA Corporation" and "NVIDIA" are the same company for matching purposes.
const companyKey = (name: string) => name.toLowerCase()
  .replace(/[.,'()]/g, ' ')
  .replace(/\b(inc|corp|corporation|co|company|ag|se|sa|nv|plc|ltd|limited|holdings?|group|class [abc]|'?[abc]'?)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** Yahoo symbol a ledger asset is quoted under (same rule as the net-worth valuation). */
export function quoteSymbol(asset: Pick<FinanceAsset, 'cls' | 'symbol' | 'yahooSymbol' | 'metalYahooSymbol'>): string | undefined {
  return asset.yahooSymbol || asset.metalYahooSymbol || (asset.cls === 'crypto' && asset.symbol ? cryptoYahooSymbol(asset.symbol) : undefined);
}

/** Quote symbol of a ledger asset, looked up on Yahoo by ISIN or name when the asset has none stored. */
export async function resolveQuoteSymbol(asset: FinanceAsset): Promise<string | undefined> {
  const stored = quoteSymbol(asset);
  if (stored) return stored;
  if (asset.cls !== 'stocks' && asset.cls !== 'etf') return undefined;
  for (const query of [asset.isin, asset.name].filter(Boolean) as string[]) {
    try {
      const hit = (await searchMarketAssets(query)).find((item) => item.cls !== 'crypto');
      if (hit) return hit.yahooSymbol;
    } catch { /* next */ }
  }
  return undefined;
}

/** Ledger assets first (held before former), then Yahoo listings not already in the ledger. */
export async function suggestAssets(query: string, assets?: FinanceAsset[]): Promise<AssetSuggestion[]> {
  const q = query.trim().toLocaleLowerCase('de-AT');
  const ledger = (assets || await listAssets()).filter((asset) => !asset.importedDummy);
  const existing: AssetSuggestion[] = ledger
    .filter((asset) => !q || `${asset.name} ${asset.identifier} ${asset.symbol || ''} ${asset.isin || ''} ${asset.yahooSymbol || ''}`.toLocaleLowerCase('de-AT').includes(q))
    .filter((asset) => q || asset.active)
    .map((asset) => ({
      kind: 'existing' as const, assetId: asset.id, name: asset.name, cls: asset.cls, symbol: asset.symbol, identifier: asset.identifier,
      held: asset.active && (asset.cls === 'cash' || asset.shares > 1e-10), shares: asset.shares, coinId: asset.coinId,
    }))
    .sort((a, b) => Number(b.held) - Number(a.held) || a.name.localeCompare(b.name, 'de-AT'));
  if (q.length < 2) return existing.slice(0, 12);

  let market: AssetSuggestion[] = [];
  try {
    const known = new Set(ledger.flatMap((asset) => [norm(asset.yahooSymbol), norm(asset.isin), norm(asset.identifier),
      asset.cls === 'crypto' ? cryptoBase(asset.symbol || asset.identifier) : norm(asset.symbol)].filter(Boolean)));
    const knownNames = new Set(ledger.filter((asset) => asset.cls === 'stocks' || asset.cls === 'etf').map((asset) => companyKey(asset.name)));
    const seenCoins = new Set<string>();
    const seenNames = new Set<string>();
    market = (await searchMarketAssets(query.trim())).flatMap((item): AssetSuggestion[] => {
      if (item.cls === 'crypto') {
        const base = cryptoBase(item.symbol);
        if (known.has(base) || seenCoins.has(base)) return [];
        seenCoins.add(base);
        // Coins are booked in EUR; Yahoo lists the EUR pair for every major coin.
        return [{ kind: 'market', name: item.name.replace(/\s+(USD|EUR)$/i, ''), cls: 'crypto', symbol: base, yahooSymbol: cryptoYahooSymbol(base), exchange: item.exchange }];
      }
      const key = companyKey(item.name);
      // Already held under a name match, or another listing of a company already offered.
      if (known.has(norm(item.yahooSymbol)) || knownNames.has(key) || seenNames.has(key)) return [];
      seenNames.add(key);
      return [{ kind: 'market', name: item.name, cls: item.cls, symbol: item.symbol, yahooSymbol: item.yahooSymbol, exchange: item.exchange }];
    });
  } catch { /* Yahoo down: ledger matches still help */ }
  return [...existing.slice(0, 8), ...market.slice(0, 8)];
}

/** Last close on or before `date` (YYYY-MM-DD) in the listing's own currency. */
export async function closeOn(symbol: string, date: string): Promise<{ price: number; currency: string; date: string }> {
  const day = Math.floor(Date.parse(`${date}T23:59:59Z`) / 1000);
  const today = new Date().toISOString().slice(0, 10);
  const url = date >= today
    ? `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`
    : `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${day - 10 * 86400}&period2=${day}&interval=1d`;
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Kein Kurs für ${symbol} (HTTP ${res.status}).`);
  const result = (await res.json())?.chart?.result?.[0];
  const currency = String(result?.meta?.currency || 'EUR');
  if (date >= today && Number.isFinite(Number(result?.meta?.regularMarketPrice))) {
    return { price: Number(result.meta.regularMarketPrice), currency, date: today };
  }
  const timestamps: number[] = result?.timestamp || [];
  const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
  let found: { price: number; date: string } | null = null;
  timestamps.forEach((timestamp, index) => {
    const value = closes[index];
    const on = new Date(timestamp * 1000).toISOString().slice(0, 10);
    if (typeof value === 'number' && Number.isFinite(value) && on <= date) found = { price: value, date: on };
  });
  if (!found) throw new Error(`Kein Kurs für ${symbol} am ${date}.`);
  return { ...(found as { price: number; date: string }), currency };
}

/** Price on a day, converted into the booking currency. GBp (pence) quotes are scaled to pounds first. */
export async function priceOn(symbol: string, date: string, currency: 'EUR' | 'USD'): Promise<{ price: number; currency: string; date: string; source: string }> {
  const close = await closeOn(symbol, date);
  let price = close.price;
  let from = close.currency;
  if (from === 'GBp' || from === 'GBX') { price /= 100; from = 'GBP'; }
  const rate = from === currency ? 1 : await fxRateOn(from.toUpperCase(), currency, date);
  return { price: price * rate, currency, date: close.date, source: symbol };
}

// ─── Booking ───────────────────────────────────────────────
export type TradeInput = {
  assetId?: string;
  newAsset?: { name: string; cls: 'stocks' | 'etf' | 'crypto'; symbol: string; yahooSymbol: string; isin?: string; currency?: string };
  type: Extract<ActivityType, 'buy' | 'sell' | 'transfer_in' | 'transfer_out' | 'dividend'>;
  datetime: string;
  shares?: number;
  price?: number;
  amount?: number;
  fee?: number;
  tax?: number;
  currency?: 'EUR' | 'USD';
  note?: string;
};

/** The ledger computes in EUR; a USD trade keeps what was typed and is converted at that day's rate. */
export async function toEur(tx: Partial<FinanceTransaction>): Promise<Partial<FinanceTransaction>> {
  const currency = String(tx.currency || 'EUR').toUpperCase();
  if (currency === 'EUR') return { ...tx, currency: 'EUR' };
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('invalid_currency');
  const rate = await fxRateOn(currency, 'EUR', String(tx.datetime).slice(0, 10));
  const convert = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? undefined : Number(value) * rate;
  return {
    ...tx, currency, fxRate: rate,
    priceOriginal: tx.price, amountOriginal: tx.amount, feeOriginal: tx.fee, taxOriginal: tx.tax,
    price: convert(tx.price), amount: convert(tx.amount) ?? 0, fee: convert(tx.fee), tax: convert(tx.tax),
  };
}

export async function bookTrade(input: TradeInput): Promise<{ transactionId: string; assetId: string; asset: FinanceAsset; createdAsset: boolean; price: number; amount: number }> {
  const assets = await listAssets();
  let asset = input.assetId ? assets.find((item) => item.id === input.assetId) : undefined;
  if (input.assetId && !asset) throw new Error('asset_not_found');
  let createdAsset = false;
  if (!asset) {
    const fresh = input.newAsset;
    if (!fresh) throw new Error('asset_required');
    // Booking the same coin or listing twice must not create a second asset.
    asset = assets.find((item) => !item.importedDummy && (norm(item.yahooSymbol) === norm(fresh.yahooSymbol)
      || (fresh.isin && norm(item.isin) === norm(fresh.isin))
      || (fresh.cls === 'crypto' && item.cls === 'crypto' && cryptoBase(item.symbol || item.identifier) === cryptoBase(fresh.symbol))));
    if (!asset) {
      const id = await createAsset({
        name: fresh.name, cls: fresh.cls, identifier: fresh.isin || fresh.symbol, isin: fresh.isin, symbol: fresh.symbol,
        yahooSymbol: fresh.yahooSymbol, currency: fresh.currency || (fresh.cls === 'crypto' ? 'EUR' : undefined), active: false,
      });
      asset = { id, name: fresh.name, cls: fresh.cls, identifier: fresh.isin || fresh.symbol, symbol: fresh.symbol, yahooSymbol: fresh.yahooSymbol, active: false, shares: 0, costEur: 0, realizedEur: 0 };
      createdAsset = true;
    }
  }
  if (asset.cls === 'cash') throw new Error('cash_asset_not_supported');

  const currency = input.currency === 'USD' ? 'USD' : 'EUR';
  const shares = input.shares != null ? Math.abs(Number(input.shares)) : undefined;
  let price = input.price != null ? Math.abs(Number(input.price)) : undefined;
  let amount = input.amount != null ? Math.abs(Number(input.amount)) : undefined;
  if (input.type !== 'dividend') {
    if (!(shares! > 0)) throw new Error('positive_shares_required');
    if (price == null && amount != null) price = amount / shares!;
    if (price == null) {
      const symbol = await resolveQuoteSymbol(asset);
      if (!symbol) throw new Error('price_required');
      price = (await priceOn(symbol, input.datetime.slice(0, 10), currency)).price;
    }
    if (amount == null) amount = shares! * price;
  }
  if (!(amount! > 0) && (input.type === 'buy' || input.type === 'sell' || input.type === 'dividend')) throw new Error('positive_amount_required');

  const transactionId = await createTransaction(await toEur({
    assetId: asset.id, type: input.type, datetime: new Date(input.datetime).toISOString(), name: asset.name, identifier: asset.identifier,
    shares, price, amount: amount ?? 0, fee: Math.abs(Number(input.fee) || 0), tax: Math.abs(Number(input.tax) || 0), currency,
    ...(input.note ? { note: input.note } : {}),
  }));
  await recalculateAssetFromLedger(asset.id);
  const updated = (await listAssets()).find((item) => item.id === asset!.id) || asset;
  return { transactionId, assetId: asset.id, asset: updated, createdAsset, price: price ?? 0, amount: amount ?? 0 };
}
