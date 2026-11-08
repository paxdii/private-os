import { agentRoute } from '@/lib/agent/handler';
import { AgentError } from '@/lib/agent/envelope';
import { suggestAssets } from '@/lib/finance/trade';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Asset lookup before booking a trade: ledger assets (asset_id) and Yahoo
// listings that are not held yet (symbol). Pass either one to the trades endpoint.
export const GET = agentRoute(async ({ params, warn }) => {
  const query = (params.get('q') || '').trim();
  if (query.length < 2) throw new AgentError('invalid_param', '"q" braucht mindestens 2 Zeichen (Name, Ticker oder ISIN).');
  if (query.length > 100) throw new AgentError('invalid_param', '"q" ist zu lang.');
  const results = await suggestAssets(query);
  const existing = results.filter((item) => item.kind === 'existing');
  const market = results.filter((item) => item.kind === 'market');
  if (!market.length) warn.add('market_search', 'Keine neuen Börsen-Treffer (Yahoo leer oder nicht erreichbar).');
  return {
    in_ledger: existing.map((item) => item.kind === 'existing' ? {
      asset_id: item.assetId, name: item.name, asset_class: item.cls, symbol: item.symbol ?? null, identifier: item.identifier,
      held: item.held, shares: item.shares,
    } : null),
    new_listings: market.map((item) => item.kind === 'market' ? {
      symbol: item.yahooSymbol, name: item.name, asset_class: item.cls, exchange: item.exchange ?? null,
    } : null),
    summary: `${existing.length} im Depot, ${market.length} neue Börsen-Treffer für "${query}".`,
  };
});
