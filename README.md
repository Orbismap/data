# Orbis Data

Datenpipelines, Worker und Speicher für [Orbis](https://github.com/malte9799/orbis). Dieses Repo ersetzt
die Branches `data` und `data-osm` sowie die von Hand ins Dashboard kopierten Worker aus dem Orbis-Repo.

Stand: Phase 1 (Fundament) plus Uhr-Worker `orbis-clock`. Die übrigen Worker sind mit wrangler-Configs übernommen (Verhalten unverändert);
Collectors und Workflows folgen in den nächsten Phasen.

## Architektur

```
Cloudflare Cron (1 Worker "orbis-clock", */1 min)
 ├─ leichte Jobs direkt: Upstream → R2 (Body durchreichen, kein Parsen → kaum CPU)
 └─ schwere Jobs: repository_dispatch → GitHub Actions in Orbismap/data
                                            └─ Ergebnis → R2 (aws s3 / wrangler r2)
R2-Buckets ──(Custom Domain, CDN-Cache)──> Browser
Worker (Proxy, Push, Camdir) ──> D1 statt KV-Single-Keys
```

- Uhr = Cloudflare Cron (pünktlich), Rechenleistung = GitHub Actions (per `repository_dispatch` sofort gestartet).
- R2 hinter einer Custom Domain: Egress kostenlos, Requests laufen über den Cloudflare-Cache und zählen nicht als Worker-Requests. `r2.dev` wird nicht genutzt.

## Buckets

Hosts einstufig unter `*.maltee.dev` (das kostenlose Zertifikat deckt nur eine Ebene ab).

| Bucket | Host | Inhalt | Cache-Control | Aufräumen |
|---|---|---|---|---|
| `orbis-live` | `orbis-live.maltee.dev` | Minuten-/Stundensnapshots, überschrieben | `max-age=60` bis `600` je Pfad, `stale-while-revalidate` | überschreibt sich selbst |
| `orbis-data` | `orbis-data.maltee.dev` | täglich/wöchentlich: Zeugen-Karte, Vulkane, Radio, Kabel, Cams, PeeringDB, Wahlen, Häfen ... | `max-age=3600`, `stale-while-revalidate=86400` | Lifecycle: `archive/` nach 30 Tagen |
| `orbis-osm` | `orbis-osm.maltee.dev` | Geofabrik-Kacheln (heute Branch `data-osm`) | `max-age=86400` | Workflow ersetzt Region komplett |
| `orbis-wetter` | `orbis-wetter.maltee.dev` | ICON-Wetterfelder (`v1/<run>/<var>/*.owx`, `v1/latest.json`) | Runs immutable, `latest.json` 120 s | Workflow behält 2 Runs (+ Lifecycle 7 Tage) |
| `orbis-assets` | `orbis-assets.maltee.dev` | `models/`, `textures/`, große Teile von `public/data` | `immutable` unter Hash-Pfaden, `index.json` kurz | Lifecycle: nicht mehr referenzierte Hash-Pfade nach 90 Tagen |

- Pro Bucket ein eigenes R2-API-Token (Actions-Jobs bekommen nur Schreibrecht auf "ihren" Bucket).
- CORS je Bucket: `GET`/`HEAD` von der App-Domain und `http://localhost:5173`.
- Jeder Bucket hat eine `manifest.json` (Pfad → `updated`, `etag`, `bytes`, `source`, `license`).
- `wx-worker.js` wird **nicht** migriert: Der Wetter-Bucket ist direkt über die Custom Domain `orbis-wetter.maltee.dev` erreichbar, der alte Worker und der alte Bucket werden nach der Umstellung gelöscht.

## Worker

Der `name` in jeder `wrangler.jsonc` entspricht dem bereits deployten Worker, damit die `workers.dev`-URLs gleich bleiben. `keep_vars: true` sorgt dafür, dass im Dashboard gesetzte Variablen Deploys überleben; Secrets bleiben ohnehin erhalten. Variablen stehen in den Configs nur als Kommentar.

| Ordner | Worker-Name | URL | Bindings / Trigger | Dashboard-Variablen |
|---|---|---|---|---|
| `workers/proxy` | `orbis` | `https://orbis.malte9799.workers.dev/` | - | `ALLOWED_ORIGINS`, optional `AISSTREAM_KEY` |
| `workers/push` | `orbis-trains` | `https://orbis-trains.malte9799.workers.dev/` | KV `PUSH_KV` (`orbis-push`), Cron `* * * * *` | `DB_CLIENT_ID`, `DB_API_KEY`, `VAPID_PUBLIC`, `VAPID_PRIVATE`, `VAPID_SUBJECT`, optional `ALLOWED_ORIGINS`, `DB_TIMETABLES_BASE` |
| `workers/camdir` | `orbis-cams` | `https://orbis-cams.malte9799.workers.dev/` | KV `CAMDIR` (`orbis_cams`) | `ADMIN_TOKEN`, optional `ALLOWED_ORIGINS` |
| `workers/clock` | `orbis-clock` | keine (`workers_dev: false`, `fetch` antwortet 404) | R2 `LIVE` (`orbis-live`), Cron `* * * * *` | optional Secret `GH_DISPATCH_TOKEN` (erst für GitHub-Actions-Jobs) |

Geplant: D1 statt KV für `push` und `camdir`.

### Jobs der Uhr (`orbis-live`)

Die Jobs stehen als Tabelle `JOBS` in `workers/clock/src/index.js` (id, url, key, every, type, cache, license). Ein Job läuft, wenn `(Minute des Tages + Hash(id)) % every === 0`; der Hash verteilt die Jobs über die Minuten (aktuell höchstens 9 Jobs pro Minute, Budget-Grenze 40 Subrequests). Pro Job: `HEAD` auf das alte Objekt, bedingte Anfrage (`If-None-Match`/`If-Modified-Since`), bei 304 kein Schreibzugriff; sonst `put` ohne Parsen. Fehler lassen das alte Objekt stehen. `manifest.json` wird nach jedem Lauf mit Schreibzugriff aus `list()` neu gebaut. Cache-Control der Objekte: `public, max-age=<every·30 s, min. 60>, stale-while-revalidate=<every·240 s>`.

| Job | Schlüssel in `orbis-live` | alle (min) | Lizenz |
|---|---|---|---|
| `usgs-quakes` | `events/usgs-2.5_week.geojson` | 5 | USGS, gemeinfrei |
| `emsc-quakes` | `events/emsc-europe.json (Europa-BBox, 7 Tage, M ≥ 1,5, Fenster wird pro Lauf berechnet)` | 5 | CC BY 4.0 |
| `gdacs` | `events/gdacs.json` | 5 | GDACS, Namensnennung |
| `eonet` | `events/eonet.json` | 5 | NASA, gemeinfrei |
| `nws-*` | `events/nws/<event>.geojson (7 Ereignistypen wie in der App)` | 5 | NOAA/NWS, gemeinfrei |
| `tsunami-paaq/pheb` | `tsunami/PAAQ.xml, tsunami/PHEB.xml` | 5 | NOAA, gemeinfrei |
| `swpc-ovation/kp/xrays` | `space/swpc/ovation_aurora_latest.json, noaa-planetary-k-index.json, xrays-1-day.json` | 5 | NOAA SWPC, gemeinfrei |
| `ndbc-latest` | `ocean/ndbc-latest_obs.txt` | 10 | NOAA NDBC, gemeinfrei |
| `nhc-*` | `cyclones/nhc-{point,fcst,cone,pastpt,past}.geojson` | 10 | NOAA NHC/CPHC, gemeinfrei |
| `ll2-upcoming, ll2-tracker` | `space/launches/upcoming.json (limit=40), space/launches/tracker.json (limit=20)` | 10 (je 6/h, zusammen 12/h von 15/h) | The Space Devs, Free-Tier, Namensnennung „The Space Devs“ |
| `celestrak-*` | `space/tle/{stations,visual,weather,science,gps-ops,galileo,starlink}.txt` | 120 | CelesTrak, frei, Namensnennung |

Nicht gespiegelt: NOAA-Sonnenwind `plasma-2-hour.json`/`mag-2-hour.json` (liefern upstream 404, Ersatz wären `json/rtsw/rtsw_wind_1m.json` und `rtsw_mag_1m.json`, 1,4–2,4 MB), NWS pro Punkt (`alerts/active?point=`), alles mit Schlüssel.

**Grenzen der Uhr:** Worst case ohne 304 rund 7.284 Jobläufe/Tag, das sind etwa 219.000 Class-A-Writes pro Monat plus rund 86.000 für Manifest (`list` + `put`), zusammen rund 0,3 Mio von 1 Mio. `HEAD` je Joblauf zählt als Class B (etwa 219.000/Monat von 10 Mio). Subrequests pro Minute (Fetch, `HEAD`, `put`, Manifest): höchstens 9 Jobs × 3 + 2 = 29 von 50. CelesTrak liefert bei zu häufigem Abruf (innerhalb von 2 h) HTTP 403; Takt nicht verkürzen.

Lokal alle Jobs einmal ausführen: `pnpm exec wrangler dev -c workers/clock/wrangler.jsonc --test-scheduled --var RUN_ALL:1`, dann `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`.

Lokal prüfen (ohne Deploy):

```sh
pnpm install
pnpm exec wrangler deploy --dry-run -c workers/proxy/wrangler.jsonc --outdir /pfad/zum/tempverzeichnis
```

## Free-Tier-Limits im Blick behalten

Stand 2026-11, gegen Cloudflare-Doku prüfen.

| Dienst | Limit (Free) |
|---|---|
| R2 | 10 GB Speicher, 1 Mio Class-A- und 10 Mio Class-B-Operationen pro Monat, Egress frei |
| Workers | 100.000 Requests/Tag, 10 ms CPU pro Aufruf, 50 Subrequests pro Aufruf |
| KV | 1.000 Writes/Tag |
| D1 | 5 GB Speicher |
| Cron-Trigger | 5 pro Konto (Free), belegt: `orbis-trains`, `orbis-clock` (gegen Doku prüfen) |

Nach einer Woche Betrieb sollen R2- und Workers-Nutzung im Dashboard unter 50 % der Limits liegen.

## Deployment der Worker

`.github/workflows/deploy-workers.yml` rollt bei Push auf `main` nur die Worker aus, deren Ordner sich geändert hat (oder alle bei Änderung von `package.json`/Lockfile/Workflow). Manuell: *Actions → Deploy Workers → Run workflow*.

Benötigte GitHub-Secrets (Repo oder Organisation):

| Secret | Inhalt |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API-Token mit *Workers Scripts: Edit*, *Workers KV Storage: Edit*, *Workers R2 Storage: Edit*, *D1: Edit*, *Account Settings: Read*; Zone: *Workers Routes: Edit* (maltee.dev) |
| `CLOUDFLARE_ACCOUNT_ID` | Konto-ID aus dem Dashboard |

API-Token anlegen:

1. Cloudflare-Dashboard → *My Profile → API Tokens → Create Token* (alternativ Vorlage "Edit Cloudflare Workers" verwenden und prüfen).
2. *Create Custom Token*, Berechtigungen (Account-Ebene): *Workers Scripts → Edit*, *Workers KV Storage → Edit*, *Workers R2 Storage → Edit* (R2-Binding des Clock-Workers), *D1 → Edit* (spätere Migration von Push/Camdir), *Account Settings → Read*; auf Zonen-Ebene *Workers Routes → Edit* (maltee.dev, späteres App-Hosting unter maltee.dev/orbis).
3. *Account Resources*: nur das eigene Konto; kein Ablaufdatum oder ein langes, das du dir notierst.
4. Token einmalig kopieren und im Repo unter *Settings → Secrets and variables → Actions* als `CLOUDFLARE_API_TOKEN` speichern.
5. Konto-ID (Dashboard → *Workers & Pages*, rechte Seitenleiste) als `CLOUDFLARE_ACCOUNT_ID` speichern.

Später kommen R2-Tokens je Bucket und ein GitHub-Token für den Dispatch (Secret im Clock-Worker) dazu.

## Neue Datenquelle hinzufügen

1. **Lizenz zuerst prüfen.** Darf die Quelle gespeichert und weitergegeben werden? Lizenz und Namensnennung in `manifest.json` und `docs/DATENQUELLEN.md` (Orbis-Repo) eintragen. Bei unklaren Fällen nicht speichern, sondern live über den Proxy abfragen.
2. **Frequenzgruppe wählen:**
   - Cloudflare-Uhr direkt (rohe Spiegel, kein Parsen, Ziel `orbis-live`): `live-5m`, `live-10m`, `live-2h`
   - GitHub Actions per Dispatch: `live-15m`, `live-1h`, `daily`, `weekly`, `manual` (`workflow_dispatch`, z. B. Wahlen)
3. **Ziel-Bucket** festlegen (`orbis-live`, `orbis-data`, `orbis-osm`, `orbis-wetter`, `orbis-assets`) und Cache-Control passend zur Frequenz setzen.
4. **Task eintragen:** Clock-Worker-Liste bzw. Collector in `collectors/` (Gruppen-Einstiegspunkt), Ausgabe nach R2.
5. **Manifest-Eintrag** schreiben (`updated`, `etag`, `bytes`, `source`, `license`).
6. In Orbis einen Snapshot-Leser einbauen (Snapshot zuerst, Live als Fallback) und die Quelle in `docs/DATENQUELLEN.md` dokumentieren.

## Bewusst nicht gespeichert

- Blitzer.de-Markers (inoffiziell, keine Nutzungsbedingungen)
- Blitzortung (Genehmigung ausstehend)
- NINA (BBK, warnung.bund.de): keine Lizenz bzw. Nutzungsbedingungen auffindbar, Regel „unklar → nicht gespeichert“; bleibt live über den Proxy
- Kacheln von Esri, RainViewer und OpenFreeMap
- Flugdaten von adsb.lol/OpenSky/ADS-B allgemein (bleiben über den Proxy mit kurzem TTL)
- alles mit Nutzer-Key (Windy, TomTom, OWM u. ä.)
- Archive Genocide (nur Proxy, solange keine Lizenz geklärt ist)
