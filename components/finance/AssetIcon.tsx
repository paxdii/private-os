'use client';
import { useState } from 'react';
import type { Position } from '@/lib/finance/types';

// Known issuer sites for positions no logo service covers by ticker.
const DOMAINS: Record<string, string> = {};

// Candidate logos in order of quality; the component walks the list on error
// and ends at the initials.
function logoCandidates(position: Position): string[] {
  const out: string[] = [];
  const symbol = (position.symbol || '').trim();
  // A known issuer's own favicon is designed for small sizes; it goes first.
  const domain = DOMAINS[position.identifier || ''] || DOMAINS[position.coinId || ''];
  if (domain && position.cls !== 'crypto') out.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`);
  if (position.cls === 'crypto' && symbol) {
    const s = symbol.toLowerCase();
    out.push(`https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/${s}.svg`);
    if (domain) out.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`);
    out.push(`https://assets.coincap.io/assets/icons/${s}@2x.png`);
  }
  if ((position.cls === 'stocks' || position.cls === 'etf') && symbol && !/^[A-Z]{2}[A-Z0-9]{9}\d/.test(symbol)) {
    out.push(`https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`);
  }
  return out;
}

export function AssetIcon({ position, size = 40 }: { position: Position; size?: number }) {
  const [attempt, setAttempt] = useState(0);
  const style = { width: size, height: size };

  if (position.cls === 'metals') return <MetalCoin position={position} size={size} />;
  if (position.cls === 'cash') return <span className="finance-asset-icon" style={style} aria-hidden><span>€</span></span>;

  if (position.cls === 'crypto' && (position.symbol || '').toUpperCase() === 'SOL') return <SolanaMark size={size} />;
  const src = logoCandidates(position)[attempt];
  const initials = (position.symbol || position.name).replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase();
  return (
    <span className={`finance-asset-icon${src ? ' finance-asset-icon--logo' : ''}`} style={style} aria-hidden>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={src} src={src} width={size} height={size} alt="" loading="lazy" onError={() => setAttempt((n) => n + 1)} />
      ) : <span>{initials || '•'}</span>}
    </span>
  );
}

// Coins get a drawn icon instead of a logo: gold in amber, platinum in slate.
function MetalCoin({ position, size }: { position: Position; size: number }) {
  const key = `${position.name} ${position.symbol || ''} ${position.identifier || ''}`.toLowerCase();
  const tone = /platin|platinum|silber|silver/.test(key) ? 'slate' : 'amber';
  const [light, dark] = tone === 'amber' ? ['#f3c874', '#b87d22'] : ['#d5dde8', '#7d93b0'];
  const id = `coin-${tone}`;
  return (
    <span className="finance-asset-icon" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 32 32" width="70%" height="70%">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={light} />
            <stop offset="1" stopColor={dark} />
          </linearGradient>
        </defs>
        <circle cx="16" cy="16" r="14" fill={`url(#${id})`} />
        <circle cx="16" cy="16" r="10.5" fill="none" stroke="rgba(0,0,0,.22)" strokeWidth="1.2" />
        <text x="16" y="20.2" textAnchor="middle" fontSize="11" fontWeight="700" fill="rgba(0,0,0,.45)" fontFamily="system-ui, sans-serif">
          {tone === 'amber' ? 'Au' : 'Pt'}
        </text>
      </svg>
    </span>
  );
}

// The generic icon sets still ship Solana's old flat green; this is the current
// mark with its purple-to-teal gradient.
function SolanaMark({ size }: { size: number }) {
  return (
    <span className="finance-asset-icon finance-asset-icon--logo" style={{ width: size, height: size, background: '#14151f' }} aria-hidden>
      <svg viewBox="0 0 32 32" width="62%" height="62%">
        <defs>
          <linearGradient id="solana-mark" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#9945ff" />
            <stop offset=".55" stopColor="#5f8bfa" />
            <stop offset="1" stopColor="#19fb9b" />
          </linearGradient>
        </defs>
        <path fill="url(#solana-mark)" d="M9.6 6h18.4l-4.4 4.6H5.2zM5.2 13.7h18.4l4.4 4.6H9.6zM9.6 21.4h18.4L23.6 26H5.2z" />
      </svg>
    </span>
  );
}
