import { NextRequest, NextResponse } from 'next/server';
import { listAssets } from '@/lib/finance/portfolio';
import { priceOn, resolveQuoteSymbol } from '@/lib/finance/trade';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYMBOL = /^[A-Za-z0-9.^=_-]{1,40}$/;

// Price of one unit on a given day, for pre-filling the booking form.
// Takes either a ledger asset (assetId) or a Yahoo symbol of a new asset.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const date = params.get('date') || new Date().toISOString().slice(0, 10);
  const currency = params.get('currency') === 'USD' ? 'USD' : 'EUR';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ ok: false, error: 'invalid_date' }, { status: 400 });
  try {
    let symbol = params.get('symbol') || '';
    let multiplier = 1;
    const assetId = params.get('assetId');
    if (assetId) {
      const asset = (await listAssets()).find((item) => item.id === assetId);
      if (!asset) return NextResponse.json({ ok: false, error: 'asset_not_found' }, { status: 404 });
      symbol = (await resolveQuoteSymbol(asset)) || '';
      multiplier = Number(asset.quoteMultiplier) || 1;
    }
    if (!SYMBOL.test(symbol)) return NextResponse.json({ ok: false, error: 'no_quote_symbol' }, { status: 404 });
    const quote = await priceOn(symbol, date, currency);
    return NextResponse.json({ ok: true, ...quote, price: quote.price * multiplier });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
