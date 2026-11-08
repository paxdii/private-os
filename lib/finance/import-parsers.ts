// Local readers for broker files. They run before any AI fallback, so known
// formats never leave the server. Each returns [] when it does not recognise
// the file.
import type { RawTrade } from './import';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  mär: '03', mai: '05', okt: '10', dez: '12',
};
const CURRENCY_SIGN: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP' };

// Trade confirmations print US-style numbers ("1,234.56").
function usNumber(text: string): number { return Number(text.replace(/,/g, '')); }

// ─── Broker trade confirmation (PDF, "Order details" / "Execution details" layout) ───
export function parseTradeConfirmation(text: string): RawTrade[] {
  const flat = text.replace(/\s+/g, ' ');
  if (!/Trade Confirmation/i.test(flat) || !/Order details/i.test(flat)) return [];
  const money = '([€$£])\\s?([\\d,]+(?:\\.\\d+)?)';
  const qty = '([\\d,]+(?:\\.\\d+)?)';

  const isinBySymbol = new Map<string, string>();
  const orderSection = section(flat, 'Settlement date', 'Fees summary') || section(flat, 'Order details', 'Fees summary');
  const orderRow = new RegExp(`(\\S+) (.+?) ([A-Z]{2}[A-Z0-9]{9}\\d) (Buy|Sell) ${qty} ${money} ${money} (\\d{1,2} \\w{3} \\d{4})`, 'g');
  const orders = [...orderSection.matchAll(orderRow)];
  for (const m of orders) isinBySymbol.set(m[1], m[3]);

  const execSection = section(flat, 'Execution venue', 'Get help') || section(flat, 'Execution details', 'Get help');
  const execRow = new RegExp(`(\\S+) (.+?) (Buy|Sell) ${qty} ${money} ${money} (\\d{1,2} \\w{3} \\d{4}) (\\d{2}:\\d{2}:\\d{2})`, 'g');
  let trades: RawTrade[] = [...execSection.matchAll(execRow)].map((m) => ({
    type: m[3] === 'Sell' ? 'sell' : 'buy', datetime: `${date(m[9])}T${m[10]}Z`,
    name: m[2].trim(), symbol: m[1], isin: isinBySymbol.get(m[1]) ?? null, cls: guessClass(m[2]),
    shares: usNumber(m[4]), price: usNumber(m[6]), amount: usNumber(m[8]),
    fee: 0, tax: 0, currency: CURRENCY_SIGN[m[5]] || 'EUR',
  }));
  // Older confirmations only have the order table; its date is settlement, not execution.
  if (!trades.length) {
    const confirmed = flat.match(/Confirmation date (\d{1,2} \w{3} \d{4})/)?.[1];
    trades = orders.map((m) => ({
      type: m[4] === 'Sell' ? 'sell' : 'buy', datetime: `${date(confirmed || m[10])}T12:00:00Z`,
      name: m[2].trim(), symbol: m[1], isin: m[3], cls: guessClass(m[2]),
      shares: usNumber(m[5]), price: usNumber(m[7]), amount: usNumber(m[9]), fee: 0, tax: 0, currency: CURRENCY_SIGN[m[6]] || 'EUR',
    }));
  }
  const feeTotal = flat.match(/Total Fee charged [€$£]\s?([\d,]+(?:\.\d+)?)/)?.[1];
  const total = trades.reduce((sum, t) => sum + (t.amount || 0), 0);
  if (feeTotal && total > 0) for (const t of trades) t.fee = usNumber(feeTotal) * (t.amount || 0) / total;
  return trades;
}

function section(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  if (start < 0) return '';
  const end = text.indexOf(to, start + from.length);
  return text.slice(start + from.length, end < 0 ? undefined : end);
}

function date(text: string): string {
  const [day, month, year] = text.split(' ');
  return `${year}-${MONTHS[month.slice(0, 3).toLowerCase()] || '01'}-${day.padStart(2, '0')}`;
}

function guessClass(name: string): RawTrade['cls'] {
  return /\b(ETF|UCITS|ETC|ETP|Index Fund|Fonds)\b/i.test(name) ? 'etf' : 'stocks';
}

// ─── CSV exports from brokers and exchanges (English and German headers) ─────
const HEAD = {
  date: ['date', 'datum', 'time', 'zeit', 'completed date', 'executed at', 'timestamp', 'buchungstag', 'ausführungsdatum', 'transaction date'],
  type: ['type', 'typ', 'art', 'side', 'transaction type', 'buchungsart', 'richtung', 'operation'],
  name: ['name', 'security name', 'wertpapier', 'instrument', 'asset name', 'bezeichnung', 'description', 'beschreibung'],
  symbol: ['ticker', 'symbol', 'asset', 'currency pair', 'coin', 'kürzel', 'pair', 'market'],
  isin: ['isin'],
  shares: ['quantity', 'shares', 'anzahl', 'stück', 'stueck', 'menge', 'amount asset', 'units', 'volume', 'vol', 'anteile'],
  price: ['price per share', 'price', 'kurs', 'preis', 'unit price', 'asset market price', 'ausführungskurs'],
  amount: ['total amount', 'total', 'value', 'betrag', 'amount', 'gesamt', 'cost', 'amount fiat', 'kurswert', 'net amount'],
  fee: ['fee', 'fees', 'gebühr', 'gebühren', 'commission', 'provision'],
  tax: ['tax', 'taxes', 'steuer', 'steuern', 'withholding tax'],
  currency: ['currency', 'währung', 'fiat', 'fiat currency', 'base currency'],
} as const;
type Column = keyof typeof HEAD;

const CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'DOT', 'ADA', 'XRP', 'FET', 'AVAX', 'USDT', 'USDC', 'CRO', 'DOGE', 'LINK', 'MATIC', 'POL', 'ATOM', 'LTC', 'BNB', 'TRX', 'SHIB', 'NEAR', 'ARB', 'OP', 'SUI', 'APT', 'TON', 'PEPE', 'XLM', 'ALGO', 'ICP', 'INJ', 'RNDR', 'RENDER', 'TAO', 'HBAR', 'KAS']);

export function parseCsv(content: string): RawTrade[] {
  const text = content.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const delimiter = [';', ',', '\t'].map((d) => [d, lines[0].split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows = lines.map((line) => splitCsvLine(line, delimiter));
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const col: Partial<Record<Column, number>> = {};
  for (const key of Object.keys(HEAD) as Column[]) {
    const idx = HEAD[key].map((name) => header.indexOf(name)).find((i) => i >= 0);
    if (idx != null && !Object.values(col).includes(idx)) col[key] = idx;
  }
  if (col.date == null || col.type == null || col.shares == null) return [];
  // German exports separate with ";" and write "1.234,56"; a "," file can only use commas as thousands.
  const comma: boolean | null = delimiter === ';' ? true : delimiter === ',' ? false : null;
  const cryptoFile = /crypto|krypto|coin/i.test(header.join(' ')) || rows.slice(1, 20).some((r) => CRYPTO.has(clean(r[col.symbol ?? -1]).split(/[-/]/)[0]));

  return rows.slice(1).flatMap((row): RawTrade[] => {
    const typeText = clean(row[col.type!]).toLowerCase();
    const type = /sell|verkauf|sale/.test(typeText) ? 'sell'
      : /buy|kauf|purchase|sparplan|savings plan/.test(typeText) ? 'buy'
      : /deposit.*(crypto|coin)|receive|empfang|eingang|transfer in|einbuchung/.test(typeText) ? 'transfer_in'
      : /withdraw.*(crypto|coin)|send|versand|ausgang|transfer out|ausbuchung/.test(typeText) ? 'transfer_out'
      : null;
    if (!type) return [];
    const shares = Math.abs(number(row[col.shares!], comma));
    if (!(shares > 0)) return [];
    const parsedDate = parseDate(clean(row[col.date!]));
    if (!parsedDate) return [];
    const rawSymbol = clean(row[col.symbol ?? -1]).toUpperCase();
    const symbol = rawSymbol.split(/[-/]/)[0] || null;
    const amountCell = clean(row[col.amount ?? -1]);
    const priceCell = clean(row[col.price ?? -1]);
    const currency = clean(row[col.currency ?? -1]).toUpperCase().slice(0, 3)
      || currencyIn(amountCell) || currencyIn(priceCell) || (rawSymbol.includes('-') || rawSymbol.includes('/') ? rawSymbol.split(/[-/]/)[1] : '') || 'EUR';
    const price = Math.abs(number(priceCell, comma));
    const amount = Math.abs(number(amountCell, comma)) || shares * price;
    const name = clean(row[col.name ?? -1]) || symbol || '';
    if (!name) return [];
    const isCrypto = (symbol && CRYPTO.has(symbol)) || (cryptoFile && !clean(row[col.isin ?? -1]));
    return [{
      type, datetime: parsedDate, name, symbol, isin: clean(row[col.isin ?? -1]).toUpperCase() || null,
      cls: isCrypto ? 'crypto' : guessClass(name), shares, price: price || (amount && shares ? amount / shares : null), amount,
      fee: Math.abs(number(row[col.fee ?? -1], comma)) || 0, tax: Math.abs(number(row[col.tax ?? -1], comma)) || 0, currency,
    }];
  });
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (quoted && line[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (ch === delimiter && !quoted) { out.push(cell); cell = ''; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}

const clean = (value?: string) => (value ?? '').trim();

function currencyIn(text: string): string {
  const sign = text.match(/[€$£]/)?.[0];
  if (sign) return CURRENCY_SIGN[sign];
  return text.match(/\b(EUR|USD|GBP|CHF)\b/i)?.[1].toUpperCase() || '';
}

function number(text: string | undefined, comma: boolean | null): number {
  let value = clean(text).replace(/[^\d.,-]/g, '');
  if (!value) return 0;
  if (comma || (comma === null && (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(value) || /^-?\d+,\d+$/.test(value)))) value = value.replace(/\./g, '').replace(',', '.');
  else value = value.replace(/,/g, '');
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseDate(text: string): string | null {
  const de = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (de) return `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}T${(de[4] || '12').padStart(2, '0')}:${de[5] || '00'}:${de[6] || '00'}Z`;
  const ms = Date.parse(text.replace(' ', 'T'));
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  const named = text.match(/^(\d{1,2}) (\w{3})\w* (\d{4})/);
  return named ? `${date(`${named[1]} ${named[2]} ${named[3]}`)}T12:00:00Z` : null;
}
