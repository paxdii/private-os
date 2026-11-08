import { NextRequest, NextResponse } from 'next/server';
import { IMPORT_MAX_BYTES, prepareImport, readTrades } from '@/lib/finance/import';
import { listAssets, listTransactions } from '@/lib/finance/portfolio';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Reads a broker PDF/CSV and returns the trades it found as a preview. Saving
// happens through the normal asset/transaction routes once the user confirms.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: 'Keine Datei erhalten.' }, { status: 400 });
    if (file.size > IMPORT_MAX_BYTES) return NextResponse.json({ ok: false, error: 'Die Datei ist größer als 4 MB.' }, { status: 413 });
    if (!/\.(pdf|csv|txt)$/i.test(file.name) && !['application/pdf', 'text/csv', 'text/plain'].includes(file.type)) {
      return NextResponse.json({ ok: false, error: 'Nur PDF- oder CSV-Dateien.' }, { status: 415 });
    }
    const { trades, via } = await readTrades({ name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
    const [assets, ledger] = await Promise.all([listAssets(), listTransactions()]);
    const rows = await prepareImport(trades, assets, ledger);
    rows.sort((a, b) => a.datetime.localeCompare(b.datetime));
    return NextResponse.json({ ok: true, rows, via });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
