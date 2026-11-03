# Orbis Data

Datenpipelines, Worker und Speicher für [Orbis](https://github.com/malte9799/orbis). Dieses Repo ersetzt
die Branches `data` und `data-osm` sowie die von Hand ins Dashboard kopierten Worker aus dem Orbis-Repo.

Stand: Phase 1 (Fundament), Uhr-Worker `orbis-clock` und die bestehenden Sammler (`collectors/`, Workflows `live-15m`, `daily`, `weekly`, `osm-tiles`, `wetter`). Die übrigen Worker sind mit wrangler-Configs übernommen (Verhalten unverändert);
neue Quellen (Open-Meteo-Gitter, PeeringDB, Wikidata, WRI, Autobahn …) folgen in der nächsten Phase.

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
| `orbis-osm` | `orbis-osm.maltee.dev` | OSM-Punktdaten als PMTiles (`<set>.pmtiles` ×6, `heat/cctv.json`, `meta.json`, Zwischendateien `src/`), siehe Abschnitt „OSM-Punktdaten (PMTiles)“ | PMTiles/Heat `max-age=86400`, `meta.json` `max-age=3600` | Build ersetzt die Dateien; alte JSON-Kacheln werden gelöscht |
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
| `workers/clock` | `orbis-clock` | keine (`workers_dev: false`, `fetch` antwortet 404) | R2 `LIVE` (`orbis-live`), Cron `* * * * *` | Secret `GH_DISPATCH_TOKEN` (startet die GitHub-Actions-Sammler, siehe [Sammler](#sammler-collectors-und-github-actions)); ohne Secret loggt die Uhr das einmal und spiegelt weiter |

Geplant: D1 statt KV für `push` und `camdir`.

### Jobs der Uhr (`orbis-live`)

Die Jobs stehen als Tabelle `JOBS` in `workers/clock/src/index.js` (id, url, key, every, type, cache, license). Ein Job läuft, wenn `(Minute des Tages + Hash(id)) % every === 0`; der Hash verteilt die Jobs über die Minuten (aktuell höchstens 9 Jobs pro Minute, Budget-Grenze 40 Subrequests). Pro Job: `HEAD` auf das alte Objekt, bedingte Anfrage (`If-None-Match`/`If-Modified-Since`), bei 304 kein Schreibzugriff; sonst `put` ohne Parsen. Fehler lassen das alte Objekt stehen. `manifest.json` wird nach jedem Lauf mit Schreibzugriff aus `list()` neu gebaut (Quelle/Lizenz der von GitHub Actions geschriebenen Schlüssel kommen aus der alten Manifest-Datei). Cache-Control der Objekte: `public, max-age=<every·30 s, min. 60>, stale-while-revalidate=<every·240 s>`.

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

**Grenzen der Uhr:** Worst case ohne 304 rund 7.284 Jobläufe/Tag, das sind etwa 219.000 Class-A-Writes pro Monat plus rund 86.000 für Manifest (`list` + `put`), zusammen rund 0,3 Mio von 1 Mio. `HEAD` je Joblauf zählt als Class B (etwa 219.000/Monat von 10 Mio). Subrequests pro Minute (Fetch, `HEAD`, `put`, Manifest): höchstens 9 Jobs × 3 + 3 (Manifest: `get`, `list`, `put`) + 1 Dispatch = 31 von 50. CelesTrak liefert bei zu häufigem Abruf (innerhalb von 2 h) HTTP 403; Takt nicht verkürzen.

Lokal alle Jobs einmal ausführen: `pnpm exec wrangler dev -c workers/clock/wrangler.jsonc --test-scheduled --var RUN_ALL:1`, dann `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`.

Lokal prüfen (ohne Deploy):

```sh
pnpm install
pnpm exec wrangler deploy --dry-run -c workers/proxy/wrangler.jsonc --outdir /pfad/zum/tempverzeichnis
```

## Sammler (collectors und GitHub Actions)

Die Cloudflare-Uhr (`workers/clock`) startet die Workflows per `repository_dispatch` (Tabelle `DISPATCH`, Zeiten in UTC). Die Workflows haben **keinen** `schedule`-Trigger und lassen sich zusätzlich per *Run workflow* starten.

| Workflow (`event_type`) | Dispatch (UTC) | Sammler | Ziel-Bucket | Timeout |
|---|---|---|---|---|
| `live-15m.yml` (`live-15m`) | :07, :22, :37, :52 | `fetch-data.ts --group live-15m` | `orbis-live` | 35 min |
| `daily.yml` (`daily`) | täglich 03:05 | `fetch-data.ts --group daily` | `orbis-data` | 35 min |
| `weekly.yml` (`weekly`) | montags 04:05 | `fetch-data.ts --group weekly` | `orbis-data` | 60 min |
| `osm-tiles.yml` (`osm-tiles`) | täglich 03:17 | `osm-tiles.mjs` (`plan` → `extract` je Region → `build`; eine Region ≥ 30 Tage alt, oder alle mit `all_regions`) | `orbis-osm` | je Job 350 min |
| `wetter.yml` (`wetter`) | 03:20, 09:20, 15:20, 21:20 | `wetter-icon.py` (+ `wetter-dem.py` auf Wunsch) | `orbis-wetter` (`vars.R2_BUCKET_WETTER`) | 60 min |

Aufgaben der Gruppen von `collectors/fetch-data.ts` (ein Task schreibt nur seine Dateien; scheitert er, bleiben die alten Objekte stehen, denn der Upload löscht nie):

| Gruppe | Task → Dateien in R2 |
|---|---|
| `live-15m` | `safecast` → `safecast.json`; `radiation` → `bfs-odl.json`, `eurdep.json`; `firms` → `firms/world.json` (nur mit `FIRMS_MAP_KEY`); `demos` → `demos.json` |
| `daily` | `ukraine-harm` → `ukraine-harm.json`; `ipc-gaza` → `ipc-gaza.json`; `gaza-hdx` → `gaza-displacement.json`, `healthsites-pse.json`; `ukraine-oblast` → `ukraine-oblast.json`; `osm-cables` → `osm-cables/`; `volcanoes` → `volcanoes.json`; `radio` → `radio/top.json`, `radio/cells/*.json`; `mars` → `mars/traverse.json`; `cams` → `cams/<feed>.json`; `cams-world` → `cams/world.json`; dazu `meta.json` (Zeitstempel, `camFeeds`) |
| `weekly` | `ccc-us` → `ccc-us.json`; `ukraine-support` → `ukraine-support.json`; `osm-datacenters` → `osm-datacenters/`; `street-panos` → `street/panos.json` (nur mit `MAPILLARY_TOKEN`) |

Tsunami-XML ist **kein** Sammler-Task: die Uhr spiegelt `tsunami/PAAQ.xml` und `tsunami/PHEB.xml` alle 5 min nach `orbis-live`. Die Dateipfade sind dieselben wie bisher im `data`-Branch (`src/api/data.ts` der App liest sie unverändert); `orbis-osm` enthält PMTiles (siehe Abschnitt „OSM-Punktdaten (PMTiles)“).

**Hilfsskripte:**

- `collectors/build.mjs` bündelt `fetch-data.ts` mit esbuild nach `dist/fetch-data.mjs`. `fetch-data.ts` nutzt dieselben Loader wie die App (`src/api/camfeeds.ts`, `earth.ts`, `cams.ts`, `events.ts`) und importiert sie als `@orbis/api/<name>`; esbuild löst `@orbis` auf `<ORBIS_SRC>/src` auf. `ORBIS_SRC` ist die Wurzel eines Checkouts von `malte9799/orbis` (Standard `./orbis`, in den Workflows der zweite `actions/checkout` mit `orbis_ref`, Standard `main`; nur `src` und `public/data/games` werden ausgecheckt). Der Checkout braucht kein `node_modules`: Paketimporte werden aus diesem Repo aufgelöst (`@mapbox/vector-tile`, `pbf` stehen deshalb in `package.json`).
- `collectors/upload.sh <dir> <bucket> <cache-control>` lädt per `aws s3 sync` (ohne `--delete`) hoch und merged die `manifest.json` des Buckets (herunterladen, `collectors/manifest.mjs`, hochladen). Ohne R2-Zugangsdaten wird nur gewarnt. `--replace-dirs` (osm-tiles) ersetzt Verzeichnisse komplett, `--collapse-manifest` fasst Kachelordner zu einem Eintrag zusammen.
- `collectors/manifest.mjs`: Eintrag je Schlüssel `{updated, bytes, source, license}`; Quellen und Lizenzen stehen in der Tabelle `RULES` (aus `docs/DATENQUELLEN.md` der App). Für `orbis-live` bleiben die Einträge der Uhr erhalten; umgekehrt übernimmt die Uhr beim Neuaufbau `source`/`license` fremder Schlüssel aus der alten Manifest-Datei.

Cache-Control beim Upload: `orbis-live` `public, max-age=300, stale-while-revalidate=1800`; `orbis-data` `public, max-age=3600, stale-while-revalidate=86400`; `orbis-osm` PMTiles/Heat/Lizenz `public, max-age=86400`, `meta.json` `public, max-age=3600`, `src/` `no-store`; `orbis-wetter` wie bisher je Schlüssel (Läufe `public, max-age=31536000, immutable`, `latest.json` `public, max-age=120`, `v1/static` `public, max-age=86400`).

**Lokal ausführen** (ohne Upload, ohne Secrets; Quellen mit Schlüssel werden übersprungen):

```sh
pnpm install
git clone https://github.com/malte9799/orbis ../orbis      # Checkout daneben (oder ORBIS_SRC=/pfad/zu/orbis)
ORBIS_SRC=../orbis pnpm collect --group live-15m --out ./out
ORBIS_SRC=../orbis pnpm collect --group daily --out ./out --only volcanoes,mars   # --only: einzelne Tasks
node collectors/manifest.mjs ./out - ./out-manifest.json                           # Manifest-Test
```

Ohne `ORBIS_SRC` erwartet `build.mjs` den Checkout unter `./orbis` (so wie in CI). `osm-tiles.mjs` braucht `osmium` und `tippecanoe` und lädt einen Geofabrik-Auszug (siehe „OSM-Punktdaten (PMTiles)“, lokal mit einem kleinen Auszug testen); `wetter-icon.py` braucht `pip install -r collectors/wetter-requirements.txt`.

### OSM-Punktdaten (PMTiles)

`collectors/osm-tiles.mjs` (Workflow `osm-tiles`) macht aus den Geofabrik-Auszügen sechs Datensätze, jeweils **eine PMTiles-Datei weltweit** in `orbis-osm` (Layername = Datensatz, Zoom 0–14, nur Knoten, ODbL):

| Datei | Inhalt |
|---|---|
| `cctv.pmtiles` | Überwachungskameras (`man_made=surveillance` ohne ALPR/Webcams) |
| `blitzer.pmtiles` | Blitzer und Rotlichtkameras (`highway=speed_camera`, Art über `type=enforcement`-Relationen) |
| `alpr.pmtiles` | Kennzeichenleser (`surveillance:type=ALPR`) |
| `webcam.pmtiles` | Webcams mit Link |
| `wind.pmtiles` | einzelne Windräder |
| `resource.pmtiles` | Schächte, Stollen, Bohrlöcher, Steinbrüche, Bergwerke, Öl/Gas/Raffinerien |
| `heat/cctv.json` | Dichte-Zellen `[lon, lat, anzahl]` (0,01°) der ganzen Welt für die CCTV-Heatmap |
| `meta.json` | `format: 5`, je Region Bauzeit und Zähler (`regions`), je Datensatz Größe/Anzahl (`sets`) |
| `LICENSE.txt` | ODbL-Hinweis |
| `src/<region>/<set>.geojsonl`, `src/<region>/info.json` | Zwischendateien (Newline-delimited GeoJSON, je Region), Eingabe des Builds; `info.json` = Bauzeit der Region |

Die Eigenschaften der Features sind die Felder der früheren Kachel-Datensätze (`FIELDS` im Sammler, `src/api/osmtiles.ts` der App baut daraus wieder die Arrays); Felder mit Standardwert (`dir` -1, Flags 0, leere Texte) fehlen. tippecanoe-Optionen: `-Z0 -z14 -r1 -b0 --drop-densest-as-needed -M 1000000 -O 250000` (Punkte werden nur ausgedünnt, wo eine Kachel zu groß wird; in den hohen Zoomstufen bleiben alle). Die App liest mit HTTP-Range-Anfragen (`pmtiles`-Bibliothek) und nimmt diese Quelle, wenn `VITE_OSM_BASE` gesetzt ist (z. B. `https://orbis-osm.maltee.dev/`).

**Ablauf** (`osm-tiles.yml`): `plan` liest `src/*/info.json` und wählt die älteste Region, die älter als 30 Tage ist (Format-Wechsel zählt als veraltet) – oder alle 8 bei `all_regions`; `extract` läuft je Region als eigener Matrix-Job (osmium streamt den Auszug, Ausgabe nach `src/<region>/`, `info.json` zuletzt); `build` lädt `src/` aller Regionen, baut die sechs PMTiles mit tippecanoe (2.79.0, aus dem Quelltext gebaut und gecacht) und `heat/cctv.json`, lädt alles hoch und löscht die alten JSON-Kacheln (`cctv-*`, `blitzer-*` …). Eine Region wird ersetzt, indem ihre Zwischendateien ersetzt werden, die PMTiles entstehen immer aus allen Regionen.

**Erster Lauf / leerer Bucket:** *Actions → OSM tiles → Run workflow* mit `all_regions` = true (alle 8 Regionen parallel, Europa ~3 h; die Jobs tauschen Daten über den Bucket aus, R2-Secrets sind Pflicht). Danach genügt der tägliche Dispatch der Uhr.

**Lokal testen** (kleiner Auszug, `brew install osmium-tool tippecanoe pmtiles`):

```bash
node collectors/osm-tiles.mjs extract ./osm-test bremen --url https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf
node collectors/osm-tiles.mjs build ./osm-test/src ./osm-test/dist     # ./osm-test/dist/*.pmtiles, heat/cctv.json, meta.json
pmtiles show ./osm-test/dist/cctv.pmtiles
node collectors/osm-tiles.mjs plan ./osm-test [region|all]             # welche Regionen wären fällig
```

Die App-Seite lokal: `VITE_OSM_BASE=http://localhost:8080/` setzen und `dist` mit einem Server ausliefern, der Range-Anfragen und CORS (`Access-Control-Allow-Origin`, `Range` erlaubt, `ETag` freigegeben) beherrscht.

### Benötigte Secrets und Variablen (Repository `Orbismap/data`, *Settings → Secrets and variables → Actions*)

| Name | Art | Wofür |
|---|---|---|
| `R2_ACCOUNT_ID` | Secret | Cloudflare-Konto-ID für den S3-Endpunkt `https://<id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Secret | R2-S3-Token mit Schreibrecht auf `orbis-live`, `orbis-data`, `orbis-osm`, `orbis-wetter` (getrennte Tokens je Bucket brauchen getrennte Secret-Namen, dann in den Workflows anpassen) |
| `FIRMS_MAP_KEY`, `NPS_API_KEY`, `WINDY_KEY`, `VICTORIA_KEY`, `CTA_KEY`, `TRAFIKLAB_KEY`, `TRAFIKVERKET_KEY`, `UTAH_511_API_KEY`, `ARIZONA_511_API_KEY`, `IDAHO_511_API_KEY`, `NEVADA_511_API_KEY`, `ALASKA_511_API_KEY`, `GEORGIA_511_API_KEY`, `LOUISIANA_511_API_KEY`, `PENNSYLVANIA_511_API_KEY`, `OHGO_API_KEY`, `QLDTRAFFIC_KEY`, `ONTARIO_511_API_KEY`, `ALBERTA_511_API_KEY` | Secret | API-Schlüssel der Datenquellen, aus `malte9799/orbis` kopieren (gleiche Namen wie in der alten `data.yml`) |
| `MAPILLARY_TOKEN` | Secret (oder Variable) | Street-Panos; Workflow liest `secrets.MAPILLARY_TOKEN \|\| vars.MAPILLARY_TOKEN` |
| `R2_BUCKET_WETTER`, `WETTER_PUBLIC_URL` | Variable, optional | Standard `orbis-wetter` und `https://orbis-wetter.maltee.dev` |
| `GH_DISPATCH_TOKEN` | **Secret des Clock-Workers** (kein GitHub-Secret): `pnpm exec wrangler secret put GH_DISPATCH_TOKEN -c workers/clock/wrangler.jsonc` | Fine-grained Personal Access Token: *Repository access* nur `Orbismap/data`, Berechtigung *Contents: Read and write*. Das verlangt `POST /repos/{owner}/{repo}/dispatches` laut GitHub-Doku (fine-grained: „Contents“ write). Der Token muss der Org gehören bzw. von ihr zugelassen sein (Org-Einstellung für Fine-grained PATs). |

`repository_dispatch`-Workflows laufen nur aus der Datei auf dem Standard-Branch (`main`); neue Workflows greifen also erst nach dem Merge. Fehlt `malte9799/orbis` die öffentliche Lesbarkeit, braucht der zweite `actions/checkout` zusätzlich einen `token`.

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

Die Secrets für Sammler und Dispatch stehen im Abschnitt [Sammler](#sammler-collectors-und-github-actions).

## Neue Datenquelle hinzufügen

1. **Lizenz zuerst prüfen.** Darf die Quelle gespeichert und weitergegeben werden? Lizenz und Namensnennung in `manifest.json` und `docs/DATENQUELLEN.md` (Orbis-Repo) eintragen. Bei unklaren Fällen nicht speichern, sondern live über den Proxy abfragen.
2. **Frequenzgruppe wählen:**
   - Cloudflare-Uhr direkt (rohe Spiegel, kein Parsen, Ziel `orbis-live`): `live-5m`, `live-10m`, `live-2h`
   - GitHub Actions per Dispatch (Tabelle `DISPATCH` im Clock-Worker): `live-15m`, `live-1h`, `daily`, `weekly`, `manual` (`workflow_dispatch`, z. B. Wahlen)
3. **Ziel-Bucket** festlegen (`orbis-live`, `orbis-data`, `orbis-osm`, `orbis-wetter`, `orbis-assets`) und Cache-Control passend zur Frequenz setzen.
4. **Task eintragen:** Clock-Worker-Liste bzw. `await task('<name>', '<gruppe>', …)` in `collectors/fetch-data.ts` (Gruppe = Workflow), Ausgabe nach R2; Quelle und Lizenz in `RULES` von `collectors/manifest.mjs`.
5. **Manifest-Eintrag** schreibt `upload.sh` automatisch (`updated`, `bytes`, `source`, `license`); `RULES` ergänzen.
6. In Orbis einen Snapshot-Leser einbauen (Snapshot zuerst, Live als Fallback) und die Quelle in `docs/DATENQUELLEN.md` dokumentieren.

## Bewusst nicht gespeichert

- Blitzer.de-Markers (inoffiziell, keine Nutzungsbedingungen)
- Blitzortung (Genehmigung ausstehend)
- NINA (BBK, warnung.bund.de): keine Lizenz bzw. Nutzungsbedingungen auffindbar, Regel „unklar → nicht gespeichert“; bleibt live über den Proxy
- Kacheln von Esri, RainViewer und OpenFreeMap
- Flugdaten von adsb.lol/OpenSky/ADS-B allgemein (bleiben über den Proxy mit kurzem TTL)
- alles mit Nutzer-Key (Windy, TomTom, OWM u. ä.)
- Archive Genocide (nur Proxy, solange keine Lizenz geklärt ist)
