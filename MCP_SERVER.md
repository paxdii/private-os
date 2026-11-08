# MCP-Server (Connector für Claude und ChatGPT)

Das private Dashboard als Connector für Claude (claude.ai, Claude Desktop,
Mobile-App, Claude Code) und ChatGPT. Damit können beide jederzeit auf
Gesundheit, Gewohnheiten, Journal, Reflexionen, Ziele, Planer, Finanzen und
Abos zugreifen — und Gewohnheiten abhaken, das Journal schreiben, Ziele und
To-dos pflegen.

Der Server ist eine zweite Tür zur [Agent Context API](AGENT_API.md), keine
zweite Logik: jedes Tool ruft den Route-Handler des passenden
`/api/agent/v1`-Endpunkts direkt im Prozess auf (`lib/mcp/server.ts`). Damit
gelten dieselben Regeln — Parameter- und Feldprüfung, XP-Vergabe, Not-Aus
`AGENT_API_WRITE_ENABLED`, kein endgültiges Löschen.

| | |
|---|---|
| URL | `https://dein-dashboard.vercel.app/api/mcp` |
| Transport | Streamable HTTP, zustandslos, JSON-Antworten |
| Auth | OAuth 2.1 (DCR + PKCE) mit PIN-Zustimmung — oder ein Agent-Token als Bearer |

## Einrichten

1. In Vercel `MCP_OAUTH_SECRET` setzen (≥ 32 Zeichen,
   `openssl rand -base64 48 | tr -d '\n'`) und neu deployen.
2. **Claude:** Einstellungen → Connectors → *Custom Connector hinzufügen* →
   URL `https://dein-dashboard.vercel.app/api/mcp`. Client-ID und Secret leer
   lassen — Claude registriert sich selbst. Danach steht der Connector auch in
   Claude Desktop und der Mobile-App bereit.
3. **ChatGPT:** Einstellungen → Apps & Connectors → *Erweitert* →
   Entwicklermodus an, dann *Connector erstellen* → dieselbe URL,
   Authentifizierung *OAuth*.
4. Beide öffnen `/oauth/authorize`: PIN eingeben, *Zugriff erlauben*.
5. **Claude Code** (optional):
   `claude mcp add --transport http privat https://dein-dashboard.vercel.app/api/mcp`

## Tools

**Lesen:** `get_daily_brief`, `get_health`, `get_habits`, `get_reflections`,
`get_goals`, `get_todos`, `get_finance`, `finance_search_assets`,
`get_subscriptions`, `get_passage`, `get_xp`.

**Schreiben:** `habit_set_daily`, `habit_set_weekly`, `journal_write`,
`goal_create`, `goal_update`, `todo_create`, `todo_update`, `todo_delete`
(weich), `todo_restore`, `finance_add_trade`.

Reflexionen (Notion) und Abos sind bewusst nur lesbar. Bei den Finanzen lassen
sich nur Käufe, Verkäufe und Dividenden buchen (`finance_add_trade`, ohne Preis
gilt der Schlusskurs am Handelstag); Löschen und Ändern bleibt dem Menschen.

## Sicherheit

- **Ablauf:** `/.well-known/oauth-protected-resource/api/mcp` →
  `/.well-known/oauth-authorization-server` → `POST /api/oauth/register` →
  `/oauth/authorize` (PIN-Session, Zustimmung) → `POST /api/oauth/token`.
- **Zustandslos:** client_id, Code, Access- und Refresh-Token sind mit
  `MCP_OAUTH_SECRET` signiert. Keine Tabelle, keine Migration. Secret tauschen
  = alle Connectoren sofort getrennt.
- **Laufzeiten:** Code 5 min (einmalig, PKCE S256 Pflicht), Access-Token 1 h,
  Refresh-Token 30 Tage.
- **Callbacks:** nur `https://claude.ai`, `https://claude.com`,
  `https://chatgpt.com` und `localhost`/`127.0.0.1` — erweiterbar per
  `MCP_OAUTH_REDIRECT_HOSTS`. So kann niemand einen Client mit eigener
  Callback-Adresse registrieren und einen Code abgreifen.
- **Zustimmung:** `/oauth/authorize` und `POST /api/oauth/authorize` liegen
  hinter der PIN (proxy.ts) und prüfen den Session-Cookie zusätzlich selbst.
- **Fester Token:** `Authorization: Bearer <AGENT_API_TOKEN>` (oder
  `AGENT_API_GROK_TOKEN`) gibt alle Tools frei; `AGENT_API_READ_TOKEN` sieht
  nur die Lese-Tools.
- **Interne Aufrufe:** Die Tools bauen eine `NextRequest` und markieren sie in
  einer `WeakSet` (`markInternalAgentRequest`) — nur diese Objekte überspringen
  die Bearer-Prüfung der Agent-Routen. Von außen nicht fälschbar.
- **Rate Limit:** 60 Anfragen pro Minute je Token und Instanz.
