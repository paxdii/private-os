'use client';
import { useEffect, useRef, useState } from 'react';
import type { ImportRow } from '@/lib/finance/import';
import { money } from './format';
import { Money } from './Privacy';

const TYPE_LABEL: Record<ImportRow['type'], string> = { buy: 'Kauf', sell: 'Verkauf', transfer_in: 'Einbuchung', transfer_out: 'Ausbuchung' };

async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}

// Upload a broker PDF/CSV, review what was recognised, then book the selected rows.
export function ImportForm({ onSaved, onActive }: { onSaved: () => void; onActive?: (active: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'reading' | 'saving' | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = !!rows?.length || busy === 'reading';
  useEffect(() => { onActive?.(active); }, [active, onActive]);

  function reset() { setRows(null); setFileName(''); setError(null); }

  async function read(file: File) {
    setFileName(file.name); setRows(null); setError(null); setBusy('reading');
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch('/api/finance/import', { method: 'POST', body });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.ok === false) throw new Error(json.error || `HTTP ${response.status}`);
      const found: ImportRow[] = json.rows || [];
      setRows(found);
      setPicked(new Set(found.filter((row) => !row.duplicate && !row.problem).map((row) => row.key)));
      if (!found.length) setError('In der Datei wurden keine Käufe, Verkäufe oder Transfers gefunden.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(null); }
  }

  async function save() {
    if (!rows) return;
    setBusy('saving'); setError(null);
    const created = new Map<string, string>();
    let saved = 0;
    try {
      for (const row of rows.filter((item) => picked.has(item.key))) {
        let assetId = row.assetId;
        if (!assetId && row.newAsset) {
          assetId = created.get(row.newAsset.yahooSymbol);
          if (!assetId) {
            const asset = await post('/api/finance/assets', { ...row.newAsset, active: false });
            assetId = String(asset.id);
            created.set(row.newAsset.yahooSymbol, assetId);
          }
        }
        if (!assetId) continue;
        await post('/api/finance/transactions', {
          assetId, type: row.type, datetime: row.datetime, name: row.assetName || row.newAsset?.name || row.name,
          identifier: row.isin || row.newAsset?.identifier || row.symbol, shares: row.shares, price: row.price,
          amount: row.amount, fee: row.fee, tax: row.tax, currency: row.currency,
        });
        saved++;
      }
      onSaved();
    } catch (caught) {
      setError(`${saved ? `${saved} gespeichert, dann Fehler: ` : ''}${caught instanceof Error ? caught.message : String(caught)}`);
    } finally { setBusy(null); }
  }

  function toggle(key: string) {
    setPicked((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  const count = rows?.filter((row) => picked.has(row.key)).length || 0;

  return <div className="space-y-3">
    <label
      className={`finance-dropzone${dragging ? ' is-dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files?.[0]; if (file) void read(file); }}
    >
      <input ref={input} type="file" accept=".pdf,.csv,application/pdf,text/csv" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void read(file); event.target.value = ''; }} />
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 15V4m0 0-4 4m4-4 4 4" /><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
      <strong>{busy === 'reading' ? 'Wird gelesen…' : rows?.length ? fileName : 'Abrechnung hierher ziehen'}</strong>
      <span>{busy === 'reading' ? fileName : rows?.length ? 'Andere Datei wählen' : 'PDF oder CSV vom Broker oder der Börse. Käufe werden automatisch erkannt.'}</span>
    </label>

    {rows && !!rows.length && <>
      <p className="text-secondary text-xs">{rows.length} {rows.length === 1 ? 'Buchung' : 'Buchungen'} erkannt. Bitte prüfen, dann speichern.</p>
      <ul className="finance-import-list">
        {rows.map((row) => {
          const disabled = !!row.problem;
          return <li key={row.key} className={disabled ? 'is-disabled' : ''}>
            <input type="checkbox" aria-label={`${row.name} übernehmen`} checked={picked.has(row.key)} disabled={disabled} onChange={() => toggle(row.key)} />
            <div className="min-w-0 flex-1">
              <strong>{row.assetName || row.name}</strong>
              <span>{TYPE_LABEL[row.type]} · {fmtDate(row.datetime)} · {row.shares.toLocaleString('de-AT', { maximumFractionDigits: 8 })} × {money(row.price, row.currency)}</span>
              {row.problem ? <small className="text-red">{row.problem}</small>
                : row.duplicate ? <small className="is-warn">Sieht aus wie eine schon erfasste Buchung.</small>
                : row.newAsset ? <small>Neue Position, Kurs über {row.newAsset.yahooSymbol}</small>
                : null}
            </div>
            <div className="finance-import-amount">
              <Money>{money(row.amount, row.currency)}</Money>
              {!!(row.fee || row.tax) && <small>Kosten {money(row.fee + row.tax, row.currency)}</small>}
            </div>
          </li>;
        })}
      </ul>
    </>}

    {error && <p className="text-red text-xs">{error}</p>}
    {rows && !!rows.length && <button type="button" className="btn-ghost text-xs" onClick={reset}>Zurück zur manuellen Buchung</button>}
    {rows && !!rows.length && <button className="btn btn-primary w-full" onClick={save} disabled={!count || !!busy}>
      {busy === 'saving' ? 'Speichern…' : count === 1 ? '1 Buchung speichern' : `${count} Buchungen speichern`}
    </button>}
  </div>;
}

function fmtDate(iso: string): string {
  const d = iso.slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]}` : iso;
}
