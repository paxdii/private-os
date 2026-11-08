// Reads trades out of a broker PDF or CSV (trade confirmations, account
// statements, exchange exports). Known formats are parsed locally; only an
// unrecognised file goes to Gemini, and only when a key is configured. Asset
// matching, duplicate check and Yahoo lookup happen here, so no model ever sees
// the ledger. Server-side only.
import { z } from 'zod';
import { parseCsv, parseTradeConfirmation } from './import-parsers';
import { AI_ENABLED, AI_MODEL, GEMINI_KEY } from './config';
import { searchMarketAssets } from './asset-search';
import { cryptoYahooSymbol } from './prices';
import type { FinanceAsset, FinanceTransaction } from './types';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const IMPORT_MAX_BYTES = 4 * 1024 * 1024; // stays under Vercel's 4.5 MB body limit

const Trade = z.object({
  type: z.enum(['buy', 'sell', 'transfer_in', 'transfer_out']),
  datetime: z.string(),
  name: z.string().min(1),
  isin: z.string().nullish(),
  symbol: z.string().nullish(),
  cls: z.enum(['stocks', 'etf', 'crypto']),
  shares: z.coerce.number().positive(),
  price: z.coerce.number().nullish(),
  amount: z.coerce.number().nullish(),
  fee: z.coerce.number().nullish(),
  tax: z.coerce.number().nullish(),
  currency: z.string().nullish(),
});
type Trade = z.infer<typeof Trade>;
export type RawTrade = Trade;

export type ImportRow = {
  key: string;
  type: Trade['type'];
  datetime: string;          // ISO
  name: string;
  isin?: string;
  symbol?: string;
  cls: Trade['cls'];
  shares: number;
  price: number;
  amount: number;
  fee: number;
  tax: number;
  currency: 'EUR' | 'USD';
  assetId?: string;          // matched existing asset
  assetName?: string;
  newAsset?: { name: string; cls: Trade['cls']; identifier: string; isin?: string; symbol: string; yahooSymbol: string; currency: string };
  duplicate: boolean;        // looks like a booking that is already in the ledger
  problem?: string;          // why it cannot be saved as is
};

const PROMPT = [
  'Du liest Wertpapier- und Krypto-Abrechnungen (Kaufbestätigungen, Depot- oder Kontoauszüge, CSV-Exporte von Brokern und Börsen).',
  'Extrahiere JEDE ausgeführte Transaktion mit Wertpapieren oder Kryptowährungen: Käufe, Verkäufe, Ein- und Ausbuchungen (Transfers).',
  'Ignoriere reine Geldbewegungen (Einzahlung, Auszahlung, Zinsen, Dividenden), Gebührenzusammenfassungen und offene oder stornierte Orders.',
  'Wenn eine Order in mehreren Tabellen (Übersicht und Ausführungsdetails) steht, gib sie nur EINMAL aus und nimm die genauere Stückzahl.',
  'Felder je Transaktion:',
  '- type: "buy" | "sell" | "transfer_in" | "transfer_out"',
  '- datetime: Ausführungszeitpunkt als ISO 8601 (YYYY-MM-DDTHH:mm:ssZ); ohne Uhrzeit 12:00:00Z. Nicht das Valuta-/Settlement-Datum.',
  '- name: Name des Wertpapiers bzw. der Kryptowährung',
  '- isin: ISIN falls angegeben, sonst null',
  '- symbol: Ticker bzw. Krypto-Kürzel (z. B. "SPYL", "SOL"), sonst null',
  '- cls: "stocks" (Aktie, Zertifikat, Optionsschein) | "etf" (ETF/ETP/Fonds) | "crypto"',
  '- shares: Stückzahl als positive Zahl mit voller Genauigkeit',
  '- price: Preis je Stück in der Handelswährung',
  '- amount: Gesamtbetrag OHNE Gebühren und Steuern, positive Zahl',
  '- fee: Gebühren/Provision (0 wenn keine)',
  '- tax: einbehaltene Steuern (0 wenn keine)',
  '- currency: ISO-Code der Beträge, z. B. "EUR" oder "USD"',
  'Zahlen als JSON-Zahlen mit Punkt als Dezimaltrennzeichen. Erfinde nichts; fehlt ein Wert, setze null.',
  'Antworte ausschließlich als JSON-Objekt {"trades":[...]}. Keine Transaktionen gefunden: {"trades":[]}.',
].join('\n');

export async function readTrades(file: { name: string; type: string; bytes: Buffer }): Promise<{ trades: Trade[]; via: 'local' | 'ai' }> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const local = isPdf ? parseTradeConfirmation(await pdfText(file.bytes)) : parseCsv(file.bytes.toString('utf8'));
  const valid = local.flatMap((item) => { const r = Trade.safeParse(item); return r.success ? [r.data] : []; });
  if (valid.length) return { trades: valid, via: 'local' };
  if (!AI_ENABLED) throw new Error('Format nicht erkannt. Unterstützt sind Kaufbestätigungen mit „Order details“ (PDF) und CSV-Exporte mit Spalten für Datum, Art und Stückzahl.');
  return { trades: await readWithAi(file, isPdf), via: 'ai' };
}

async function pdfText(bytes: Buffer): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
    return text;
  } catch { return ''; }
}

async function readWithAi(file: { name: string; bytes: Buffer }, isPdf: boolean): Promise<Trade[]> {
  const part = isPdf
    ? { inline_data: { mime_type: 'application/pdf', data: file.bytes.toString('base64') } }
    : { text: `Datei ${file.name}:\n${file.bytes.toString('utf8').slice(0, 400_000)}` };
  const response = await fetch(`${GEMINI_BASE}/${AI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: PROMPT }] },
      contents: [{ role: 'user', parts: [part] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 16384 },
    }),
  });
  if (response.status === 402 || response.status === 429) throw new Error('Format nicht lokal erkannt, und die KI-Erkennung ist gerade nicht verfügbar (Gemini-Kontingent aufgebraucht).');
  if (!response.ok) throw new Error(`Die Datei konnte nicht gelesen werden (Gemini ${response.status}).`);
  const json = await response.json();
  const text: string = (json?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p?.text || '').join('');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let parsed: unknown;
  try { parsed = JSON.parse((fenced ? fenced[1] : text).trim()); } catch { throw new Error('Die Antwort beim Auslesen war unvollständig. Bitte erneut versuchen.'); }
  const list = Array.isArray((parsed as { trades?: unknown })?.trades) ? (parsed as { trades: unknown[] }).trades : [];
  return list.flatMap((item) => {
    const result = Trade.safeParse(item);
    return result.success && Number.isFinite(Date.parse(result.data.datetime)) ? [result.data] : [];
  });
}

const norm = (value?: string | null) => (value || '').trim().toUpperCase();

export async function prepareImport(trades: Trade[], assets: FinanceAsset[], ledger: FinanceTransaction[]): Promise<ImportRow[]> {
  const lookups = new Map<string, Promise<ImportRow['newAsset'] | undefined>>();
  return Promise.all(trades.map(async (trade, index) => {
    const currency = norm(trade.currency) === 'USD' ? 'USD' : 'EUR';
    const shares = Math.abs(trade.shares);
    const price = Math.abs(Number(trade.price) || 0);
    const amount = Math.abs(Number(trade.amount) || 0) || shares * price;
    const row: ImportRow = {
      key: `${index}`, type: trade.type, datetime: new Date(trade.datetime).toISOString(), name: trade.name.trim(),
      isin: norm(trade.isin) || undefined, symbol: norm(trade.symbol) || undefined, cls: trade.cls,
      shares, price: price || (shares ? amount / shares : 0), amount,
      fee: Math.abs(Number(trade.fee) || 0), tax: Math.abs(Number(trade.tax) || 0), currency, duplicate: false,
    };
    if (norm(trade.currency) && !['EUR', 'USD'].includes(norm(trade.currency))) row.problem = `Währung ${norm(trade.currency)} wird nicht unterstützt.`;
    if ((row.type === 'buy' || row.type === 'sell') && !(row.amount > 0)) row.problem = 'Kein Betrag erkannt.';

    const asset = matchAsset(row, assets);
    if (asset) {
      row.assetId = asset.id;
      row.assetName = asset.name;
      row.duplicate = ledger.some((tx) => tx.assetId === asset.id && tx.type === row.type
        && Math.abs(Date.parse(tx.datetime) - Date.parse(row.datetime)) < 36 * 3600_000
        && Math.abs((Number(tx.shares) || 0) - row.shares) <= Math.max(1e-6, row.shares * 1e-4));
    } else {
      const lookupKey = row.isin || row.symbol || row.name;
      if (!lookups.has(lookupKey)) lookups.set(lookupKey, findNewAsset(row));
      row.newAsset = await lookups.get(lookupKey);
      if (!row.newAsset) row.problem ??= 'Kein Kurs-Symbol gefunden. Bitte manuell anlegen.';
    }
    if (!row.assetId && (row.type === 'sell' || row.type === 'transfer_out')) row.problem ??= 'Diese Position ist nicht im Depot.';
    return row;
  }));
}

function matchAsset(row: ImportRow, assets: FinanceAsset[]): FinanceAsset | undefined {
  const pool = assets.filter((asset) => asset.cls !== 'cash' && !asset.importedDummy);
  const ids = (asset: FinanceAsset) => [asset.isin, asset.identifier, asset.symbol, asset.yahooSymbol?.split(/[.-]/)[0]].map(norm).filter(Boolean);
  const byIsin = row.isin && pool.filter((asset) => ids(asset).includes(row.isin!));
  const bySymbol = row.symbol && pool.filter((asset) => ids(asset).includes(row.symbol!) && (row.cls === 'crypto') === (asset.cls === 'crypto'));
  const byName = pool.filter((asset) => asset.name.trim().toLowerCase() === row.name.toLowerCase());
  const hit = (byIsin && byIsin.length ? byIsin : bySymbol && bySymbol.length ? bySymbol : byName);
  // Prefer the position that is still held when an asset exists twice.
  return [...hit].sort((a, b) => Number(b.active) - Number(a.active))[0];
}

async function findNewAsset(row: ImportRow): Promise<ImportRow['newAsset'] | undefined> {
  if (row.cls === 'crypto') {
    if (!row.symbol) return undefined;
    return { name: row.name, cls: 'crypto', identifier: row.symbol, symbol: row.symbol, yahooSymbol: cryptoYahooSymbol(row.symbol), currency: 'EUR' };
  }
  for (const query of [row.isin, row.symbol, row.name].filter(Boolean) as string[]) {
    try {
      const found = (await searchMarketAssets(query)).filter((item) => item.cls !== 'crypto');
      // A plain ticker search can hit an unrelated US listing; only trust it on an exact match.
      const pick = query === row.isin ? found[0] : found.find((item) => norm(item.symbol.split('.')[0]) === norm(query)) || (query === row.name ? found[0] : undefined);
      if (pick) {
        return {
          name: row.name, cls: pick.cls === 'etf' || row.cls === 'etf' ? 'etf' : 'stocks', identifier: row.isin || pick.symbol,
          isin: row.isin, symbol: row.symbol || pick.symbol, yahooSymbol: pick.yahooSymbol, currency: row.currency,
        };
      }
    } catch { /* try the next query */ }
  }
  return undefined;
}
