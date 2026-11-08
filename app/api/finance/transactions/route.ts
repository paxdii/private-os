import { NextRequest, NextResponse } from 'next/server';
import {
  calculateCashBalance, createTransaction, deleteTransaction, listAssets, listTransactions, recalculateAssetFromLedger, updateTransaction,
} from '@/lib/finance/portfolio';
import { toEur } from '@/lib/finance/trade';
import type { ActivityType, FinanceAsset, FinanceTransaction } from '@/lib/finance/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const TYPES = new Set<ActivityType>(['buy', 'sell', 'dividend', 'interest', 'transfer_in', 'transfer_out', 'fees_taxes', 'deposit', 'withdrawal']);

export async function GET(req: NextRequest) {
  try {
    const limit = Math.min(1000, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 100));
    return NextResponse.json({ ok: true, transactions: (await listTransactions()).slice(0, limit) });
  } catch (error: any) { return NextResponse.json({ ok: false, error: error?.message || String(error) }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const asset = (await listAssets()).find((item) => item.id === body.assetId);
    if (!asset) {
      return NextResponse.json({ ok: false, error: 'valid_asset_required' }, { status: 400 });
    }
    if (!TYPES.has(body.type)) return NextResponse.json({ ok: false, error: 'invalid_transaction_type' }, { status: 400 });
    if (!body.datetime || !Number.isFinite(Date.parse(body.datetime))) return NextResponse.json({ ok: false, error: 'valid_datetime_required' }, { status: 400 });
    if (!Number.isFinite(Number(body.amount))) return NextResponse.json({ ok: false, error: 'valid_amount_required' }, { status: 400 });
    if ((body.type === 'buy' || body.type === 'sell') && !(Number(body.shares) > 0)) {
      return NextResponse.json({ ok: false, error: 'positive_shares_required' }, { status: 400 });
    }
    if (asset.cls === 'cash') {
      const error = cashMovementError(asset, body);
      if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
      const rows = (await listTransactions()).filter((tx) => tx.assetId === asset.id);
      if (calculateCashBalance(asset, [...rows, body]) < 0) return NextResponse.json({ ok: false, error: 'insufficient_cash_balance' }, { status: 400 });
    }
    const id = await createTransaction(await toEur(body));
    if (body.assetId) await recalculateAssetFromLedger(body.assetId);
    return NextResponse.json({ ok: true, id });
  } catch (error: any) { return NextResponse.json({ ok: false, error: error?.message || String(error) }, { status: 500 }); }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, ...patch } = await req.json();
    if (!id) return NextResponse.json({ ok: false, error: 'id_required' }, { status: 400 });
    if (patch.type && !TYPES.has(patch.type)) return NextResponse.json({ ok: false, error: 'invalid_transaction_type' }, { status: 400 });
    const rows = await listTransactions();
    const before = rows.find((tx) => tx.id === id);
    if (!before) return NextResponse.json({ ok: false, error: 'transaction_not_found' }, { status: 404 });
    const after = { ...before, ...patch };
    const assets = await listAssets();
    const target = assets.find((asset) => asset.id === after.assetId);
    if (!target) return NextResponse.json({ ok: false, error: 'valid_asset_required' }, { status: 400 });
    if (target.cls === 'cash') {
      const cashError = cashMovementError(target, after);
      if (cashError) return NextResponse.json({ ok: false, error: cashError }, { status: 400 });
    }
    const error = validateAffectedCash(assets, rows.filter((tx) => tx.id !== id).concat(after), new Set([before.assetId, after.assetId].filter(Boolean)));
    if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
    await updateTransaction(id, patch);
    const affected = new Set([before?.assetId, patch.assetId].filter(Boolean));
    for (const assetId of affected) await recalculateAssetFromLedger(String(assetId));
    return NextResponse.json({ ok: true });
  } catch (error: any) { return NextResponse.json({ ok: false, error: error?.message || String(error) }, { status: 500 }); }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ ok: false, error: 'id_required' }, { status: 400 });
    const rows = await listTransactions();
    const before = rows.find((tx) => tx.id === id);
    if (!before) return NextResponse.json({ ok: false, error: 'transaction_not_found' }, { status: 404 });
    const error = validateAffectedCash(await listAssets(), rows.filter((tx) => tx.id !== id), new Set([before.assetId].filter(Boolean)));
    if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
    await deleteTransaction(id);
    if (before?.assetId) await recalculateAssetFromLedger(before.assetId);
    return NextResponse.json({ ok: true });
  } catch (error: any) { return NextResponse.json({ ok: false, error: error?.message || String(error) }, { status: 500 }); }
}

function cashMovementError(asset: FinanceAsset, tx: Pick<FinanceTransaction, 'type' | 'datetime' | 'amount' | 'fee' | 'tax'>): string | null {
  if (tx.type !== 'deposit' && tx.type !== 'withdrawal') return 'cash_movement_required';
  if (!tx.datetime || !Number.isFinite(Date.parse(tx.datetime)) || (asset.openingBalanceDate && tx.datetime.slice(0, 10) <= asset.openingBalanceDate)) return 'cash_movement_after_opening_required';
  if (!(Number(tx.amount) > 0) || !Number.isFinite(Number(tx.amount))) return 'positive_amount_required';
  if (Number(tx.fee || 0) !== 0 || Number(tx.tax || 0) !== 0) return 'cash_fees_not_supported';
  return null;
}

function validateAffectedCash(assets: FinanceAsset[], rows: FinanceTransaction[], ids: Set<string | undefined>): string | null {
  for (const id of ids) {
    const asset = assets.find((item) => item.id === id);
    if (asset?.cls !== 'cash') continue;
    const movements = rows.filter((tx) => tx.assetId === id);
    if (calculateCashBalance(asset, movements) < 0) return 'insufficient_cash_balance';
  }
  return null;
}
