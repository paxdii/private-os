'use client';
import { useState } from 'react';
import type { AssetClass, Position } from '@/lib/finance/types';
import { CLASS_LABEL, eur, gainColor, money, pct, signedEur, signedPct } from './format';
import { Money } from './Privacy';
import { AssetIcon } from './AssetIcon';
import { ClassIcon } from './ClassIcon';

type View = 'class' | 'value' | 'gain';
const VIEWS: { key: View; label: string }[] = [
  { key: 'class', label: 'Klassen' },
  { key: 'value', label: 'Wert' },
  { key: 'gain', label: 'Performance' },
];
const CLASS_ORDER: AssetClass[] = ['stocks', 'etf', 'crypto', 'metals', 'cash'];

export function PositionsTable({ positions, onSelect }: { positions: Position[]; onSelect: (position: Position) => void }) {
  const [view, setView] = useState<View>('class');
  // An empty settlement account is bookkeeping, not a position.
  const visible = positions.filter((position) => position.cls !== 'cash' || position.valueEur > 0.005);

  if (!visible.length) {
    return <p className="text-secondary text-sm">Noch keine Positionen. Über „Hinzufügen“ eine erste Buchung erfassen.</p>;
  }

  const byValue = [...visible].sort((a, b) => b.valueEur - a.valueEur);
  const groups = view === 'class'
    ? CLASS_ORDER.map((cls) => ({ cls, rows: byValue.filter((position) => position.cls === cls) })).filter((group) => group.rows.length)
    : [{ cls: null, rows: view === 'gain' ? [...visible].sort((a, b) => (b.gainPct ?? -Infinity) - (a.gainPct ?? -Infinity)) : byValue }];

  return (
    <div>
      <div className="finance-seg finance-seg--wide mb-4" role="group" aria-label="Positionen anzeigen">
        {VIEWS.map((item) => (
          <button key={item.key} type="button" onClick={() => setView(item.key)} className={view === item.key ? 'is-active' : ''} aria-pressed={view === item.key}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="finance-groups">
        {groups.map((group) => (
          <div key={group.cls || 'all'} className="finance-group">
            {group.cls && <GroupHead cls={group.cls} rows={group.rows} />}
            <div className="finance-position-list">
              {group.rows.map((position, index) => <Row key={position.assetId || `${position.name}-${index}`} position={position} onSelect={onSelect} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GroupHead({ cls, rows }: { cls: AssetClass; rows: Position[] }) {
  const value = rows.reduce((sum, row) => sum + row.valueEur, 0);
  const share = rows.reduce((sum, row) => sum + (row.allocationPct || 0), 0);
  const cost = rows.reduce((sum, row) => sum + (row.costEur || 0), 0);
  const gain = rows.reduce((sum, row) => sum + (row.gainEur || 0), 0);
  return (
    <div className="finance-group__head">
      <ClassIcon cls={cls} size={15} />
      <span className="finance-group__name">{CLASS_LABEL[cls]}</span>
      <span className="finance-group__count">{rows.length}</span>
      <span className="finance-group__sum">
        {cls !== 'cash' && cost > 0 && <b style={{ color: gainColor(gain) }}>{signedPct(gain / cost)}</b>}
        <Money>{eur(value)}</Money>
        <span className="finance-group__share">{pct(share, 0)}</span>
      </span>
    </div>
  );
}

function Row({ position: p, onSelect }: { position: Position; onSelect: (position: Position) => void }) {
  const cash = p.cls === 'cash';
  return (
    <button type="button" className="finance-position" onClick={() => onSelect(p)} aria-label={`Details zu ${p.name} öffnen`}>
      <AssetIcon position={p} />
      <div className="finance-position__identity">
        <div className="finance-position__name">{p.name}</div>
        <div className="finance-position__meta">
          {cash ? 'Verrechnungskonto' : `${trimShares(p.shares ?? 0)} × ${p.currentPrice != null ? money(p.currentPrice) : '—'}`}
        </div>
      </div>
      <div className="finance-position__value">
        <Money>{eur(p.valueEur, { decimals: true })}</Money>
        {!cash && p.gainPct != null
          ? <small style={{ color: gainColor(p.gainEur) }}><span className="finance-position__gain-eur"><Money>{signedEur(p.gainEur ?? 0)}</Money> · </span>{signedPct(p.gainPct)}</small>
          : <small>{pct(p.allocationPct ?? 0, 1)}</small>}
      </div>
    </button>
  );
}

function trimShares(n: number): string {
  return n.toLocaleString('de-AT', { maximumFractionDigits: n < 10 ? 4 : 2 });
}
