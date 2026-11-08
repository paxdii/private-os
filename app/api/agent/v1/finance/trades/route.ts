import { agentWriteRoute } from '@/lib/agent/handler';
import { AgentError } from '@/lib/agent/envelope';
import { oneOf, optionalBoolean, optionalNumber, optionalString, rejectUnknown } from '@/lib/agent/write/body';
import { resolveMarketAsset } from '@/lib/finance/asset-search';
import { listAssets, listTransactions } from '@/lib/finance/portfolio';
import { cryptoYahooSymbol } from '@/lib/finance/prices';
import { bookTrade, type TradeInput } from '@/lib/finance/trade';
import { APP_TIMEZONE } from '@/lib/date';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES = ['buy', 'sell', 'dividend'] as const;
const ERRORS: Record<string, string> = {
  asset_not_found: 'asset_id nicht gefunden. Erst finance_search_assets aufrufen.',
  positive_shares_required: '"shares" muss größer als 0 sein.',
  positive_amount_required: 'Betrag fehlt: "amount" angeben (bei Dividenden Pflicht).',
  price_required: 'Für dieses Asset gibt es keinen Marktkurs. "price" oder "amount" angeben.',
  cash_asset_not_supported: 'Konten (Cash) werden hier nicht gebucht.',
};

// Books one trade into the finance ledger. Price defaults to the market close on
// the trade date; a new listing (symbol from finance_search_assets) is created.
export const POST = agentWriteRoute(async ({ body, warn }) => {
  rejectUnknown(body, ['asset_id', 'symbol', 'type', 'date', 'time', 'shares', 'price', 'amount', 'fee', 'tax', 'currency', 'note', 'allow_duplicate']);
  const type = oneOf(body, 'type', TYPES)!;
  const assetId = optionalString(body, 'asset_id');
  const symbol = optionalString(body, 'symbol', { max: 40 })?.toUpperCase();
  if (!assetId === !symbol) throw new AgentError('invalid_param', 'Genau eines von "asset_id" (Depot) oder "symbol" (neuer Börsen-Treffer) angeben.');
  const date = optionalString(body, 'date') || new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AgentError('invalid_param', '"date" muss YYYY-MM-DD sein.');
  const time = optionalString(body, 'time') || '12:00';
  if (!/^\d{2}:\d{2}$/.test(time)) throw new AgentError('invalid_param', '"time" muss HH:MM sein (Europe/Vienna).');
  const datetime = viennaToIso(date, time);
  if (Date.parse(datetime) > Date.now() + 5 * 60_000) throw new AgentError('invalid_param', 'Buchungen in der Zukunft sind nicht möglich.');
  const currency = oneOf(body, 'currency', ['EUR', 'USD'] as const, false) ?? 'EUR';
  const shares = optionalNumber(body, 'shares', { min: 0 });
  const input: TradeInput = {
    type, datetime, currency, shares,
    price: optionalNumber(body, 'price', { min: 0 }), amount: optionalNumber(body, 'amount', { min: 0 }),
    fee: optionalNumber(body, 'fee', { min: 0 }), tax: optionalNumber(body, 'tax', { min: 0 }),
    note: optionalString(body, 'note', { max: 300 }),
  };

  const assets = await listAssets();
  if (assetId) input.assetId = assetId;
  else {
    const crypto = symbol!.match(/^([A-Z0-9]{2,10})-(EUR|USD)$/);
    const held = assets.find((asset) => !asset.importedDummy && ((asset.yahooSymbol || '').toUpperCase() === symbol
      || (crypto && asset.cls === 'crypto' && (asset.symbol || '').toUpperCase() === crypto[1])));
    if (held) input.assetId = held.id;
    else if (crypto) input.newAsset = { name: crypto[1], cls: 'crypto', symbol: crypto[1], yahooSymbol: cryptoYahooSymbol(crypto[1]), currency: 'EUR' };
    else {
      const listing = await resolveMarketAsset(symbol!).catch(() => null);
      if (!listing) throw new AgentError('asset_not_found', `"${symbol}" nicht gefunden. Symbol aus finance_search_assets übernehmen.`, 404);
      input.newAsset = listing.cls === 'crypto'
        ? { name: listing.name, cls: 'crypto', symbol: listing.symbol.split('-')[0], yahooSymbol: cryptoYahooSymbol(listing.symbol.split('-')[0]), currency: 'EUR' }
        : { name: listing.name, cls: listing.cls, symbol: listing.symbol, yahooSymbol: listing.yahooSymbol, currency };
    }
  }
  if (!input.assetId && type !== 'buy') throw new AgentError('invalid_param', 'Ein neues Asset beginnt mit einem Kauf.');
  if (input.assetId && type === 'sell') {
    const asset = assets.find((item) => item.id === input.assetId);
    if (asset && shares != null && shares > asset.shares + 1e-9) throw new AgentError('insufficient_shares', `Im Depot sind nur ${asset.shares} Anteile.`, 400);
  }
  // A retried tool call must not book the same trade twice.
  if (input.assetId && !optionalBoolean(body, 'allow_duplicate')) {
    const twin = (await listTransactions()).find((tx) => tx.assetId === input.assetId && tx.type === type
      && tx.datetime.slice(0, 10) === datetime.slice(0, 10) && shares != null && Math.abs((Number(tx.shares) || 0) - shares) < 1e-8);
    if (twin) throw new AgentError('duplicate_trade', `Diese Buchung existiert schon (id ${twin.id}). Mit allow_duplicate=true trotzdem buchen.`, 409);
  }

  try {
    const result = await bookTrade(input);
    if (input.price == null && input.amount == null && type !== 'dividend') warn.add('market_price', 'Preis aus dem Schlusskurs am Handelstag übernommen.');
    return {
      created: true, transaction_id: result.transactionId, asset_id: result.assetId, asset_created: result.createdAsset,
      asset: { name: result.asset.name, shares: result.asset.shares, cost_eur: Math.round(result.asset.costEur * 100) / 100 },
      booked: { type, datetime, shares: shares ?? null, price: result.price, amount: result.amount, currency },
      summary: `${type === 'buy' ? 'Kauf' : type === 'sell' ? 'Verkauf' : 'Dividende'} ${result.asset.name} gebucht.`,
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (ERRORS[code]) throw new AgentError(code, ERRORS[code], 400);
    throw error;
  }
});

// Wall-clock time in Vienna → UTC ISO, using the zone's offset on that day.
function viennaToIso(date: string, time: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone: APP_TIMEZONE }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (local.getTime() - utc.getTime())).toISOString();
}
