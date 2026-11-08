// MCP server of the private dashboard — the same domains as the Agent Context
// API (/api/agent/v1), exposed as tools for Claude and ChatGPT.
//
// Deliberately NO logic of its own: every tool calls the exported route handler
// of the matching /api/agent/v1 endpoint in-process. Parameter checks, write
// validation, the AGENT_API_WRITE_ENABLED kill switch and the XP rules all
// apply unchanged — a fix there lands here too.
//
// Difference to the REST API: one tool per action with a typed schema, so the
// model sees the allowed fields and values in the tool list instead of guessing.
import { NextRequest } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import { APP_TIMEZONE } from '@/lib/date';
import { markInternalAgentRequest } from '@/lib/agent/auth';
import { DAILY_HABIT_KEYS, WEEKLY_HABIT_KEYS } from '@/lib/agent/write/habits';
import { GOAL_CATEGORIES, GOAL_PERIODS, GOAL_STATUSES } from '@/lib/agent/write/goals';
import * as briefRoute from '@/app/api/agent/v1/daily-brief/route';
import * as healthRoute from '@/app/api/agent/v1/health/route';
import * as habitsRoute from '@/app/api/agent/v1/habits/route';
import * as habitToggleRoute from '@/app/api/agent/v1/habits/toggle/route';
import * as habitWeeklyRoute from '@/app/api/agent/v1/habits/weekly/route';
import * as habitDayRoute from '@/app/api/agent/v1/habits/day/route';
import * as financeRoute from '@/app/api/agent/v1/finance/route';
import * as financeAssetsRoute from '@/app/api/agent/v1/finance/assets/route';
import * as financeTradesRoute from '@/app/api/agent/v1/finance/trades/route';
import * as subscriptionsRoute from '@/app/api/agent/v1/subscriptions/route';
import * as goalsRoute from '@/app/api/agent/v1/goals/route';
import * as todoRoute from '@/app/api/agent/v1/todo/route';
import * as todoRestoreRoute from '@/app/api/agent/v1/todo/restore/route';
import * as reflectionsRoute from '@/app/api/agent/v1/reflections/route';
import * as passageRoute from '@/app/api/agent/v1/passage/route';
import * as xpRoute from '@/app/api/agent/v1/xp/route';

export type McpPrincipal = {
  /** 'oauth' = connector with PIN consent, 'token' = static agent token. */
  kind: 'oauth' | 'token';
  canWrite: boolean;
};

const INSTRUCTIONS = `Privates Dashboard: Gesundheit (WHOOP, Apple Health, Blutbild), Gewohnheiten, Tages-Journal und Reflexionen, Ziele, Planer/To-dos, Finanzen, Abonnements, Tagespassage, XP.

Konventionen:
- Kalendertage YYYY-MM-DD in ${APP_TIMEZONE}. "Heute" ist der Kalendertag in dieser Zeitzone.
- Jede Antwort hat \`warnings\`. Lies sie VOR den Zahlen: fällt eine Quelle aus (WHOOP, Notion, Kursquelle …), fehlen deren Daten — "leer" heißt dann NICHT "nichts da".
- Für einen Tagesüberblick genügt get_daily_brief.
- Zustände werden gesetzt, nicht umgeschaltet: habit_set_daily mit done=true zweimal ändert nichts.
- Für zukünftige Tage lassen sich keine Gewohnheiten oder Journal-Einträge schreiben.
- Gewohnheiten und Ziele vergeben XP nach den Dashboard-Regeln (auch Abzüge, z. B. beim Abbrechen eines Ziels).
- Reflexionen (Notion) und Abonnements sind nur lesbar. To-dos werden nur weich gelöscht und lassen sich wiederherstellen.
- Finanzen: Käufe, Verkäufe und Dividenden mit finance_add_trade buchen. Vorher finance_search_assets aufrufen und asset_id (im Depot) oder symbol (neu) übernehmen. Buchungen lassen sich hier nicht löschen; vor dem Buchen Werte mit dem Nutzer abgleichen.`;

// ── Calling the agent routes ─────────────────────────────────────────────

type Handler = (req: NextRequest) => Promise<Response>;
type Args = Record<string, unknown>;

function text(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

async function call(handler: Handler, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', args: Args): Promise<CallToolResult> {
  const url = new URL('http://internal/api/agent/v1');
  // Unset optionals are dropped; an explicit null stays in a body — it means
  // "clear this field" (e.g. a to-do's date).
  const fields = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  if (method === 'GET') {
    for (const [k, v] of Object.entries(fields)) {
      url.searchParams.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
  }
  const req = new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(fields) }),
  });
  markInternalAgentRequest(req);

  const res = await handler(req);
  const json = (await res.json()) as {
    ok: boolean;
    generated_at: string;
    source: string;
    data?: unknown;
    warnings?: unknown[];
    error?: { code: string; message: string };
  };
  // isError with a clear message: the model should correct itself (the error
  // texts name the allowed values) rather than give up.
  if (!json.ok) return text({ error: json.error }, true);
  // `warnings` first: a missing source must arrive before the numbers.
  return text({ warnings: json.warnings ?? [], generated_at: json.generated_at, source: json.source, data: json.data });
}

const read = (handler: Handler) => (args: Args) => call(handler, 'GET', args);

// ── Shared schema pieces ─────────────────────────────────────────────────

const day = z.string().describe('Kalendertag YYYY-MM-DD (Europe/Vienna). Standard: heute.');
const rangeShape = {
  date: z.string().optional().describe('Genau dieser Tag, YYYY-MM-DD. Nicht zusammen mit from/to.'),
  from: z.string().optional().describe('Erster Tag, YYYY-MM-DD, einschließlich.'),
  to: z.string().optional().describe('Letzter Tag, YYYY-MM-DD, einschließlich. Standard: heute.'),
};

const PRIORITY = z.enum(['high', 'medium', 'low', 'none']);
const SLOT = z.enum(['anytime', 'morning', 'afternoon', 'evening']);
const REPEAT = z.enum(['none', 'daily', 'weekly', 'monthly']);
const THEME = z.enum(['work', 'finance', 'creative', 'health', 'home', 'learning', 'general']);
const SUBTASKS = z.array(z.object({ id: z.string(), title: z.string(), done: z.boolean() }));

const todoFields = {
  priority: PRIORITY.optional().describe('Standard: none.'),
  date: z.string().nullable().optional().describe('Geplanter Tag YYYY-MM-DD; null = ungeplant (To-do-Liste).'),
  slot: SLOT.optional().describe('Tagesabschnitt. Standard: anytime. Mit Uhrzeit wird er automatisch aus der Zeit abgeleitet (vor 12 morning, vor 17 afternoon, sonst evening).'),
  time: z.string().nullable().optional().describe('Startzeit HH:MM (Europe/Vienna) oder null.'),
  reminder: z.number().int().min(0).max(1440).nullable().optional().describe('Push-Erinnerung in Minuten vor dem Start; null = keine.'),
  duration: z.number().int().min(1).max(1440).optional().describe('Dauer in Minuten. Standard: 30.'),
  repeat: REPEAT.optional().describe('Wiederholung. Standard: none.'),
  notes: z.string().optional().describe('Freie Notizen.'),
  subtasks: SUBTASKS.optional().describe('Teilschritte.'),
  done: z.boolean().optional().describe('Erledigt (nur nicht wiederkehrende Aufgaben).'),
  completedDates: z.array(z.string()).optional().describe('Erledigte Termine einer wiederkehrenden Aufgabe, YYYY-MM-DD.'),
  order: z.number().optional().describe('Sortierung innerhalb der Liste bzw. des Tagesabschnitts.'),
  emoji: z.string().optional().describe('Symbol; sonst automatisch aus dem Titel.'),
  theme: THEME.optional().describe('Illustrations-Thema; sonst aus dem Titel abgeleitet.'),
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
// Setting a state explicitly: calling twice with the same arguments changes nothing.
const SETS = { ...WRITES, idempotentHint: true } as const;

// ── Server ───────────────────────────────────────────────────────────────

export function createDashboardMcpServer(principal: McpPrincipal): McpServer {
  const server = new McpServer(
    { name: 'private-dashboard', title: 'Privates Dashboard', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );

  // ── Read ───────────────────────────────────────────────────────────────

  server.registerTool('get_daily_brief', {
    title: 'Morgen-Briefing',
    description: 'Alles für den Tagesstart in einer Antwort: Gesundheit, Gewohnheiten, Ziele, Finanzen (kompakt), anstehende Abbuchungen, Tagespassage, XP und das letzte Tages-Journal.',
    inputSchema: {
      date: rangeShape.date,
      finance: z.boolean().optional().describe('Finanz-Block einschließen (langsam wegen Kursabfragen). Standard: true.'),
    },
    annotations: READ_ONLY,
  }, read(briefRoute.GET));

  server.registerTool('get_health', {
    title: 'Gesundheit',
    description: 'WHOOP (Recovery, HRV, Ruhepuls, Strain, Schlaf, Workouts), Apple Health (Schritte, Gewicht) und auffällige Blutwerte mit Verlauf. Standard: letzte 30 Tage.',
    inputSchema: { ...rangeShape, blood: z.boolean().optional().describe('Blutbild einschließen. Standard: true.') },
    annotations: READ_ONLY,
  }, read(healthRoute.GET));

  server.registerTool('get_habits', {
    title: 'Gewohnheiten',
    description: 'Tages- und Wochen-Gewohnheiten mit Serien, Bestserien, Erfüllungsquoten, Stimmung, Urlaubsmodus und perfekten Tagen. Standard: letzte 30 Tage.',
    inputSchema: rangeShape,
    annotations: READ_ONLY,
  }, read(habitsRoute.GET));

  server.registerTool('get_reflections', {
    title: 'Reflexionen und Journal',
    description: 'Reflexions-Einträge (Tag/Woche/Monat, aus Notion) mit Volltext sowie die täglichen Journal-Felder (dankbar, Intention, gut gemacht, morgen besser). Standard: letzte 30 Tage.',
    inputSchema: {
      ...rangeShape,
      limit: z.number().int().min(1).max(25).optional().describe('Höchstzahl Einträge. Standard: 10.'),
      type: z.enum(['Tag', 'Woche', 'Monat']).optional().describe('Nur Einträge dieses Typs.'),
      text: z.boolean().optional().describe('Volltext mitliefern. Standard: true.'),
    },
    annotations: READ_ONLY,
  }, read(reflectionsRoute.GET));

  server.registerTool('get_goals', {
    title: 'Ziele',
    description: 'Wochen- und Monatsziele mit Status, Kategorie und angepinnten Zielen. Die ids braucht goal_update.',
    inputSchema: {
      month: z.string().optional().describe('Monat YYYY-MM. Standard: aktueller Monat.'),
      date: rangeShape.date,
    },
    annotations: READ_ONLY,
  }, read(goalsRoute.GET));

  server.registerTool('get_todos', {
    title: 'Planer / To-dos',
    description: 'Aufgaben aus dem Planer mit Priorität, Datum, Tageszeit, Wiederholung, Unteraufgaben und Erledigtstatus. Die id braucht todo_update. Mit date=today nur die Aufgaben des Tages (inkl. wiederkehrender, jeweils mit doneOnDate).',
    inputSchema: {
      date: z.string().optional().describe('YYYY-MM-DD, "today" oder "tomorrow".'),
      open: z.boolean().optional().describe('Nur offene Aufgaben.'),
      inbox: z.boolean().optional().describe('Nur ungeplante Aufgaben (ohne Datum).'),
      include_deleted: z.boolean().optional().describe('Auch weich gelöschte Aufgaben (für todo_restore).'),
    },
    annotations: READ_ONLY,
  }, read(todoRoute.GET));

  server.registerTool('get_finance', {
    title: 'Finanzen',
    description: 'Nettovermögen, Allokation, Positionen, Rendite, Kapitalflüsse, Sparplan, Cashflow/Sparquote und Sparziele. Immer der aktuelle Stand.',
    inputSchema: { activities: z.number().int().min(0).max(100).optional().describe('Anzahl letzter Depot-Transaktionen. Standard: 25.') },
    annotations: READ_ONLY,
  }, read(financeRoute.GET));

  server.registerTool('finance_search_assets', {
    title: 'Finanzen: Asset suchen',
    description: 'Sucht Aktien, ETFs und Krypto nach Name, Ticker oder ISIN. Liefert Positionen aus dem Depot (asset_id, auch früher gehaltene) und neue Börsen-Treffer (symbol) für finance_add_trade.',
    inputSchema: { q: z.string().min(2).max(100).describe('Name, Ticker oder ISIN, z. B. "Microsoft", "NVDA", "Ethereum".') },
    annotations: { ...READ_ONLY, openWorldHint: true },
  }, read(financeAssetsRoute.GET));

  server.registerTool('get_subscriptions', {
    title: 'Abonnements / Fixkosten',
    description: 'Laufende Kosten mit Monats- und Jahressumme, Kategorien und den nächsten Abbuchungen.',
    inputSchema: {
      horizon: z.number().int().min(1).max(365).optional().describe('Tage in die Zukunft für "upcoming". Standard: 60.'),
      date: rangeShape.date,
    },
    annotations: READ_ONLY,
  }, read(subscriptionsRoute.GET));

  server.registerTool('get_passage', {
    title: 'Tagespassage',
    description: 'Die Buchpassage des Tages (deutsch und englisch) samt Lesestatus.',
    inputSchema: { date: rangeShape.date },
    annotations: READ_ONLY,
  }, read(passageRoute.GET));

  server.registerTool('get_xp', {
    title: 'XP und Level',
    description: 'Level, Gesamt-XP, Fortschritt zum nächsten Level und die XP-Bewegung der letzten Tage.',
    inputSchema: { days: z.number().int().min(1).max(90).optional().describe('Zeitfenster. Standard: 7.') },
    annotations: READ_ONLY,
  }, read(xpRoute.GET));

  // A read-only token never sees the write tools — better than tools that
  // always answer 403.
  if (!principal.canWrite) return server;

  // ── Habits and journal ─────────────────────────────────────────────────

  server.registerTool('habit_set_daily', {
    title: 'Tages-Gewohnheit setzen',
    description: 'Hakt eine Tages-Gewohnheit für einen Tag ab oder aus. Vergibt die serienabhängige XP bzw. den Abzug wie im Dashboard.',
    inputSchema: {
      habit: z.enum(DAILY_HABIT_KEYS as [string, ...string[]]).describe('Schlüssel der Gewohnheit.'),
      done: z.boolean().describe('Zielzustand.'),
      date: day.optional(),
    },
    annotations: SETS,
  }, (args) => call(habitToggleRoute.POST, 'POST', args));

  server.registerTool('habit_set_weekly', {
    title: 'Wochen-Gewohnheit setzen',
    description: 'Setzt den Wochenwert für die ISO-Woche des Datums. Zähler (gym, sauna) brauchen value, Checkboxen (reflexion, lesen) brauchen done.',
    inputSchema: {
      habit: z.enum(WEEKLY_HABIT_KEYS as [string, ...string[]]).describe('Schlüssel der Wochen-Gewohnheit.'),
      value: z.number().int().min(0).max(50).optional().describe('Neuer Zählerstand (gym, sauna).'),
      done: z.boolean().optional().describe('Erledigt ja/nein (reflexion, lesen).'),
      date: day.optional().describe('Irgendein Tag der gemeinten Woche. Standard: heute.'),
    },
    annotations: SETS,
  }, (args) => call(habitWeeklyRoute.POST, 'POST', args));

  server.registerTool('journal_write', {
    title: 'Stimmung und Tages-Journal',
    description: 'Schreibt Stimmung, Notiz und die vier Journal-Felder eines Tages. Ein gefülltes Journal-Feld hakt "Journaling" automatisch ab und vergibt die Reflexions-XP. Mindestens ein Feld außer date.',
    inputSchema: {
      date: day.optional(),
      mood: z.number().int().min(1).max(10).optional().describe('Stimmung 1–10.'),
      note: z.string().optional().describe('Freie Notiz.'),
      grateful_for: z.string().optional().describe('Wofür dankbar.'),
      intention: z.string().optional().describe('Intention für den Tag.'),
      done_well: z.string().optional().describe('Was gut gelaufen ist.'),
      better_tomorrow: z.string().optional().describe('Was morgen besser laufen soll.'),
    },
    annotations: WRITES,
  }, (args) => call(habitDayRoute.POST, 'POST', args));

  // ── Goals ──────────────────────────────────────────────────────────────

  server.registerTool('goal_create', {
    title: 'Ziel anlegen',
    description: 'Legt ein neues Ziel mit Status "offen" an.',
    inputSchema: {
      title: z.string().describe('Titel des Ziels.'),
      period: z.enum(GOAL_PERIODS).optional().describe('Standard: month.'),
      month: z.string().optional().describe('YYYY-MM. Standard: aktueller Monat.'),
      category: z.enum(GOAL_CATEGORIES).optional(),
      pinned: z.boolean().optional().describe('Auf der Startseite anpinnen.'),
    },
    annotations: WRITES,
  }, (args) => call(goalsRoute.POST, 'POST', args));

  server.registerTool('goal_update', {
    title: 'Ziel ändern',
    description: 'Ändert Status, Titel, Kategorie oder Pin eines Ziels (id aus get_goals). "erledigt" gibt XP, "abgebrochen" einen deutlichen Abzug.',
    inputSchema: {
      id: z.string().describe('id aus get_goals.'),
      status: z.enum(GOAL_STATUSES).optional(),
      title: z.string().optional(),
      category: z.enum(GOAL_CATEGORIES).optional(),
      pinned: z.boolean().optional(),
    },
    annotations: WRITES,
  }, (args) => call(goalsRoute.PATCH, 'PATCH', args));

  // ── Finanzen ───────────────────────────────────────────────────────────

  server.registerTool('finance_add_trade', {
    title: 'Finanzen: Kauf/Verkauf buchen',
    description: 'Bucht einen Kauf, Verkauf oder eine Dividende ins Depot. Ohne price und amount gilt der Schlusskurs am Handelstag. Ein neues Asset (symbol) wird mit dem ersten Kauf angelegt. Gleiche Buchung am selben Tag wird als Duplikat abgelehnt.',
    inputSchema: {
      asset_id: z.string().optional().describe('asset_id aus finance_search_assets (in_ledger). Nicht zusammen mit symbol.'),
      symbol: z.string().optional().describe('symbol aus finance_search_assets (new_listings), z. B. "MSFT" oder "ADA-EUR". Nicht zusammen mit asset_id.'),
      type: z.enum(['buy', 'sell', 'dividend']),
      date: z.string().optional().describe('Handelstag YYYY-MM-DD (Europe/Vienna). Standard: heute.'),
      time: z.string().optional().describe('Uhrzeit HH:MM (Europe/Vienna). Standard: 12:00.'),
      shares: z.number().positive().optional().describe('Stückzahl (Pflicht bei buy/sell).'),
      price: z.number().positive().optional().describe('Preis je Stück in currency. Standard: Marktkurs.'),
      amount: z.number().positive().optional().describe('Gesamtbetrag ohne Gebühren in currency. Pflicht bei dividend.'),
      fee: z.number().min(0).optional().describe('Gebühren in currency.'),
      tax: z.number().min(0).optional().describe('Steuern in currency.'),
      currency: z.enum(['EUR', 'USD']).optional().describe('Währung der Beträge. USD wird zum Tageskurs in EUR verbucht. Standard: EUR.'),
      note: z.string().max(300).optional().describe('Notiz, z. B. Broker oder Order-ID.'),
      allow_duplicate: z.boolean().optional().describe('Nur true, wenn wirklich zwei gleiche Buchungen am selben Tag gewollt sind.'),
    },
    annotations: { ...WRITES, openWorldHint: true },
  }, (args) => call(financeTradesRoute.POST, 'POST', args));

  // ── To-dos ─────────────────────────────────────────────────────────────

  server.registerTool('todo_create', {
    title: 'To-do anlegen',
    description: 'Legt eine Aufgabe im Planer an. Fehlende Felder bekommen die Planer-Standardwerte; Emoji und Thema werden aus dem Titel gewählt.',
    inputSchema: {
      title: z.string().describe('Aufgabentitel.'),
      id: z.string().optional().describe('Eigene UUID, macht Wiederholungen erkennbar (Duplikat ⇒ Fehler todo_exists).'),
      ...todoFields,
    },
    annotations: WRITES,
  }, (args) => call(todoRoute.POST, 'POST', args));

  server.registerTool('todo_update', {
    title: 'To-do ändern',
    description: 'Ändert die übergebenen Felder einer Aufgabe (id aus get_todos). Zum Verschieben date/slot/time setzen; einen Termin einer wiederkehrenden Aufgabe über completedDates abhaken.',
    inputSchema: {
      id: z.string().describe('id aus get_todos.'),
      title: z.string().optional(),
      ...todoFields,
    },
    annotations: WRITES,
  }, (args) => call(todoRoute.PATCH, 'PATCH', args));

  server.registerTool('todo_delete', {
    title: 'To-do löschen (wiederherstellbar)',
    description: 'Blendet eine Aufgabe aus dem Planer aus. Der Datensatz bleibt erhalten und lässt sich mit todo_restore zurückholen.',
    inputSchema: { id: z.string().describe('id aus get_todos.') },
    annotations: { ...WRITES, idempotentHint: true },
  }, (args) => call(todoRoute.DELETE, 'DELETE', args));

  server.registerTool('todo_restore', {
    title: 'To-do wiederherstellen',
    description: 'Holt eine weich gelöschte Aufgabe zurück (id aus get_todos mit include_deleted).',
    inputSchema: { id: z.string() },
    annotations: SETS,
  }, (args) => call(todoRestoreRoute.POST, 'POST', args));

  return server;
}
