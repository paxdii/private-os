import { NextRequest, NextResponse } from 'next/server';
import { suggestAssets } from '@/lib/finance/trade';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One list for the booking dialog: assets already in the ledger, then Yahoo
// listings that are not, so a new stock or coin can be added in one step.
export async function GET(req: NextRequest) {
  const query = (req.nextUrl.searchParams.get('q') || '').trim();
  if (query.length > 100) return NextResponse.json({ ok: false, error: 'query_too_long' }, { status: 400 });
  try { return NextResponse.json({ ok: true, results: await suggestAssets(query) }); }
  catch (error) { return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
