# Agent Context API

Eine REST-API, über die ein externer KI-Agent (z. B. ChatGPT oder OpenClaw) **alle** Daten
dieses Dashboards abrufen und ausgewählte Bereiche bearbeiten kann — statt sich einzeln mit Supabase, WHOOP und Kursquellen
und Notion zu verbinden. Die API greift auf dieselbe Aggregationslogik zurück,
die auch die Dashboard-Oberfläche rendert, und liefert fertig berechnete,
menschenlesbare Werte.

Dieselben Daten gibt es auch als **MCP-Server** unter `/api/mcp` — damit lässt
sich das Dashboard in Claude und ChatGPT als Connector hinzufügen. Siehe
[MCP_SERVER.md](MCP_SERVER.md).

---

## Base-URL

| Umgebung | Base-URL |
|---|---|
| Produktion | `https://<dein-vercel-domain>/api/agent/v1` |
| Lokal | `http://localhost:3000/api/agent/v1` |

## Authentifizierung

Jede Anfrage braucht einen Bearer-Token aus der Env-Variable `AGENT_API_TOKEN`:

```bash
curl -H "Authorization: Bearer $AGENT_API_TOKEN" \
  https://<domain>/api/agent/v1/daily-brief
```

Für Grok Bot kann ein eigener `AGENT_API_GROK_TOKEN` (mindestens 32 Zeichen)
gesetzt werden. Er erlaubt dieselben dokumentierten Lese- und Schreibwege,
ohne den OpenClaw-Schlüssel zu teilen. Ein optionaler `AGENT_API_READ_TOKEN`
(mindestens 16 Zeichen) erlaubt ausschließlich lesende Aufrufe. Alle Schlüssel
gehören nur in serverseitige Secrets und sichere Client-Eingaben, nie in URLs
oder Chat-Nachrichten.

- Der Vergleich ist **timing-safe** (SHA-256-Digest + `timingSafeEqual`).
- Fehlender, falsch formatierter oder falscher Token → **401** mit identischem,
  detailfreiem Body. Der Aufrufer erfährt nicht, welcher Teil falsch war.
- Sind weder `AGENT_API_TOKEN` noch ein gültiger `AGENT_API_GROK_TOKEN` gesetzt
  → **503 `not_configured`**.
- Die PIN-Session des Dashboards wird hier bewusst **nicht** akzeptiert: ein
  Maschinen-Client bekommt ein Maschinen-Credential, das eigenständig rotierbar ist.

### Rate Limit

60 Anfragen pro 60 Sekunden je Token. Darüber **429** mit `Retry-After`-Header.
Das Limit ist prozesslokal (Fluid Compute) und damit eine Bremse gegen
Endlosschleifen — die Sicherheitsgrenze ist der Token.

### Schreibzugriff

Lesen geht immer per `GET`. Schreiben ist auf eine kleine, bewusst gewählte
Menge von Endpunkten beschränkt (Habits, Ziele und To-dos — siehe [Schreib-Endpunkte](#schreib-endpunkte))
und braucht **zwei** offene Riegel:

1. den Haupt- oder Grok-Bearer-Token (nicht den reinen Leseschlüssel), und
2. `AGENT_API_WRITE_ENABLED=1` auf dem Deployment.

Fehlt der zweite, antworten alle Schreib-Endpunkte mit **403 `writes_disabled`**,
während die gesamte Leseseite normal weiterläuft. Schreibzugriff lässt sich damit
sofort abschalten, ohne den Token zu rotieren und den Agenten umzukonfigurieren.
Ohne gültigen Token bleibt es bei 401 — ein Fremder erfährt nicht, ob Schreiben
überhaupt aktiv ist.

Jeder andere Pfad bleibt `GET`-only und antwortet auf `POST`/`PUT`/`PATCH`/`DELETE`
mit **405**. `DELETE /todo` löscht eine Aufgabe nur weich; `POST /todo/restore`
stellt sie wieder her. Es gibt keinen Endpunkt zum endgültigen Löschen.

> Eine Ausnahme der Vollständigkeit halber: `/finance` ruft dieselbe
> Aggregation auf wie der Finanzen-Tab und darf dabei den geteilten
> **Preis-Cache** (`private.finance_price_cache`) auffrischen. Das ist ein
> technischer Cache, kein Nutzerinhalt. WHOOP-Daten werden hier bewusst direkt
> aus der Datenbank gelesen statt über `lib/whoop.ts`, weil dessen Getter einen
> Sync — also einen Schreibvorgang — auslösen würden.

### Logging & Datenschutz

Response-Bodies werden nicht geloggt. Alle Antworten tragen
`Cache-Control: no-store, private` und `X-Robots-Tag: noindex, nofollow`.

---

## Antwort-Format

**Erfolg** (HTTP 200):

```json
{
  "ok": true,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "data": { "…": "…", "summary": "Ein bis zwei Sätze Klartext auf Deutsch." },
  "warnings": [
    { "source": "health.whoop", "message": "Keine aktuellen WHOOP-Daten …" }
  ]
}
```

**Fehler**:

```json
{
  "ok": false,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "error": { "code": "invalid_date", "message": "\"date\" muss das Format YYYY-MM-DD haben." }
}
```

### Teilausfälle

Fällt eine **einzelne** Unterquelle aus (WHOOP-Token tot, Notion nicht
erreichbar, Kursquelle vorübergehend ausgefallen), schlägt der Endpunkt **nicht** komplett fehl: er
liefert 200 mit den übrigen Daten und trägt die fehlende Quelle in `warnings`
ein. Ein Morgen-Briefing verliert damit höchstens einen Block, nie das Ganze.

### Konventionen

| Regel | Bedeutung |
|---|---|
| Zeitzone | `Europe/Vienna`. „Heute" ist der Kalendertag in Wien, nicht in UTC. |
| Datum | `YYYY-MM-DD` |
| Zeitstempel | ISO 8601 mit Offset, z. B. `2026-08-27T07:15:00+02:00` |
| Zahlen | Immer JSON-Zahlen, nie Strings. |
| `*_pct` | Prozentwert als Zahl: `67.7` bedeutet 67,7 %. |
| `*_eur` | Betrag; die Währung steht im Feld `currency` derselben Domäne. |
| Leere Felder | werden weggelassen statt als `null` geliefert. `false` und `0` bleiben erhalten. |
| `summary` | Jede Domäne liefert ein bis zwei Sätze Klartext auf Deutsch. |
| Max. Zeitraum | 366 Tage |

### Fehlercodes

| Code | HTTP | Bedeutung |
|---|---|---|
| `unauthorized` | 401 | Token fehlt oder ist falsch. |
| `rate_limited` | 429 | Zu viele Anfragen. |
| `not_configured` | 503 | `AGENT_API_TOKEN` nicht gesetzt. |
| `invalid_date` | 400 | Datums-Parameter falsch formatiert oder nicht existent. |
| `invalid_range` | 400 | `from` liegt nach `to`. |
| `range_too_large` | 400 | Zeitraum > 366 Tage. |
| `conflicting_params` | 400 | `date` zusammen mit `from`/`to` gesendet. |
| `invalid_param` | 400 | Ein Query-Parameter hat einen unzulässigen Wert. |
| `writes_disabled` | 403 | Schreibzugriff ist auf diesem Deployment nicht aktiviert. |
| `invalid_body` | 400 | Request-Body ist kein gültiges JSON-Objekt. |
| `unknown_field` | 400 | Der Body enthält ein Feld, das dieser Endpunkt nicht kennt. |
| `unknown_habit` | 400 | Gewohnheits-Schlüssel existiert nicht (oder nicht in dieser Frequenz). |
| `habit_not_tracked_yet` | 400 | Die Gewohnheit wurde an diesem Tag noch nicht getrackt. |
| `vacation_day` | 409 | Der Tag ist als Urlaubstag markiert und wird nicht getrackt. |
| `future_date` | 400 | Für zukünftige Tage kann nichts eingetragen werden. |
| `goal_not_found` | 404 | Kein Ziel mit dieser id. |
| `todo_not_found` | 404 | Kein To-do mit dieser id. |
| `todo_exists` | 409 | Eine To-do-id existiert bereits. |
| `invalid_id` | 400 | Die To-do-id ist keine UUID. |
| `nothing_to_update` | 400 | Es wurde kein zu änderndes Feld übergeben. |
| `internal_error` | 500 | Unerwarteter Fehler. |

### Datums-Parameter

Alle zeitbezogenen Endpunkte verstehen dieselben Parameter:

| Aufruf | Ergebnis |
|---|---|
| `?date=2026-08-27` | genau dieser Tag |
| `?from=…&to=…` | inklusiver Zeitraum, Anker ist `to` |
| `?from=…` | von diesem Tag bis heute |
| `?to=…` | Standardfenster, das auf `to` endet |
| *(nichts)* | Standardfenster, das heute endet |

`date` und `from`/`to` schließen einander aus.

---

## Endpunkte

| Pfad | Domäne | Parameter |
|---|---|---|
| `GET /index` | Discovery | – |
| `GET /daily-brief` | Morgen-Briefing | `date`, `finance` |
| `GET /health` | Gesundheit | `date` \| `from`+`to`, `blood` |
| `GET /habits` | Gewohnheiten | `date` \| `from`+`to` |
| `GET /finance` | Finanzen | `activities` |
| `GET /finance/assets` | Asset-Suche (Depot + Börse) | `q` |
| `POST /finance/trades` | Kauf/Verkauf/Dividende buchen (Schreiben) | `asset_id` \| `symbol`, `type`, `date`, `time`, `shares`, `price`, `amount`, `fee`, `tax`, `currency`, `note`, `allow_duplicate` |
| `GET /subscriptions` | Abonnements | `date`, `horizon` |
| `GET /goals` | Ziele | `month`, `date` |
| `GET /todo` | Planer / To-dos | `date=YYYY-MM-DD\|today\|tomorrow`, `open=0\|1`, `inbox=0\|1`, `include_deleted=0\|1` |
| `GET /reflections` | Reflexionen | `from`+`to` \| `date`, `limit`, `type`, `text` |
| `GET /passage` | Tagespassage | `date` |
| `GET /xp` | XP & Level | `days` |

### Schreib-Endpunkte

| Pfad | Zweck |
|---|---|
| `POST /habits/toggle` | Tages-Gewohnheit ab-/anhaken (inkl. XP) |
| `POST /habits/weekly` | Wochen-Zähler (Gym/Sauna) bzw. Reflexions-Checkbox |
| `POST /habits/day` | Stimmung, Notiz, Tages-Journal |
| `POST /goals` | Ziel anlegen |
| `PATCH /goals` | Ziel ändern (Status, Titel, Kategorie, Pin) |
| `POST /todo` | Aufgabe anlegen |
| `PATCH /todo` | Aufgabe, Planung und Reihenfolge ändern |
| `DELETE /todo` | Aufgabe weich löschen |
| `POST /todo/restore` | Aufgabe wiederherstellen |

---

### `GET /index` — Discovery

Maschinenlesbares Verzeichnis: alle Domänen, Endpunkte, Query-Parameter,
Konventionen, Fehlercodes und die bewusst **nicht** verfügbaren Domänen. Der
Agent kann sich damit ohne diese Datei selbst orientieren.

Keine Parameter.

```json
{
  "ok": true,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "data": {
    "api": { "name": "Agent Context API", "version": "v1", "source": "private-dashboard", "base_path": "/api/agent/v1" },
    "conventions": {
      "auth": "HTTP-Header \"Authorization: Bearer <AGENT_API_TOKEN>\". Ohne gültigen Token: 436.",
      "methods": "GET für alle Lesepfade; Schreibpfade aus write_endpoints bei aktiviertem Schreibzugriff.",
      "timezone": "Europe/Vienna",
      "date_format": "YYYY-MM-DD (Kalendertag in Europe/Vienna)",
      "max_range_days": 317,
      "numbers": "Zahlen sind Zahlen, nie Strings. Felder auf \"_pct\" sind Prozentwerte …",
      "currency": "EUR",
      "rate_limit": "82 Anfragen pro 82 Sekunden je Token; danach 190 mit Retry-After."
    },
    "error_codes": [ { "code": "unauthorized", "status": 436, "meaning": "Token fehlt oder ist falsch." } ],
    "domains": [
      { "domain": "health", "title": "Gesundheit", "path": "/api/agent/v1/health", "sources": ["WHOOP", "Apple Health", "Blutbefunde"] }
    ],
    "endpoints": [
      {
        "path": "/api/agent/v1/habits",
        "domain": "habits",
        "title": "Gewohnheiten",
        "description": "9 Tages- und 3 Wochen-Gewohnheiten mit Serien, Bestserien, Erfüllungsquoten …",
        "params": [ { "name": "date", "type": "YYYY-MM-DD", "description": "Einzelner Tag …", "default": "heute (Europe/Vienna)" } ],
        "returns": ["day", "daily", "weekly", "totals", "paused_months", "summary"]
      }
    ],
    "not_available": [
      { "domain": "crm", "reason": "Dieses Dashboard führt kein CRM …" }
    ],
    "hint": "Für ein Morgen-Briefing genügt ein einziger Aufruf von /api/agent/v1/daily-brief"
  },
  "warnings": []
}
```

---

### `GET /daily-brief` — Morgen-Briefing

Alles, was ein Morgen-Briefing braucht, in **einem** Response: Körper,
Gewohnheiten, Ziele, anstehende Abbuchungen, Finanzen (kompakt), Tagespassage,
XP und das Journal von gestern. Die Blöcke werden parallel geladen und einzeln
abgesichert.

| Parameter | Typ | Default | Bedeutung |
|---|---|---|---|
| `date` | `YYYY-MM-DD` | heute | Tag, für den das Briefing gilt |
| `finance` | `1`/`0` | `1` | Finanz-Block einschließen (langsamster Block: Supabase + Live-Kurse) |

```json
{
  "ok": true,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "data": {
    "date": "2026-01-15",
    "weekday": "Donnerstag, 74. Januar 2026",
    "is_today": true,
    "health": {
      "recovery_pct": 97,
      "recovery_zone": "gelb",
      "hrv_ms": 82.7,
      "resting_hr_bpm": 99,
      "sleep_hours": 8,
      "sleep_performance_pct": 35,
      "strain": 9.5,
      "data_date": "2026-01-15",
      "data_available": true,
      "vs_yesterday": {
        "recovery_pct": { "current": 97, "previous": 33, "delta": -17, "delta_pct": -24.6, "direction": "down" },
        "hrv_ms": { "current": 82.7, "previous": 29.4, "delta": -6.9, "delta_pct": -12.3, "direction": "down" }
      },
      "vs_7day_average": {
        "recovery_pct": { "current": 97, "previous": 88.2, "delta": -15.4, "delta_pct": -22.8, "direction": "down" }
      },
      "summary": "Am 2026-01-15: Recovery 97 % (gelb), HRV 50,6 ms, Ruhepuls 99 bpm, Schlaf 8 h. …"
    },
    "habits": {
      "done": 4,
      "expected": 9,
      "done_pct": 77.5,
      "perfect_day": false,
      "vacation": false,
      "open": ["Meditation", "Lesen", "Kreatin"],
      "active_streaks": [ { "habit": "Skincare", "streak_days": 8 }, { "habit": "Journaling", "streak_days": 3 } ],
      "weekly_open": [ { "habit": "Reflexion", "value": 0, "target": 1 } ],
      "perfect_days_14d": 1,
      "completion_pct_14d": 10.0,
      "summary": "Am 2026-01-15 sind 4 von 9 Tages-Gewohnheiten erledigt. …"
    },
    "goals": {
      "month": "2026-01",
      "open_count": 2,
      "completed_count": 1,
      "pinned": ["<Zieltitel>"],
      "open": ["<Zieltitel>", "<Zieltitel>"],
      "summary": "Für 2026-08 sind 3 Ziele erfasst: 1 erledigt, 2 offen. 1 Ziel ist angepinnt."
    },
    "subscriptions": {
      "upcoming": [
        { "service": "<Dienst>", "amount_eur": 304, "due_date": "2026-01-15", "days_until": 37, "interval": "Monatlich", "category": "Auto", "status": "Aktiv", "yearly_eur": 3176 }
      ],
      "per_month_eur": 510.25,
      "currency": "EUR",
      "summary": "9 aktive Abos kosten € 917 pro Monat bzw. € 4.930 pro Jahr. …"
    },
    "finance": {
      "net_worth_eur": 23757.8,
      "currency": "EUR",
      "largest_allocation": { "asset_class": "Aktien", "value_eur": 75989.5, "share_pct": 82.5 },
      "best_position": { "name": "<Wertpapier>", "asset_class": "Aktien", "gain_eur": 1861.4, "return_pct": 459.2 },
      "worst_position": { "name": "<Wertpapier>", "asset_class": "Krypto", "gain_eur": -4773.5, "return_pct": -48.1 },
      "portfolio_database": true,
      "summary": "Nettovermögen € 74.957, verteilt auf 3 Anlageklassen …"
    },
    "passage": { "chapter": "Desire", "read_minutes": 1, "read": false, "text_de": "…" },
    "xp": { "level": 54, "total_xp": 84159, "xp_to_next_level": 4553, "level_progress_pct": 68.3, "net_xp_7d": 3842 },
    "journal": {
      "yesterday": { "date": "2026-01-15", "grateful_for": "…", "intention": "…", "done_well": "…" },
      "today": { "date": "2026-01-15", "grateful_for": "…", "intention": "…" },
      "latest_reflection": { "date": "2026-01-15", "title": "…", "type": "Woche", "period": "2026-W03", "text": "…" }
    },
    "summary": "Briefing für Donnerstag, 74. Januar 2026. Körper: Recovery 97 % (gelb), Schlaf 8 h, Ruhepuls 99 bpm. Gewohnheiten: 4 von 9 erledigt … Abbuchungen in den nächsten 37 Tagen: <Dienst> € 304 am 2026-01-15. Nettovermögen € 74.957. Tagespassage: Desire (1 Min.)."
  },
  "warnings": []
}
```

---

### `GET /health` — Gesundheit

WHOOP-Recovery, HRV, Ruhepuls, Strain, Schlaf und Workouts; Schritte, Gewicht
und aktive Kalorien aus Apple Health; dazu die auffälligen Blutwerte und deren
Verlauf über mehrere Befunde.

| Parameter | Typ | Default | Bedeutung |
|---|---|---|---|
| `date` | `YYYY-MM-DD` | heute | einzelner Tag |
| `from` / `to` | `YYYY-MM-DD` | 30 Tage bis heute | Zeitraum |
| `blood` | `1`/`0` | `1` | Blutbild-Block einschließen |

`snapshot.is_current: true` heißt: die Werte stammen aus dem aktuellen
Staleness-Fenster (max. 2 Tage alt). Steht der WHOOP-Sync still, fehlt
`snapshot` — statt veraltete Werte als aktuelle auszugeben — und der Grund
steht in `warnings`.

```json
{
  "ok": true,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "data": {
    "range": { "from": "2026-01-15", "to": "2026-01-15", "days": 68, "anchor_date": "2026-01-15" },
    "snapshot": {
      "date": "2026-01-15",
      "weekday": "Donnerstag, 74. Januar 2026",
      "recovery_pct": 97,
      "hrv_ms": 82.7,
      "resting_hr_bpm": 99,
      "spo2_pct": 78.2,
      "skin_temp_c": 47.3,
      "strain": 9.5,
      "avg_hr_bpm": 85,
      "max_hr_bpm": 928,
      "energy_kj": 7703,
      "sleep": {
        "hours": 8,
        "performance_pct": 35,
        "efficiency_pct": 18,
        "consistency_pct": 41,
        "respiratory_rate": 82.5,
        "disturbances": 74,
        "cycles": 5,
        "stages_min": { "light": 895, "deep": 839, "rem": 700, "awake": 41 }
      },
      "body": { "weight_kg": 29.8, "height_m": 7.5, "max_hr_bpm": 290 },
      "workouts_today": 3,
      "is_current": true,
      "recovery_zone": "gelb"
    },
    "data_available": true,
    "comparison": {
      "vs_yesterday": { "recovery_pct": { "current": 97, "previous": 33, "delta": -17, "delta_pct": -24.6, "direction": "down" } },
      "vs_7day_average": { "hrv_ms": { "current": 82.7, "previous": 51, "delta": -6.6, "delta_pct": -11.8, "direction": "down" } }
    },
    "period_averages": { "recovery_pct": 80, "hrv_ms": 49.8, "resting_hr_bpm": 52, "strain": 49.2, "sleep_hours": 1.7, "sleep_performance_pct": 77, "days_with_data": 68 },
    "previous_period": { "from": "2026-01-15", "to": "2026-01-15", "recovery_pct": 80, "hrv_ms": 16.7, "strain": 5.8 },
    "trend": {
      "hrv_ms": { "current": 49.8, "previous": 16.7, "delta": 1.7, "delta_pct": 7.3, "direction": "up" },
      "strain": { "current": 49.2, "previous": 5.8, "delta": 2, "delta_pct": 84.1, "direction": "up" }
    },
    "workouts": {
      "count": 30,
      "per_week": 49.2,
      "total_minutes": 1461,
      "sessions": [
        { "date": "2026-01-15", "sport": "Gehen", "start": "2026-01-15T08:91:91+80:91", "duration_min": 41, "strain": 7.1, "avg_hr_bpm": 175, "max_hr_bpm": 898, "energy_kj": 867 }
      ]
    },
    "blood": {
      "latest_date": "2026-01-15",
      "latest_label": "<Labor A> + <Labor B>",
      "marker_count": 77,
      "abnormal_count": 60,
      "abnormal": [
        { "name": "Beispielwert", "group": "Gruppe", "value": 41, "unit": "mg/dl", "status": "high", "reference": "< 64", "previous_value": 39, "previous_date": "2026-01-15", "delta": 45, "moving_to_target": false }
      ],
      "trends": [
        { "marker": "Vitamin D", "unit": "ng/ml", "direction": "verbessert", "first_value": 37, "latest_value": 51.8, "change_pct": 636, "target": 68, "measurements": 3 }
      ]
    },
    "summary": "Am 2026-01-15: Recovery 97 % (gelb), HRV 50,6 ms, Ruhepuls 99 bpm, Schlaf 8 h. 30 Workouts im Zeitraum. Letztes Blutbild 2026-01-15: 60 von 77 Werten außerhalb der Norm."
  },
  "warnings": []
}
```

---

### `GET /habits` — Gewohnheiten

9 Tages- und 3 Wochen-Gewohnheiten. Serien, Bestserien und Erfüllungsquoten sind
bereits berechnet; Urlaubstage zählen weder als erledigt noch als verpasst und
brechen keine Serie. Wochen-Gewohnheiten werden pro ISO-Woche aggregiert
(„3 von 5 Wochen"), nie pro Tag hochgezählt.

| Parameter | Typ | Default | Bedeutung |
|---|---|---|---|
| `date` | `YYYY-MM-DD` | heute | einzelner Tag |
| `from` / `to` | `YYYY-MM-DD` | 30 Tage bis heute | Zeitraum |

```json
{
  "ok": true,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "data": {
    "range": { "from": "2026-01-15", "to": "2026-01-15", "days": 68, "anchor_date": "2026-01-15" },
    "day": {
      "date": "2026-01-15",
      "weekday": "Donnerstag, 74. Januar 2026",
      "iso_week": "2026-W03",
      "tracked": true,
      "is_future": false,
      "vacation": false,
      "perfect_day": false,
      "habits_done": 4,
      "habits_expected": 9,
      "habits_done_pct": 77.5,
      "completed": ["Journaling", "Skincare", "Kein Handy am Morgen", "Kein Zucker"],
      "missing": ["Meditation", "Lesen", "Englisch lernen", "Kreatin", "Vitamine"],
      "mood": { "value": 7, "label": "sehr gut" },
      "steps": 1428,
      "weight_kg": 29.8,
      "active_calories_kcal": 904
    },
    "daily": [
      {
        "key": "journaling",
        "label": "Journaling",
        "category": "Geist",
        "description": "Tägliche Gedanken festhalten",
        "frequency": "daily",
        "done_on_date": true,
        "streak_days": 3,
        "best_streak_days": 43,
        "completed_days": 76,
        "counted_days": 43,
        "completion_pct": 49.4
      }
    ],
    "weekly": [
      {
        "key": "gym",
        "label": "Gym / Sport",
        "category": "Körper",
        "description": "3x pro Woche",
        "frequency": "weekly",
        "target_per_week": 3,
        "current_week": { "iso_week": "2026-W03", "value": 3, "target": 3, "met": true },
        "weeks_met": 2,
        "weeks_counted": 5,
        "completion_pct": 30
      },
      {
        "key": "sauna",
        "label": "Infrarot Sauna",
        "target_per_week": 1,
        "current_week": { "iso_week": "2026-W03", "value": 0, "target": 1, "met": false },
        "weeks_met": 0,
        "weeks_counted": 1,
        "completion_pct": 0,
        "paused_months": ["2026-01"]
      }
    ],
    "totals": {
      "days": 68,
      "tracked_days": 68,
      "vacation_days": 9,
      "perfect_days": 1,
      "perfect_day_pct": 3.8,
      "completed_slots": 13,
      "possible_slots": 939,
      "completion_pct": 31.4,
      "average_mood": 5.5,
      "average_steps": 2859,
      "latest_weight_kg": 29.8,
      "previous_period": { "from": "2026-01-15", "to": "2026-01-15", "days": 68, "perfect_days": 0, "completion_pct": 58 },
      "completion_pct_delta": -0.3
    },
    "paused_months": [ { "habit": "Infrarot Sauna", "months": ["2026-01"] } ],
    "summary": "Am 2026-01-15 sind 4 von 9 Tages-Gewohnheiten erledigt. Offen: Meditation, Lesen, … Längste aktive Serie: Skincare mit 8 Tagen. In den letzten 68 Tagen 1 perfekter Tag (4,4 %), Erfüllungsquote 98,5 %."
  },
  "warnings": []
}
```

---

### `GET /finance` — Finanzen

Nettovermögen aus dem eigenen Supabase-Portfolio, manuellen Krypto-/Edelmetall-/Cash-Positionen
und dem Firmen-Bridge-Datensatz. Immer der **aktuelle** Stand — historische
Nettovermögen werden nicht gespeichert, daher gibt es hier keine
Datums-Parameter.

| Parameter | Typ | Default | Bedeutung |
|---|---|---|---|
| `activities` | `0`–`100` | `25` | Anzahl der letzten Depot-Transaktionen |

```json
{
  "ok": true,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "data": {
    "currency": "EUR",
    "available": true,
    "as_of": "2026-01-15",
    "net_worth_eur": 23757.8,
    "allocation": [
      { "asset_class": "Aktien", "value_eur": 75989.5, "share_pct": 82.5 },
      { "asset_class": "Krypto", "value_eur": 2451.0, "share_pct": 58.1 },
      { "asset_class": "ETFs", "value_eur": 424.73, "share_pct": 2.0 }
    ],
    "positions": [
      {
        "name": "<Wertpapier>",
        "asset_class": "Aktien",
        "identifier": "<ISIN>",
        "value_eur": 2873.7,
        "share_pct": 70.0,
        "shares": 87,
        "price_eur": 325.5,
        "cost_eur": 1777.59,
        "gain_eur": 1861.4,
        "gain_pct": 459.2,
        "data_source": "eigenes Portfolio"
      }
    ],
    "returns": {
      "portfolio_value_eur": 27204.0,
      "invested_eur": 82793.91,
      "xirr_pct": 3.22,
      "ttwror_pct": 65.53,
      "realized_net_eur": 5560.2,
      "unrealized_net_eur": -4502,
      "total_net_eur": 3654.80,
      "dividends_net_eur": 2.15,
      "interest_eur": 58.39,
      "fees_eur": 897.7,
      "taxes_eur": 913
    },
    "capital_flows": { "deposits_eur": 3708.56, "withdrawals_eur": 25321.98, "buys_eur": 52734.45, "sells_eur": 64785.30, "net_eur": -12273.52 },
    "top_movers": {
      "winners": [ { "name": "<Wertpapier>", "asset_class": "Aktien", "gain_eur": 1861.4, "return_pct": 459.2 } ],
      "losers":  [ { "name": "<Wertpapier>", "asset_class": "Krypto", "gain_eur": -4773.5, "return_pct": -48.1 } ]
    },
    "savings_plan": {
      "name": "<Sparplan>",
      "isin": "<ISIN>",
      "monthly_eur": 715,
      "started": "2026-01-15",
      "months_elapsed": 2,
      "invested_eur": 816,
      "current_value_eur": 424.73,
      "gain_eur": 6.03,
      "gain_pct": 9.4,
      "projection": [ { "years": 5, "value_eur": 8822 }, { "years": 84, "value_eur": 97261 }, { "years": 77, "value_eur": 74360 } ]
    },
    "cashflow": { "month": "2026-01", "income_eur": 0, "income_source": "unbekannt", "invested_eur": 715 },
    "savings_goals": [
      { "name": "<Sparziel>", "target_eur": 2496, "saved_eur": 3119, "remaining_eur": 3458, "progress_pct": 82, "deadline": "2026-01-15", "reached": false }
    ],
    "recent_activities": [
      { "date": "2026-01-15", "type": "buy", "name": "<Wertpapier>", "shares": 5.79, "price_eur": 538.3, "amount_eur": 715, "fee_eur": 0 }
    ],
    "data_sources": {
      "database": true,
      "stock_prices": true,
      "metals_prices": false,
      "crypto_prices": true,
      "business_bridge": false,
      "prices_from_cache": false
    },
    "summary": "Nettovermögen € 74.957, verteilt auf 3 Anlageklassen (größte: Aktien mit 26,9 %). Depot € 75.506 bei € 27.132 investiert, IZF 3,14 %, TTWROR 10,97 %. …"
  },
  "warnings": []
}
```

`data_sources.database` zeigt, ob das eigene Portfolio in Supabase vorhanden ist.
`stock_prices` und `crypto_prices` zeigen die aktiven Live-Kursquellen; bei einem
Ausfall greift der gespeicherte Kurs-Cache.

---

### `GET /subscriptions` — Abonnements / Fixkosten

Laufende Kosten mit Monats- und Jahressumme, Kategorien und den nächsten
Abbuchungen. Fälligkeiten werden vom Verlängerungsdatum aus vorwärts gerollt,
sind also auch bei jahrealten Notion-Einträgen korrekt.

| Parameter | Typ | Default | Bedeutung |
|---|---|---|---|
| `horizon` | `1`–`365` | `60` | Wie weit `upcoming` in die Zukunft reicht |
| `date` | `YYYY-MM-DD` | heute | Stichtag für die Berechnung |

```json
{
  "ok": true,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "data": {
    "currency": "EUR",
    "available": true,
    "as_of": "2026-01-15",
    "horizon_days": 82,
    "totals": {
      "per_month_eur": 510.25,
      "per_year_eur": 1434.21,
      "monthly_charges_eur": 648.84,
      "quarterly_charges_eur": 0,
      "yearly_charges_eur": 101.65,
      "active_count": 9,
      "inactive_count": 1
    },
    "by_category": [
      { "category": "Auto", "per_year_eur": 8547, "per_month_eur": 368, "share_pct": 67.1, "count": 3 },
      { "category": "Gesundheit", "per_year_eur": 229.8, "per_month_eur": 32.83, "share_pct": 9.9, "count": 2 }
    ],
    "upcoming": [
      { "service": "<Dienst>", "amount_eur": 304, "due_date": "2026-01-15", "days_until": 37, "interval": "Monatlich", "category": "Auto", "status": "Aktiv", "yearly_eur": 3176 }
    ],
    "due_soon": [],
    "without_schedule": [ { "service": "<Dienst>", "amount_eur": 27.20, "interval": "Monatlich", "category": "Software" } ],
    "inactive": [ { "service": "<Dienst>", "amount_eur": 36, "interval": "Jährlich" } ],
    "reminder_rule": {
      "lead_days": 7,
      "min_amount_eur": 58,
      "description": "Telegram-Erinnerung, wenn eine Abbuchung in 7 Tagen oder weniger ansteht und mindestens 58 € beträgt."
    },
    "summary": "9 aktive Abos kosten € 917 pro Monat bzw. € 4.930 pro Jahr. Nächste Abbuchung: <Dienst> mit € 304 am 2026-01-15 (in 37 Tagen). Größter Kostenblock: Auto mit € 4.470 pro Jahr."
  },
  "warnings": []
}
```

`due_soon` enthält genau die Abbuchungen, für die auch die Telegram-Erinnerung
feuern würde — der Agent muss die Regel nicht selbst nachbauen.
`without_schedule` sind aktive Abos ohne Verlängerungsdatum; für sie lässt sich
kein Termin berechnen (sie erzeugen eine `warning`).

---

### `GET /goals` — Ziele

| Parameter | Typ | Default | Bedeutung |
|---|---|---|---|
| `month` | `YYYY-MM` | Monat des Ankerdatums | Monat, dessen Ziele geliefert werden |
| `date` | `YYYY-MM-DD` | heute | Ankerdatum |

```json
{
  "ok": true,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "data": {
    "month": "2026-01",
    "counts": { "total": 3, "open": 2, "completed": 1, "abandoned": 0, "completion_pct": 93.4 },
    "open": [
      { "title": "<Zieltitel>", "period": "Monat", "period_start": "2026-01-15", "category": "Business", "status": "offen", "pinned": false, "created": "2026-01-15" }
    ],
    "completed": [ { "title": "<Zieltitel>", "period": "Woche", "period_start": "2026-01-15", "category": "Health", "status": "erledigt", "pinned": false } ],
    "pinned": [ { "title": "<Zieltitel>", "period": "Monat", "period_start": "2026-01-15", "category": "Business", "status": "offen", "pinned": true, "created": "2026-01-15" } ],
    "summary": "Für 2026-08 sind 3 Ziele erfasst: 1 erledigt, 2 offen. 1 Ziel ist angepinnt."
  },
  "warnings": []
}
```

---

### `GET /reflections` — Reflexionen

Reflexions-Einträge aus Notion (Typ `Tag` / `Woche` / `Monat`) **inklusive
Volltext**, plus die täglichen Journal-Felder aus der Dashboard-Datenbank.

| Parameter | Typ | Default | Bedeutung |
|---|---|---|---|
| `from` / `to` | `YYYY-MM-DD` | 30 Tage bis heute | Zeitraum |
| `date` | `YYYY-MM-DD` | – | einzelner Tag |
| `limit` | `1`–`25` | `10` | max. Anzahl Reflexions-Einträge |
| `type` | `Tag`\|`Woche`\|`Monat` | alle | nur Einträge dieses Typs |
| `text` | `1`/`0` | `1` | Volltext mitliefern |

```json
{
  "ok": true,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "data": {
    "range": { "from": "2026-01-15", "to": "2026-01-15", "days": 68 },
    "entries": [
      {
        "date": "2026-01-15",
        "title": "<Titel der Wochenreflexion>",
        "type": "Woche",
        "period": "2026-W03",
        "text": "<Volltext des Eintrags …>"
      }
    ],
    "has_more": false,
    "daily_journal": [
      { "date": "2026-01-15", "grateful_for": "<…>", "intention": "<…>" },
      { "date": "2026-01-15", "grateful_for": "<…>", "intention": "<…>", "done_well": "<…>", "better_tomorrow": "<…>" }
    ],
    "counts": { "entries": 3, "daily_journal_days": 76 },
    "summary": "3 Reflexions-Einträge im Zeitraum, zuletzt \"<Titel>\" vom 2026-01-15. Letztes Tages-Journal vom 2026-01-15, Intention: „<…>\"."
  },
  "warnings": []
}
```

---

### `GET /passage` — Tagespassage

Die Buchpassage des Tages (deutsch + englisch) samt Lesestatus. Die Auswahl ist
deterministisch: dasselbe Datum liefert immer dieselbe Passage.

| Parameter | Typ | Default |
|---|---|---|
| `date` | `YYYY-MM-DD` | heute |

```json
{
  "ok": true,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "data": {
    "date": "2026-01-15",
    "available": true,
    "book": { "title": "Beispieltexte", "author": "Private OS", "year": 2026 },
    "chapter": "Desire",
    "chapter_number": 2,
    "text_de": "<deutscher Text der Passage>",
    "text_en": "<englischer Originaltext>",
    "words": 290,
    "read_minutes": 1,
    "read": false,
    "favorite": false,
    "summary": "Tagespassage für 2026-01-15 aus \"Beispieltexte\", Kapitel 2: Anfangen (1 Min. Lesezeit). Noch nicht gelesen."
  },
  "warnings": []
}
```

---

### `GET /xp` — XP & Level

| Parameter | Typ | Default | Bedeutung |
|---|---|---|---|
| `days` | `1`–`90` | `7` | Zeitfenster für die XP-Bilanz |

```json
{
  "ok": true,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "data": {
    "available": true,
    "level": 54,
    "total_xp": 84159,
    "xp_into_level": 946,
    "xp_needed_for_level": 5552,
    "xp_to_next_level": 4553,
    "level_progress_pct": 68.3,
    "period": { "days": 7, "gained_xp": 9897, "lost_xp": -18, "net_xp": 3842, "events": 46 },
    "recent_events": [
      { "date": "2026-01-15", "source": "Gym / Sport", "xp": 680 },
      { "date": "2026-01-15", "source": "Perfekter Tag", "xp": 138 },
      { "date": "2026-01-15", "source": "Meditation", "xp": 68 }
    ],
    "summary": "Level 54 mit 19.864 XP, noch 9.878 XP bis Level 39 (15,7 % geschafft). In den letzten 7 Tagen +2.276 XP verdient und -18 XP verloren, netto 3.822 XP."
  },
  "warnings": []
}
```

---

## Schreiben

Alle Schreib-Endpunkte brauchen `AGENT_API_WRITE_ENABLED=1` (siehe
[Schreibzugriff](#schreibzugriff)). Sie antworten in derselben Hülle wie die
Leseseite; `data` enthält den **resultierenden Zustand**. Habit- und
Zielantworten enthalten unter `xp`, was tatsächlich gutgeschrieben wurde.

### Planer / To-dos

`GET /todo` liefert `{ "tasks": [...], "count": 0, "summary": "..." }`.
Standardmäßig werden weich gelöschte Aufgaben ausgeblendet;
`?include_deleted=1` zeigt sie mit `deletedAt` für eine Wiederherstellung.

Filter halten den Kontext klein und lassen sich kombinieren:

| Parameter | Wirkung |
|---|---|
| `date=YYYY-MM-DD`, `date=today`, `date=tomorrow` | Nur Aufgaben an diesem Tag (Europe/Vienna), **inklusive** wiederkehrender. Jede Aufgabe trägt zusätzlich `doneOnDate`. |
| `open=1` | Nur offene Aufgaben; mit `date` bezogen auf diesen Tag. |
| `inbox=1` | Nur ungeplante Aufgaben der To-do-Liste (`date` = `null`). |

Beispiel „Was steht heute noch an?“: `GET /todo?date=today&open=1`.
Die Aufgaben stammen aus `private.todo_tasks` in Supabase. Die `id` ist eine
stabile UUID. Alle Daten des Planers, einschließlich Reihenfolge, Emoji,
Teilschritten, Wiederholung und erledigten Terminen, sind über diese API lesbar
und bearbeitbar.

| Feld | Typ | Standard | Bedeutung |
|---|---|---|---|
| `title` | Text, 1–300 Zeichen | Pflicht bei POST | Aufgabe; bestimmt automatisch Emoji und Cover-Thema, wenn diese fehlen |
| `priority` | `high` \| `medium` \| `low` \| `none` | `none` | Gruppe der To-do-Liste |
| `date` | `YYYY-MM-DD` oder `null` | `null` | Geplanter Tag; `null` legt die Aufgabe in die Seitenliste |
| `slot` | `anytime` \| `morning` \| `afternoon` \| `evening` | `anytime` | Tagesabschnitt (Jederzeit, Vormittag, Nachmittag, Abend) |
| `time` | `HH:MM` oder `null` | `null` | Optionale Startzeit (Europe/Vienna). Ohne Zeit gilt der Beginn des Abschnitts: 09:00 / 08:00 / 13:00 / 18:00 |
| `reminder` | Minuten 0–1440 oder `null` | `null`, mit `time` → `0` | Push-Erinnerung so viele Minuten vor dem Start; `null` = keine |
| `duration` | ganze Minuten, 1–1440 | `30` | Geplante Dauer |
| `repeat` | `none` \| `daily` \| `weekly` \| `monthly` | `none` | Wiederholung |
| `notes` | Text | `""` | Notizen |
| `subtasks` | `{id,title,done}[]` | `[]` | Teilschritte |
| `done` | boolean | `false` | Erledigtstatus für nicht wiederkehrende Aufgaben |
| `completedDates` | `YYYY-MM-DD[]` | `[]` | Erledigte Tage einer wiederkehrenden Aufgabe |
| `order` | Zahl | `0` | Reihenfolge beim Verschieben und Sortieren |
| `emoji`, `theme` | Symbol; `work` \| `finance` \| `creative` \| `health` \| `home` \| `learning` \| `general` | automatisch | Symbol und Farbton des Kreises. Ohne Angabe wählt der Server das Symbol aus dem Titel (über 100 Schlüsselwörter, Deutsch und Englisch); bei einer Umbenennung folgt ein automatisch gewähltes Symbol dem neuen Titel, ein von Hand gesetztes bleibt |

`POST /todo` akzeptiert diese Felder und optional eine eigene UUID `id`.
Wenn die UUID schon existiert, antwortet die API mit **409 `todo_exists`**.
`PATCH /todo` braucht `id` und mindestens ein Änderungsfeld. Beim Verschieben
oder Sortieren `date`, `slot`, `priority` und/oder `order` setzen. Der Browser
liest dieselben Supabase-Daten und zeigt Agent-Änderungen beim erneuten Öffnen
des Tabs oder beim Wechsel zurück zum Tab an.

```bash
curl -X POST -H "Authorization: Bearer $AGENT_API_TOKEN" \
     -H "content-type: application/json" \
     -d '{"title":"Angebot verschicken","priority":"high","date":"2026-09-24","slot":"morning"}' \
     https://<domain>/api/agent/v1/todo

curl -X PATCH -H "Authorization: Bearer $AGENT_API_TOKEN" \
     -H "content-type: application/json" \
     -d '{"id":"<UUID aus GET /todo>","done":true}' \
     https://<domain>/api/agent/v1/todo
```

```bash
# Termin mit Uhrzeit: erinnert standardmäßig zum Start, hier 15 Minuten vorher
curl -X POST -H "Authorization: Bearer $AGENT_API_TOKEN" \
     -H "content-type: application/json" \
     -d '{"title":"Agentur anrufen","date":"2026-09-26","slot":"morning","time":"10:30","reminder":15}' \
     https://<domain>/api/agent/v1/todo
```

#### Push-Erinnerungen

Aufgaben mit `date` und `reminder` lösen eine Web-Push-Mitteilung auf allen
Geräten aus, die im Planer über die Glocke aktiviert wurden (am iPhone nur in der
installierten Home-Bildschirm-App). Es wird nichts gepollt: Jedes Anlegen oder
Verschieben – auch über diese API – startet einen Vercel-Workflow, der bis zum
Erinnerungszeitpunkt schläft und dann die Aufgabe neu liest. Ist sie erledigt,
gelöscht oder inzwischen verschoben, bleibt er still; sonst geht genau eine
Mitteilung raus. Wiederkehrende Aufgaben planen danach den nächsten Termin.

Einmal täglich (~01:05 Wien, Vercel Cron) läuft `GET /api/cron/todo-reminders`
als Sicherheitsnetz: Es verschiebt offene Aufgaben auf den neuen Tag und plant
alle Erinnerungen der nächsten 26 Stunden neu ein. Doppelte Läufe schaden
nicht – jede Erinnerung wird pro Termin atomar genau einmal zugestellt.
`?dryRun=true` (mit `x-notify-secret`) zeigt, was eingeplant würde.

`DELETE /todo` mit `{ "id": "<UUID>" }` blendet die Aufgabe aus, behält den
Datensatz aber in Supabase. `POST /todo/restore` mit derselben `id` macht sie
wieder sichtbar. Beide brauchen aktivierten Schreibzugriff. Ein permanentes
Löschen bietet die Agenten-API nicht an.

### Warum das mehr ist als ein Datenbank-Update

Ein Habit abzuhaken ist im Dashboard nie nur ein Feld-Update: es berechnet
`bestDay` neu und vergibt XP, die mit der aktuellen Serie skaliert, plus einen
Perfect-Day-Bonus — beim Zurücknehmen entsprechend Strafpunkte. Diese Logik lag
bisher ausschließlich im Browser (`components/HabitsModal.tsx`,
`components/HabitCard.tsx`, `components/DailyReflection.tsx`). Sie ist jetzt nach
`lib/agent/write/habits.ts` und `lib/xpStore.ts` gezogen, damit ein
Schreibvorgang des Agenten exakt dieselben XP erzeugt wie ein Klick im
Dashboard. Ohne das würde dein Level still von der Realität wegdriften.

### Idempotenz

Zustände werden **explizit gesetzt, nicht umgeschaltet** (`"done": true`, nicht
"toggle"). XP hat pro Tag und Gewohnheit einen festen Idempotenz-Schlüssel —
denselben, den auch der Browser verwendet. Ein wiederholter Aufruf ist damit
folgenlos, und Dashboard und Agent können am selben Tag arbeiten, ohne XP
doppelt zu vergeben. Ein Aufruf, der nichts ändert, antwortet mit
`"changed": false` und schreibt gar nichts.

Steht in `xp` ein Eintrag mit `"duplicate": true`, gab es diese XP für den Tag
schon — der Agent sollte dann keinen Zugewinn vermelden.

### `POST /habits/toggle`

| Feld | Typ | Pflicht | Bedeutung |
|---|---|---|---|
| `habit` | `journaling`, `meditation`, `lesen`, `englisch`, `kreatin`, `vitamine`, `skincare`, `noPhone`, `noSugar` | ja | Schlüssel der Gewohnheit |
| `done` | boolean | ja | Zielzustand |
| `date` | `YYYY-MM-DD` | nein | Standard heute; Zukunft wird abgelehnt |

```bash
curl -X POST -H "Authorization: Bearer $AGENT_API_TOKEN" \
     -H "content-type: application/json" \
     -d '{"habit":"meditation","done":true}' \
     https://<domain>/api/agent/v1/habits/toggle
```

```json
{
  "ok": true,
  "generated_at": "2026-01-15T08:91:91+80:91",
  "source": "private-dashboard",
  "data": {
    "changed": true,
    "habit": "Meditation",
    "done": true,
    "streak_days": 4,
    "day": {
      "date": "2026-01-15",
      "perfect_day": false,
      "habits_done": 6,
      "habits_expected": 9,
      "habits_done_pct": 77.3,
      "completed": ["Journaling", "Meditation", "Kreatin", "Vitamine", "Skincare", "Kein Zucker"],
      "missing": ["Lesen", "Englisch lernen", "Kein Handy am Morgen"]
    },
    "xp": [ { "source": "meditation", "xp": 30, "duplicate": false } ]
  },
  "warnings": []
}
```

Ein Urlaubstag antwortet mit **409 `vacation_day`** — dort wird bewusst nicht
getrackt, und ein Eintrag würde die Quoten verfälschen.

### `POST /habits/weekly`

Zähler (`gym`, `sauna`) brauchen `value`, die Checkbox (`reflexion`) braucht
`done`. Der Wert gilt für die ISO-Woche des Datums und wird auf alle sieben Tage
geschrieben, damit die Daten lückenlos bleiben. XP fällt beim Erreichen bzw.
Unterschreiten des Wochenziels an, nicht bei jedem Schritt.

```json
{
  "ok": true,
  "data": {
    "changed": true,
    "habit": "Gym / Sport",
    "iso_week_dates": ["2026-01-15", "2026-01-15"],
    "previous_value": 2,
    "value": 3,
    "target": 3,
    "met": true,
    "xp": [ { "source": "gym", "xp": 680, "duplicate": false } ]
  },
  "warnings": []
}
```

### `POST /habits/day`

Stimmung (`mood`, 1–10), freie `note` und die vier Journal-Felder
`grateful_for`, `intention`, `done_well`, `better_tomorrow`. Sobald ein
Journal-Feld gefüllt wird, hakt das die Gewohnheit "Journaling" automatisch mit
ab (kann also einen perfekten Tag vervollständigen) und vergibt die
Reflexions-XP — dieselbe Regel wie auf der Startseite. `note` allein ist
XP-neutral.

```json
{
  "ok": true,
  "data": {
    "changed": true,
    "journaling_auto_checked": true,
    "day": { "date": "2026-01-15", "perfect_day": false, "habits_done": 7, "habits_expected": 9 },
    "journal": { "intention": "<…>", "grateful_for": "<…>" },
    "xp": [
      { "source": "journaling", "xp": 97, "duplicate": false },
      { "source": "daily_reflection", "xp": 88, "duplicate": false }
    ]
  },
  "warnings": []
}
```

### `POST /goals` — Ziel anlegen

| Feld | Typ | Pflicht | Standard |
|---|---|---|---|
| `title` | string | ja | – |
| `period` | `month` \| `week` | nein | `month` |
| `month` | `YYYY-MM` | nein | aktueller Monat |
| `category` | `Business` \| `Health` \| `Personal` \| `Sonstiges` | nein | – |
| `pinned` | boolean | nein | `false` |

```json
{
  "ok": true,
  "data": {
    "created": true,
    "goal": {
      "id": "8fynFMC8fGotNzYsxvHg",
      "title": "<Zieltitel>",
      "period": "Monat",
      "period_start": "2026-01-15",
      "category": "Personal",
      "status": "offen",
      "pinned": false
    }
  },
  "warnings": []
}
```

### `PATCH /goals` — Ziel ändern

Braucht `id` (kommt aus `GET /goals`) und mindestens eines von `status`,
`title`, `category`, `pinned`. Der Wechsel auf `erledigt` gibt +35 XP, der
Wechsel auf `abgebrochen` −150.

```json
{
  "ok": true,
  "data": {
    "changed": true,
    "previous_status": "offen",
    "goal": { "id": "8fynFMC8fGotNzYsxvHg", "title": "<Zieltitel>", "status": "erledigt", "period": "Monat", "period_start": "2026-01-15" },
    "xp": [ { "source": "goal_completed", "xp": 64, "duplicate": false } ]
  },
  "warnings": []
}
```

### Bewusst NICHT schreibbar

| Bereich | Grund |
|---|---|
| Endgültiges Löschen | To-dos können weich gelöscht und wiederhergestellt werden; kein Agent-Endpunkt löscht Daten permanent. |
| Finanzen (außer Trades) | Nur Kauf, Verkauf und Dividende lassen sich über `POST /finance/trades` buchen. Löschen, Ändern, Cash-Konten, Edelmetalle, Sparplan, Sparziele und Einkommen bleiben schreibgeschützt. |
| Urlaubsmodus | Verändert rückwirkend Serien und Erfüllungsquoten über einen ganzen Zeitraum hinweg. |
| Reflexionen | Liegen in Notion. Lesen ja, schreiben nein — eine externe Datenbank ist kein Ort für automatische Schreibzugriffe. |
| Abonnements | Notion ist die Quelle der Wahrheit; auch das Dashboard schreibt dort nicht hinein. |
| Zukünftige Tage | Ein Eintrag für morgen würde jede Erfüllungsquote verfälschen, die "noch nicht passiert" von "verpasst" unterscheidet. |

---

## Bewusst NICHT über die API verfügbar

| Domäne | Grund |
|---|---|
| CRM | Existiert in diesem Dashboard nicht. Kunden- und Kontaktdaten liegen ausschließlich im Firmen-Dashboard. |
| Time Tracking | Es gibt keine Zeiterfassung in diesem Dashboard. |
| Projekte | Werden hier nicht geführt — es gibt nur Ziele (`/goals`). |
| Externer Kalender | Kein Kalenderdienst angebunden. Geplante Aufgaben stehen unter `/todo`, Abbuchungen unter `/subscriptions`. |
| Reisen | Die Reisen-Erweiterung des Dashboards ist stillgelegt — es gibt keine Reisedaten mehr abzurufen. Die Route wurde entfernt, nicht nur leer gelassen. |
| Körperbefund-Langzeitreport | Die vollständige Neuberechnung über Jahre von WHOOP-Rohdaten (`whoop_cycles/_sleeps/_workouts/_journal`) bleibt der Dashboard-Ansicht vorbehalten — sie lädt mehrere tausend Zeilen pro Aufruf. Über `/health` gibt es stattdessen Snapshot, Zeitraum-Durchschnitte, Trends und die Blutwerte. |
| OAuth-Tokens & Zugangsdaten | WHOOP-Tokens, Notion-Keys und Supabase-Credentials werden nie ausgeliefert. |
| Interne IDs | Notion-Page-IDs, Supabase-`doc_id`s und Firestore-Style-IDs sind aus den Responses entfernt. |
| Rohdaten-Dumps | Die API liefert aufbereitete Werte, keine 1:1-Kopien der Tabellen. |

---

## Deployment

### Env-Variable setzen

### Token erzeugen

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

In Vercel eintragen (Production, Preview und Development):

```bash
vercel env add AGENT_API_TOKEN production
```

Alternativ im Vercel-Dashboard unter **Settings → Environment Variables** die
Variable `AGENT_API_TOKEN` mit dem generierten Wert anlegen. Danach neu
deployen, damit die Variable in der Runtime ankommt.

Lokal steht derselbe Wert in `.env.local`; `.env.example` enthält die
Kopiervorlage.

### Schreibzugriff aktivieren

Zusätzlich zum Token:

```bash
vercel env add AGENT_API_WRITE_ENABLED production
```

Wert: `1`. Fehlt die Variable, bleibt die API für den Agenten rein lesend —
alle Schreib-Endpunkte antworten dann mit 403.

### Middleware

`/api/agent/*` ist im `matcher` in [`middleware.ts`](middleware.ts) von der
PIN-Session ausgenommen — die Routen prüfen ihren Bearer-Token selbst.

### Smoke-Test nach dem Deploy

```bash
curl -s -H "Authorization: Bearer $AGENT_API_TOKEN" https://<domain>/api/agent/v1/index | head -c 400
```
