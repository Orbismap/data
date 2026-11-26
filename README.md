# Orbis Data

Datenpipelines, Worker und Speicher für [Orbis](https://github.com/malte9799/orbis). Dieses Repo ersetzt
die Branches `data` und `data-osm` sowie die von Hand ins Dashboard kopierten Worker aus dem Orbis-Repo.

Stand: Phase 1 (Fundament), Uhr-Worker `orbis-clock` und die bestehenden Sammler (`collectors/`, Workflows `live-15m`, `daily`, `weekly`, `osm-planet`, `wetter`). Die übrigen Worker sind mit wrangler-Configs übernommen (Verhalten unverändert);
neue Quellen folgen in der nächsten Phase. Bewusst **nicht** gespiegelt (Lizenz unklar bzw. Weitergabe untersagt, App ruft live ab): PeeringDB (AUP: Daten dürfen nicht in Masse weitergegeben werden) und Autobahn-API (keine Lizenzangabe der Autobahn GmbH).

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
| `orbis-osm` | `orbis-osm.maltee.dev` | OSM-Daten als PMTiles (`<thema>-<datum>.pmtiles` ×8, `heat/cctv.json`, `meta.json` mit den aktuellen Dateinamen, `LICENSE.txt`), siehe Abschnitt „OSM-Daten (PMTiles)“ | PMTiles/Heat `max-age=86400`, `meta.json` `max-age=3600` | Jeder Lauf schreibt neue, datierte Dateien; die abgelösten werden nach 24 h gelöscht (im Dauerzustand eine Datei je Thema) |
| `orbis-wetter` | `orbis-wetter.maltee.dev` | ICON-Wetterfelder (`v1/<run>/<var>/*.owx`, `v1/latest.json`) | Runs immutable, `latest.json` 120 s | Workflow behält 2 Runs (+ Lifecycle 7 Tage) |
| `orbis-assets` | `orbis-assets.maltee.dev` | `models/`, `textures/`, große Teile von `public/data` | `immutable` unter Hash-Pfaden, `index.json` kurz | Lifecycle: nicht mehr referenzierte Hash-Pfade nach 90 Tagen |

- Pro Bucket ein eigenes R2-API-Token (Actions-Jobs bekommen nur Schreibrecht auf "ihren" Bucket).
- CORS je Bucket (alle fünf identisch, per `wrangler r2 bucket cors set`): `AllowedOrigins *`, Methoden `GET`/`HEAD`, erlaubte Header `*` (u. a. `Range` für PMTiles), freigegeben `ETag`, `Content-Length`, `Content-Range`, `Last-Modified`, `MaxAge 86400`. Die Daten sind öffentlich und ohne Cookies, daher kein Origin-Filter. Cloudflare-CDN-Antworten, die vor der Änderung gecacht wurden, haben den Header evtl. erst nach Ablauf der TTL.
- Jeder Bucket hat eine `manifest.json` (Pfad → `updated`, `etag`, `bytes`, `source`, `license`).
- `wx-worker.js` wird **nicht** migriert: Der Wetter-Bucket ist direkt über die Custom Domain `orbis-wetter.maltee.dev` erreichbar, der alte Worker und der alte Bucket werden nach der Umstellung gelöscht.

## Worker

Der `name` in jeder `wrangler.jsonc` entspricht dem bereits deployten Worker, damit die `workers.dev`-URLs gleich bleiben. `keep_vars: true` sorgt dafür, dass im Dashboard gesetzte Variablen Deploys überleben; Secrets bleiben ohnehin erhalten. Variablen stehen in den Configs nur als Kommentar.

| Ordner | Worker-Name | URL | Bindings / Trigger | Dashboard-Variablen |
|---|---|---|---|---|
| `workers/proxy` | `orbis` | `https://orbis.malte9799.workers.dev/` | - | `ALLOWED_ORIGINS`, optional `AISSTREAM_KEY` |
| `workers/push` | `orbis-trains` | `https://orbis-trains.malte9799.workers.dev/` | D1 `DB` (`orbis-push`), Cron `* * * * *` | `DB_CLIENT_ID`, `DB_API_KEY`, `VAPID_PUBLIC`, `VAPID_PRIVATE`, `VAPID_SUBJECT`, optional `ALLOWED_ORIGINS`, `DB_TIMETABLES_BASE` |
| `workers/camdir` | `orbis-cams` | `https://orbis-cams.malte9799.workers.dev/` | D1 `DB` (`orbis-camdir`) | `ADMIN_TOKEN`, optional `ALLOWED_ORIGINS` |
| `workers/clock` | `orbis-clock` | keine (`workers_dev: false`, `fetch` antwortet 404) | R2 `LIVE` (`orbis-live`), Cron `* * * * *` | Secret `GH_DISPATCH_TOKEN` (startet die GitHub-Actions-Sammler, siehe [Sammler](#sammler-collectors-und-github-actions)); ohne Secret loggt die Uhr das einmal und spiegelt weiter |

### D1 (Push und Camdir)

| Datenbank | ID | Worker-Binding | Migrationen |
|---|---|---|---|
| `orbis-push` (weur) | `aa4b53d8-a690-4130-81ec-a36b01dd2d11` | `DB` in `workers/push` | `workers/push/migrations/` |
| `orbis-camdir` (weur) | `207c8fd0-555f-4268-aff6-888053ef9fbb` | `DB` in `workers/camdir` | `workers/camdir/migrations/` |

Schema `orbis-push`: `subscriptions(id PK, endpoint UNIQUE, keys JSON, tz, created_at, updated_at)`, `trips(sub_id, trip_key, data JSON, notify_at; PK (sub_id, trip_key); Index auf notify_at)`, `sent(sub_id, key, sent_at; PK (sub_id, key); Index auf sent_at)`, `meta(k, v)`. `notify_at` ist der Beginn des nächsten noch offenen Meldefensters der Fahrt (Abfahrt minus größte Vorlaufzeit, wöchentlich wiederkehrend, Zeitzone der Fahrt); der Cron liest pro Minute nur Fahrten mit `notify_at <= jetzt` und setzt `notify_at` danach auf das nächste Fenster. Schema `orbis-camdir`: `dirs(key PK, value JSON, updated_at)`, `meta(k, v)`. Die HTTP-Schnittstellen und Antworten sind unverändert; jeder Schreibzugriff betrifft nur die Zeilen eines Abos bzw. einer Kamera (kein Lesen-Ändern-Schreiben eines Gesamtobjekts mehr).

Migrationen anlegen und anwenden (CI macht das vor jedem Deploy von `push`/`camdir` automatisch):

```sh
pnpm exec wrangler d1 migrations apply orbis-push --remote -c workers/push/wrangler.jsonc
pnpm exec wrangler d1 migrations apply orbis-camdir --remote -c workers/camdir/wrangler.jsonc
# lokal (wrangler dev): dasselbe mit --local
```



D1-Free-Limits: 5 Mio. gelesene Zeilen und 100.000 geschriebene Zeilen pro Tag, 5 GB Speicher, 50 Abfragen pro Worker-Aufruf. Verbrauch: der Push-Cron liest dank `notify_at` nur Fahrten mit offenem Meldefenster (plus je eine Abfrage für `sent`-Aufräumen), Schreibzugriffe nur bei Sendungen, Abo-Änderungen und dem Weiterschieben von `notify_at`. `GET /dirs` liest alle Zeilen von `dirs` (bei 20.000 Einträgen = 20.000 Zeilen pro Aufruf, ca. 250 Aufrufe/Tag bis zum Limit; heute sind es deutlich weniger Einträge); der Browser darf die Antwort 60 s cachen.

Tests: `pnpm test` (Node 22.5+; `workers/d1-fake.ts` führt die Migrationen gegen `node:sqlite` aus).

### Jobs der Uhr (`orbis-live`)

Die Jobs stehen als Tabelle `JOBS` in `workers/clock/src/index.js` (id, url, key, every, type, cache, license). Ein Job läuft, wenn `(Minute des Tages + Hash(id)) % every === 0`; der Hash verteilt die Jobs über die Minuten (aktuell höchstens 5 Jobs pro Minute, Budget-Grenze 40 Subrequests). Pro Job: `HEAD` auf das alte Objekt, bedingte Anfrage (`If-None-Match`/`If-Modified-Since`), bei 304 kein Schreibzugriff; sonst `put` ohne Parsen. Fehler lassen das alte Objekt stehen. `manifest.json` wird nach jedem Lauf mit Schreibzugriff aus `list()` neu gebaut (Quelle/Lizenz der von GitHub Actions geschriebenen Schlüssel kommen aus der alten Manifest-Datei). Cache-Control der Objekte: `public, max-age=<every·30 s, min. 60>, stale-while-revalidate=<every·240 s>`.

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

Nicht gespiegelt: NOAA-Sonnenwind `plasma-2-hour.json`/`mag-2-hour.json` (liefern upstream 404, Ersatz wären `json/rtsw/rtsw_wind_1m.json` und `rtsw_mag_1m.json`, 1,4–2,4 MB), NWS pro Punkt (`alerts/active?point=`), alles mit Schlüssel.

**Grenzen der Uhr:** Worst case ohne 304 rund 5.472 Jobläufe/Tag, das sind etwa 164.000 Class-A-Writes pro Monat plus rund 86.000 für Manifest (`list` + `put`), zusammen rund 0,25 Mio von 1 Mio. `HEAD` je Joblauf zählt als Class B (etwa 164.000/Monat von 10 Mio). Subrequests pro Minute (Fetch, `HEAD`, `put`, Manifest): höchstens 5 Jobs × 3 + 3 (Manifest: `get`, `list`, `put`) + 1 Dispatch = 19 von 50.

**Nicht auf der Uhr (GitHub Actions, Gruppe `live-15m`):** Launch Library 2 (`space/launches/upcoming.json`, `tracker.json`; 15 Requests/h pro IP) und CelesTrak (`space/tle/{stations,visual,weather,science,gps-ops,galileo,starlink}.txt`; HTTP 403 bei wiederholtem Abruf je IP) lieferten über die geteilten Cloudflare-Egress-IPs HTTP 429/403. Die Tasks `ll2-upcoming`/`ll2-tracker` (jeder Lauf, 2 Requests je 15 min = 8/h) und `celestrak` (nur im :07-Lauf geradzahliger UTC-Stunden, also alle 2 h; `--force-celestrak` bzw. Workflow-Input `force_celestrak` erzwingt) in `collectors/fetch-data.ts` schreiben die rohen Antworten unverändert unter dieselben Schlüssel. Fehlschlag oder ungültige Antwort (leer, TLE ohne Namenszeile, LL2 ohne `results`) lässt das alte Objekt stehen. Cache-Control: LL2 `public, max-age=300, stale-while-revalidate=1800`, `space/tle/` `public, max-age=3600, stale-while-revalidate=14400` (`collectors/upload.sh`, Option `--cache-prefix`).

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
| `opensky.yml` (`opensky`) | stündlich, :03 | `opensky-loop.mjs` (Schleife, siehe [OpenSky-Schleife](#opensky-schleife-flugzeug-überblick)) | `orbis-live` | 360 min |
| `barentswatch.yml` (`barentswatch`) | stündlich, :04 | `barentswatch-loop.mjs` (Schleife, siehe [BarentsWatch-Schleife](#barentswatch-schleife-schiffe-norwegen)) | `orbis-live` | 360 min |
| `live-1h.yml` (`live-1h`) | :12, alle 2 h (gerade UTC-Stunden) | `fetch-data.ts --group live-1h` | `orbis-live` | 20 min |
| `daily.yml` (`daily`) | täglich 03:05 | `fetch-data.ts --group daily` | `orbis-data` | 35 min |
| `weekly.yml` (`weekly`) | montags 04:05 | `fetch-data.ts --group weekly` | `orbis-data` | 60 min |
| `manual.yml` (nur *Run workflow*, kein Dispatch) | – | `fetch-data.ts --group manual` | `orbis-data` | 30 min |
| `osm-planet.yml` (`osm-planet`) | monatlich (1., 03:17), auf Anforderung | `osm-tiles.mjs` (`build` in zwei Jobs, `nodes` und `roofs`, parallel → `publish`; Planet-Download vom schnellsten Mirror) | `orbis-osm` (nur die Welt-Dateien) | je Job ~95 min gemessen, Limit 360 min |
| `karte.yml` (`karte`) | manuell, bei Änderung von `collectors/karte/`, monatlich (nur `overlay`) | `collectors/karte/build-data.sh` (siehe [Karten-Daten](#karten-daten-orbis-karte)) | `orbis-osm` unter `karte/` | je Job 240 min |
| `wetter.yml` (`wetter`) | 03:20, 09:20, 15:20, 21:20 | `wetter-icon.py` (+ `wetter-dem.py` auf Wunsch) | `orbis-wetter` (`vars.R2_BUCKET_WETTER`) | 60 min |

Aufgaben der Gruppen von `collectors/fetch-data.ts` (ein Task schreibt nur seine Dateien; scheitert er, bleiben die alten Objekte stehen, denn der Upload löscht nie):

| Gruppe | Task → Dateien in R2 |
|---|---|
| `live-15m` | `safecast` → `safecast.json`; `radiation` → `bfs-odl.json`, `stuk-fi.json`, `hc-ca.json`; `firms` → `firms/world.json` (nur mit `FIRMS_MAP_KEY`); `demos` → `demos.json` |
| `live-1h` | `openmeteo-grid` → `openmeteo/global.json` (Open-Meteo-Modellraster der Weltkugel, 408 Punkte × 10 Variablen × 24 Dreistundenschritte, kompaktes JSON ~380 KB / ~110 KB gzip; 5 Multi-Location-Requests = 408 API-Aufrufe je Lauf, also bei stündlichem Lauf ~9 800/Tag bei Limit 10 000/Tag je IP, daher Lauf nur alle 2 h (~4 900/Tag); 429 pro Minute wird mit Wartezeit wiederholt). Die App liest die Datei über `VITE_LIVE_BASE` und fällt nach 3 h Alter oder bei Fehler auf Live-Abrufe zurück; das Regionalraster der Vorhersagekarte hängt vom Kartenausschnitt ab und bleibt Live-Abruf. Wetterdaten von Open-Meteo.com, CC BY 4.0 (Namensnennung nötig, kostenlose API nur nicht-kommerziell). Der Task wird übersprungen, wenn `src/api/omgrid.ts` im orbis-Checkout fehlt. |
| `daily` | `ukraine-harm` → `ukraine-harm.json`; `ipc-gaza` → `ipc-gaza.json`; `gaza-hdx` → `gaza-displacement.json`, `healthsites-pse.json`; `ukraine-oblast` → `ukraine-oblast.json`; `osm-cables` → `osm-cables/`; `volcanoes` → `volcanoes.json`; `wikidata-resources` → `wikidata/resources.json` (Bergwerke, Öl-/Gas-/Kohlefelder aus Wikidata per SPARQL, CC0, Zeilen `[lon,lat,Q-Id,Name,Klasse,Produkte]`; die App liest sie vor dem Live-Query); `radio` → `radio/top.json`, `radio/cells/*.json`; `mars` → `mars/traverse.json`; `cams` → `cams/<feed>.json`; `cams-world` → `cams/world.json`; dazu `meta.json` (Zeitstempel, `camFeeds`) |
| `weekly` | `ccc-us` → `ccc-us.json`; `ukraine-support` → `ukraine-support.json`; `osm-datacenters` → `osm-datacenters/`; `wri-powerplants` → `wri/powerplants.json` (WRI Global Power Plant Database, CC BY 4.0, nur die gerenderten Spalten als Zeilen `[lon,lat,MW,Brennstoff,Name,Land,Jahr,Eigentümer,URL]`, statt 12 MB CSV je Browser); `street-panos` → `street/panos.json` (nur mit `MAPILLARY_TOKEN`) |
| `manual` | selten wechselnde Quellen, nur per Actions → *manual* → *Run workflow* (Input `group`, Standard `manual`): `ports` → `ports.json` (Häfen-Ebene: NGA World Port Index, US-Regierungswerk ohne Urheberrechtsanspruch, + Upply Seaports, CC BY 4.0; Format `{v:1, ports:[[lon,lat,Name,UN/LOCODE,Land,Stufe,…]]}` wie früher `public/data/ports.json`; Logik in `collectors/ports.mjs`); `wahlen` → `wahlen/de.json` + `wahlen/de-geo.json` (Wahlen-Ebene: GERDA Bundestagswahlen CC BY 4.0, Landtagswahlen aus der Regionaldatenbank Deutschland dl-de/by-2-0 (via GERDA), auf Bundesländer aggregiert; Umrisse BKG VG2500 dl-de/by-2-0; Logik in `collectors/wahlen.mjs`) |

Tsunami-XML ist **kein** Sammler-Task: die Uhr spiegelt `tsunami/PAAQ.xml` und `tsunami/PHEB.xml` alle 5 min nach `orbis-live`. Die Dateipfade sind dieselben wie bisher im `data`-Branch (`src/api/data.ts` der App liest sie unverändert); `orbis-osm` enthält PMTiles (siehe Abschnitt „OSM-Daten (PMTiles)“).

**Hilfsskripte:**

- `collectors/build.mjs` bündelt `fetch-data.ts` mit esbuild nach `dist/fetch-data.mjs`. `fetch-data.ts` nutzt dieselben Loader wie die App (`src/api/camfeeds.ts`, `earth.ts`, `cams.ts`, `events.ts`) und importiert sie als `@orbis/api/<name>`; esbuild löst `@orbis` auf `<ORBIS_SRC>/src` auf. `ORBIS_SRC` ist die Wurzel eines Checkouts von `malte9799/orbis` (Standard `./orbis`, in den Workflows der zweite `actions/checkout` mit `orbis_ref`, Standard `main`; nur `src` und `public/data/games` werden ausgecheckt). Der Checkout braucht kein `node_modules`: Paketimporte werden aus diesem Repo aufgelöst (`@mapbox/vector-tile`, `pbf` stehen deshalb in `package.json`).
- `collectors/upload.sh <dir> <bucket> <cache-control>` lädt per `aws s3 sync` (ohne `--delete`) hoch und merged die `manifest.json` des Buckets (herunterladen, `collectors/manifest.mjs`, hochladen). Ohne R2-Zugangsdaten wird nur gewarnt. `--replace-dirs` (osm-tiles) ersetzt Verzeichnisse komplett, `--collapse-manifest` fasst Kachelordner zu einem Eintrag zusammen.
- `collectors/manifest.mjs`: Eintrag je Schlüssel `{updated, bytes, source, license}`; Quellen und Lizenzen stehen in der Tabelle `RULES` (aus `docs/DATENQUELLEN.md` der App). Für `orbis-live` bleiben die Einträge der Uhr erhalten; umgekehrt übernimmt die Uhr beim Neuaufbau `source`/`license` fremder Schlüssel aus der alten Manifest-Datei.

Cache-Control beim Upload: `orbis-live` `public, max-age=300, stale-while-revalidate=1800` (`space/tle/` `public, max-age=3600, stale-while-revalidate=14400`); `orbis-data` `public, max-age=3600, stale-while-revalidate=86400`; `orbis-osm` PMTiles/Heat/Lizenz `public, max-age=86400`, `meta.json` `public, max-age=3600`, `src/` `no-store`; `orbis-wetter` wie bisher je Schlüssel (Läufe `public, max-age=31536000, immutable`, `latest.json` `public, max-age=120`, `v1/static` `public, max-age=86400`).

**Lokal ausführen** (ohne Upload, ohne Secrets; Quellen mit Schlüssel werden übersprungen):

```sh
pnpm install
git clone https://github.com/malte9799/orbis ../orbis      # Checkout daneben (oder ORBIS_SRC=/pfad/zu/orbis)
ORBIS_SRC=../orbis pnpm collect --group live-15m --out ./out
ORBIS_SRC=../orbis pnpm collect --group daily --out ./out --only volcanoes,mars   # --only: einzelne Tasks
node collectors/manifest.mjs ./out - ./out-manifest.json                           # Manifest-Test
```

Ohne `ORBIS_SRC` erwartet `build.mjs` den Checkout unter `./orbis` (so wie in CI). `osm-tiles.mjs` braucht `osmium` und `tippecanoe` und lädt den Planeten (oder nimmt `--pbf`) (siehe „OSM-Daten (PMTiles)“, lokal mit einem kleinen Auszug testen); `wetter-icon.py` braucht `pip install -r collectors/wetter-requirements.txt`.

### OpenSky-Schleife (Flugzeug-Überblick)

Der weltweite Flugzeug-Überblick der App kommt aus **einem** zentralen OpenSky-Abruf statt aus einem Abruf je Besucher. OpenSky blockt Cloudflare (der Proxy-Worker bekommt 522) und sendet kein CORS für fremde Origins; direkt aus dem Browser geht es also auch nicht.

- `collectors/opensky-loop.mjs` (Workflow `opensky.yml`) holt `https://opensky-network.org/api/states/all?extended=1` mit OAuth2 (Client Credentials, Token-Endpunkt `auth.opensky-network.org/.../openid-connect/token`, Token ~30 min, Erneuerung 2 min vor Ablauf und bei 401) **alle 90 s** (gemessen ab Abrufbeginn, kein Aufsummieren der Laufzeit) und lädt die rohe Antwort gzip-komprimiert als `aircraft/opensky-states.json` nach `orbis-live` (`Content-Encoding: gzip`, `Cache-Control: public, max-age=60, stale-while-revalidate=120`, rund 275 KB). Die App liest die Datei mit dem vorhandenen Parser `openskyStates`.
- **Credits:** ein weltweites `states/all` kostet 4 Credits, das Tageskontingent ist 4000 → höchstens 1000 Abrufe/Tag (alle 86 s). Bei 90 s sind es 960 Abrufe = 3840 Credits/Tag. Das Intervall fällt auch per Konfiguration nie unter 90 s. Bei 429 wartet die Schleife `X-Rate-Limit-Retry-After-Seconds`; je Runde steht `X-Rate-Limit-Remaining` im Log.
- **Fehler:** Eine fehlgeschlagene Runde (HTTP-Fehler, leere/zu kurze Liste < 500 Flugzeuge, Zeitfeld `time` älter als 10 min) lässt das alte Objekt stehen. 12 Fehlrunden in Folge (~18 min) beenden den Lauf mit Fehler; der nächste stündliche Dispatch startet eine neue Schleife.
- **Laufzeit und Überlappung:** Eine Schleife läuft 350 min (`LOOP_MINUTES`, Job-Limit 360) und endet sauber. Die Uhr dispatcht `opensky` **stündlich** (:03). Der Workflow hat `concurrency: opensky` ohne Abbruch: ein Dispatch während einer laufenden Schleife wartet, GitHub hält nur **einen** wartenden Lauf (neuere ersetzen ihn, diese Läufe erscheinen als „cancelled“, die Gesundheitsprüfung ignoriert sie). Der wartende Lauf startet sofort, wenn die Schleife endet (keine Lücke); eine früh gestorbene Schleife wird innerhalb einer Stunde ersetzt. Zwei Schleifen laufen nie gleichzeitig, das würde die Credits verdoppeln. Eine neue Schleife prüft zudem das Alter des Objekts und wartet bis zu 90 s, falls der letzte Abruf jünger ist. Ein manueller Lauf (*Run workflow*) wartet ebenfalls in der Gruppe.
- **Manifest:** `aircraft/opensky-states.json` wird in der ersten Runde und danach etwa alle 6 min in `manifest.json` eingetragen (nicht bei jedem Abruf). `health.mjs` verlangt ein Alter ≤ 15 min.
- **Secrets** (*Settings → Secrets and variables → Actions*): `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` (API-Client des OpenSky-Kontos), dazu die vorhandenen `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (Schreibrecht auf `orbis-live`). Danach die Uhr neu deployen (`pnpm deploy:clock`), damit der Dispatch `opensky` startet; der Workflow muss auf `main` liegen.
- **Testlauf:** *Actions → OpenSky loop → Run workflow* (Branch `main`). Im Log sollten nach wenigen Sekunden `credits remaining: …` und `round 0: … uploaded` stehen. `token HTTP 401/403` = falsche Client-Daten; `states HTTP 403` oder Zeitüberschreitung (`TimeoutError`) = OpenSky blockt die GitHub-Runner-IPs; `rate limited` = Tageskontingent verbraucht (Testlauf kostet 4 Credits je Runde, danach den Lauf abbrechen). Ohne OpenSky-Secrets (lokal, Forks) macht das Skript nur einen anonymen Abruf nach `--out` (`node collectors/opensky-loop.mjs --out ./out/aircraft`) und lädt nichts hoch.
- **Lizenz:** OpenSky Network, frei für Forschung und nicht-kommerzielle Nutzung, Namensnennung (Schäfer et al., IPSN 2014), Bedingungen: https://opensky-network.org/about/terms-of-use. Das ist keine offene Lizenz im Sinn von CC; eine kommerzielle Nutzung bräuchte Rücksprache mit OpenSky. Der Eintrag im Manifest steht in `RULES` (`collectors/manifest.mjs`).

### BarentsWatch-Schleife (Schiffe Norwegen)

Die Schiffe vor Norwegen (Kystverket-Landstationen, Equinor-Offshore-Stationen, norwegische Satelliten) kommen aus **einem** zentralen BarentsWatch-Abruf. Die API braucht einen OAuth2-Client, dessen Secret nie in den Browser darf; außerdem reicht so ein Abruf für alle Besucher.

- `collectors/barentswatch-loop.mjs` (Workflow `barentswatch.yml`) holt `https://live.ais.barentswatch.no/v1/latest/combined?since=<jetzt − 30 min>&modelType=Full&modelFormat=Json` (Token: `POST https://id.barentswatch.no/connect/token`, `grant_type=client_credentials`, `scope=ais`, Token 1 h, Erneuerung 5 min vor Ablauf und bei 401) **alle 60 s** und lädt die rohe Antwort (JSON-Array `AisComboFull`: Position + Stammdaten je MMSI) gzip-komprimiert als `ais/barentswatch-latest.json` nach `orbis-live` (`Cache-Control: public, max-age=45, stale-while-revalidate=120`). Die App liest sie mit dem Parser `barentswatchLatest`.
- **Abdeckungsgebiet:** Zu Beginn jedes Laufs holt die Schleife `v1/openaisarea` (GeoJSON-MultiPolygon, gleiches Token) und legt es als `ais/barentswatch-area.json` ab (`Cache-Control: max-age=21600`). Die App zeichnet es als gestrichelte Umrandung. Schlägt der Abruf fehl, bleibt das alte Gebiet stehen; die Positionen laufen weiter.
- **Abdeckung:** norwegische Wirtschaftszone, Fischereischutzzone Svalbard, Schutzzone Jan Mayen; ohne Fischereifahrzeuge unter 15 m und Freizeitboote unter 45 m (Vorgabe von BarentsWatch).
- **Fehler:** Eine fehlgeschlagene Runde (HTTP-Fehler, weniger als 100 Schiffe, neueste Meldung älter als 15 min) lässt das alte Objekt stehen. 15 Fehlrunden in Folge beenden den Lauf; der nächste stündliche Dispatch (:04) startet eine neue Schleife. Überlappung wie bei OpenSky über `concurrency: barentswatch`.
- **Secrets:** `BARENTSWATCH_CLIENT_ID` (Form `email:clientname`), `BARENTSWATCH_CLIENT_SECRET`: auf barentswatch.no registrieren, unter *Min side → API-tilgang* einen Client für die **AIS**-API anlegen. Danach die Uhr neu deployen (`pnpm deploy:clock`); der Workflow muss auf `main` liegen.
- **Testlauf:** *Actions → BarentsWatch loop → Run workflow*. Im Log sollte `round 0: … ships … uploaded` stehen; `token HTTP 400/401` = falsche Client-Daten oder falscher Scope. Ohne Secrets beendet sich das Skript sofort (die API kennt keinen anonymen Zugang).
- **Lizenz:** NLOD 2.0 (Norsk lisens for offentlige data), Quellenangabe „BarentsWatch / Kystverket“. Bedingungen: https://www.barentswatch.no/en/articles/api-terms-and-conditions/

### OSM-Daten (PMTiles)

`collectors/osm-tiles.mjs` (Workflow `osm-planet`) macht aus dem OSM-Planeten acht Themen und drei Netzpläne, jeweils **eine PMTiles-Datei weltweit** in `orbis-osm` (Layername = Thema, bei den Netzplänen `lines`, `labels`, `stations`; ODbL). Die Themen stehen in der **Registry** `collectors/osm-themes.mjs`: ein Thema = ein Eintrag (Datei, Layer, Geometrieart `point`/`line`/`polygon`, osmium-Filter, Zuordnung der Felder, Zoombereich, Release-Gruppe). Ein neues Thema braucht keine neue Pipeline, nur diesen Eintrag (und ggf. einen Test).

| Datei (`<thema>-<datum>.pmtiles`) | Inhalt |
|---|---|
| `cctv` | Überwachungskameras (`man_made=surveillance` ohne ALPR/Webcams), Zoom 0–14 |
| `blitzer` | Blitzer und Rotlichtkameras (`highway=speed_camera`, Art über `type=enforcement`-Relationen), Zoom 0–14 |
| `alpr` | Kennzeichenleser (`surveillance:type=ALPR`), Zoom 0–14 |
| `webcam` | Webcams mit Link, Zoom 0–14 |
| `wind` | einzelne Windräder, Zoom 0–14 |
| `resource` | Schächte, Stollen, Bohrlöcher, Steinbrüche, Bergwerke, Öl/Gas/Raffinerien, Zoom 0–14 |
| `trees` | **zwei Ebenen**, nur Zoom 15 (darüber überzoomt die Karte), für die 3D-Ansicht. Ebene `trees`: einzelne Bäume (`natural=tree`, Knoten), Felder `species`, `height` (m, 0,1), `circumference` (m, 0,01), `leaf_type` (`broadleaved`/`needleleaved`/`mixed`/`leafless`), `leaf_cycle` (`deciduous`/`evergreen`/`semi_deciduous`/`semi_evergreen`); **kein** `id`, **kein** `genus` (die App leitet es aus `species` ab). Ebene `tree_lines`: Baumreihen (`natural=tree_row`) und Hecken (`barrier=hedge`) als LineString (auf ~1 m vereinfacht, ≤ 5 Nachkommastellen), Felder `kind` (`row`/`hedge`, immer gesetzt), `species` (nur Reihen), `height`, `leaf_type`, `leaf_cycle`. Fehlende Werte werden weggelassen. Flächen, Wald und `natural=scrub` fehlen. Die Linien sind an Kachelgrenzen geschnitten (ohne Puffer) |
| `roofs` | **neu**, nur Zoom 15: Gebäude und Gebäudeteile (`building`, `building:part`, Wege und Multipolygone) mit mindestens einem Dachtag (`roof:shape`, `roof:height`, `roof:levels`, `roof:colour`, `roof:material`, `roof:angle`) als Polygone, Ebene `roofs`. Eigenschaften = die OSM-Schlüssel selbst, Werte als Text (die App reicht sie als `tags` an `buildBuilding` weiter): `building`, `building:part`, `height`, `building:height`, `min_height`, `building:levels`, `building:min_level`, `roof:levels`, `roof:shape` (klein geschrieben), `roof:height`, `roof:direction`, `roof:orientation`, `roof:angle`, `roof:colour`, `roof:material`, `building:colour`, `colour`, `building:material`, `material` (nur gesetzte; Werte über 40 Zeichen entfallen). **Ganze Gebäude, jedes in genau einer Kachel** (tippecanoe `--no-clipping --no-duplication`, Koordinaten dürfen deshalb über den Kachelrand hinausgehen): die App legt die Dachebenen über das Rechteck um den Grundriss, ein Teilstück würde das Dach verziehen. Teile ohne Dachtag und alle Basis-Gebäude bleiben bei OpenFreeMap. Doppelte Gebäude über Kachelgrenzen gibt es nicht |
| `netz-region`, `netz-stadt`, `netz-stadt-tram` | Netzpläne des Schienenverkehrs (`collectors/netzplan.mjs`), Zoom 6–12: Regional- und S-Bahn bzw. S-, U- und Stadtbahn (mit/ohne Tram). Aus den Linien-Relationen (`route=train/subway/light_rail/tram/monorail`) und ihren Haltepunkten, ohne Gleisgeometrie: Linien laufen gerade von Station zu Station, parallel nach Farben. Ebenen `lines` (`id`, `color`, `refs`, `mode`, `off` = Versatz in Strangbreiten), `labels` (ab Zoom 9: `id`, `refs`, `color`, `n`), `stations` (ab Zoom 8: `id` = OSM-Knoten, `name`, `refs`, `n`, `rank` 2 Umstieg/1 Endstation/0, `end0`..`end3` + `color0`..`color3`) |
| `heat/cctv.json` | Dichte-Zellen `[lon, lat, anzahl]` (0,01°) der ganzen Welt für die CCTV-Heatmap |
| `meta.json` | `format: 9`, `version` (Datum), **`files`**: aktueller Dateiname je Thema (`{ "roofs": "roofs-2026-12-03.pmtiles", … }`), `sets`: je Thema `bytes`, `features` (bei `trees` zusätzlich `layers`), `regions` (1, bleibt für die App), `oldest`/`newest` (Datum der Planet-Daten), `retired`: abgelöste Dateien mit Zeitpunkt (werden nach 24 h gelöscht) |
| `LICENSE.txt` | ODbL-Hinweis |

**Dateinamen und Cache:** Die Dateien tragen das Datum des Build-Laufs im Namen, die App liest den Namen aus `meta.json` (`max-age=3600`). So mischen sich CDN-gecachte Range-Bytes (24 h) nie mit neuen Daten: eine neue Version hat einen neuen Namen. Die abgelöste Version bleibt mindestens 24 h liegen (`meta.retired`) und wird vom nächsten Lauf danach gelöscht, im Dauerzustand liegt genau eine Datei je Thema im Bucket. Bis die App umgestellt ist (Namen aus `meta.json` lesen statt fester `<set>.pmtiles`), muss ihr Stand die alten Namen noch finden; die unversionierten Dateien des alten Layouts werden beim ersten Merge als abgelöst eingetragen und 24 h später gelöscht.

Die Eigenschaften der Punkt-Features sind die Felder der früheren Kachel-Datensätze (`FIELDS` in der Registry, die App baut daraus wieder die Arrays); Felder mit Standardwert (`dir` -1, Flags 0, leere Texte) fehlen. tippecanoe-Optionen der Punkte: `-r1 -b0 --drop-densest-as-needed -M 1000000 -O 250000` (nur ausgedünnt, wo eine Kachel zu groß wird). Die Kamerathemen haben unter Zoom 6 zusätzlich die attributlose Ebene `<thema>_lo`. Die App liest mit HTTP-Range-Anfragen (`pmtiles`-Bibliothek) über `VITE_OSM_BASE` (z. B. `https://orbis-osm.maltee.dev/`).

**Aufbau: ein Planet-Lauf im Monat, zwei Jobs.** Gebaut wird aus dem **Planeten** (`planet-latest.osm.pbf`, ~90 GB), nicht mehr aus Regions-Auszügen: die Themen sind dünn (Kameras, Blitzer, Bäume, Dächer), also bleibt nach dem Filtern wenig übrig, und es gibt weder Regionen noch Nähte, Größentabellen, Zwischenstücke oder einen Merge über Regionen. Zwei Jobs laufen parallel, jeder mit eigener Platte (Runner: 4 CPU, 15 GB RAM, ~88 GB frei, nach dem Aufräumen vorinstallierter Software ~110 GB), und lädt den Planeten selbst:

1. **`nodes`** (Gruppen `points` + `trees` + `netz`): ein gestreamter Durchgang filtert Knoten, Wege und Relationen (`osmium tags-filter -R`, durch Node geleitet: Treffer prüfen, Felder bauen, GeoJSON-Zeilen schreiben), ein zweiter holt die Knoten der Baumreihen und Hecken (`osmium getid`). Danach wird der Planet gelöscht, tippecanoe baut `cctv`, `blitzer`, `alpr`, `webcam`, `wind`, `resource` und `trees`, dazu `heat/cctv.json`. Für die Netzpläne holt ein weiterer Durchgang (`osmium getid`) die Haltepunkte der Linien-Relationen; `netzplan.mjs` rechnet daraus im selben Job die drei Pläne der ganzen Welt.
2. **`roofs`** (Gruppe `roofs`): `osmium tags-filter` braucht für Wege **und** ihre Knoten zwei Durchgänge, das geht nicht aus einer Pipe, der Planet liegt also auf der Platte. Danach Filter auf Gebäude, `osmium export` der Polygone, Planet gelöscht, tippecanoe baut `roofs`.
3. Beide laden ihre Welt-Dateien nach `orbis-osm` (neue Namen mit Datum: nichts Laufendes wird überschrieben, `meta.json` und `manifest.json` bleiben unberührt) und legen eine kleine Teil-Datei (Dateinamen, Größen, Feature-Zahlen) als Artefakt ab.
4. **`publish`** läuft nur, wenn **beide** Jobs durch sind: führt die Teil-Dateien zu `meta.json` zusammen (bricht ab, wenn eine Gruppe fehlt, damit nie Dateien aus `meta.json` verschwinden), lädt `LICENSE.txt` und `meta.json` hoch (= der Umschalter), aktualisiert `manifest.json` und löscht abgelöste Versionen nach der CDN-Cachezeit. Scheitert ein Job, bleibt der Stand der App unverändert; die neu hochgeladenen Dateien liegen dann ungenutzt im Bucket, der nächste Lauf legt neue an (alte, nie veröffentlichte von Hand löschen).

**Planet-Download:** vom ersten Mirror, der geht (`PLANET_MIRRORS` in `osm-tiles.mjs`, gemessen im November 2026: `ftp5.gwdg.de` ~145 MB/s → ~10 min, `planet.openstreetmap.org` ~45, `ftp.fau.de` ~27, `download.bbbike.org` ~10 MB/s); `PLANET_URL` stellt einen eigenen vorn an. Je Mirror bis zu 4 Versuche mit `curl -C -` (setzt ab), `Retry-After`/Wartezeit bei 429/5xx, bei fehlendem Verbindungsaufbau (curl Exit 6/7) nach 3 Versuchen der nächste Mirror; ein angefangener Download eines gescheiterten Mirrors wird verworfen (ein anderer Mirror kann eine andere Planet-Version haben). Zwei Downloads im Monat, kein Geofabrik.

**Messung (Probelauf, November 2026, Runner `ubuntu-latest`):** Download 9 min, Filter Punkte/Linien 23 min (0,5 GB RAM), Filter Dächer 49 + 1 min (2,6 GB), Export 2 min, tippecanoe Welt-Dächer 12 min (5,5 GB RAM, 12,6 Mio. Dächer, 400 MB). Zusammen ~95 min je Lauf von 360 möglichen. **Die enge Stelle ist die Platte:** nach dem Download bleiben ~20 GB, während der Dach-Filter nur noch ~13 GB frei lässt. Der Planet wächst; deshalb wird er gelöscht, sobald der letzte Durchgang vorbei ist, und die Jobs sind getrennt. Reicht der Platz einmal nicht mehr: weitere vorinstallierte Software entfernen, oder die Gruppen auf mehr Jobs verteilen (`matrix` in `osm-planet.yml`), oder einen eigenen Runner mit demselben `osm-tiles.mjs build`.

**Auslöser, ab denen man handelt** (steht in der Zusammenfassung jedes Laufs und im Job-Log): ein Job über ~4 h → Gruppen aufteilen; freier Platz nach dem Download unter ~10 GB → Platz schaffen oder eigener Runner; ein neues Thema = ein Eintrag in `osm-themes.mjs` mit `group`, kein FORMAT-Wechsel, kein Neubau der anderen Themen.

**Logs:** jeder lange Schritt schreibt Beginn, Ende mit Dauer und freiem Platz und alle 5 min eine Lebenszeile (osmium selbst druckt nichts); tippecanoe läuft mit `-q` (sonst hunderttausende Fortschrittszeilen).

**Werkzeug-Entscheidung (Spike, November 2026):** osmium + tippecanoe statt Planetiler. Hessen, Dächer: osmium+tippecanoe 4,9–5,1 MB in ~16 s, Planetiler (YAML, `generate-custom`) 6,6 MB in 16 s; Planetiler schneidet Gebäude an Kachelgrenzen (+10 % Teilstücke, kein No-Clipping), was das Dachmodell der App verfälschen würde; die Punktsätze (Relationen für Blitzer, Webcam-Link, `_lo`-Ebenen) wären nur mit einem Java-Profil (JDK + Jar im CI) und neuer Validierung möglich.

**Erster Lauf / Umstellung von den Geofabrik-Einheiten:** *Actions → OSM planet → Run workflow*. Der Lauf baut alle Themen neu; die alten Welt-Dateien bleiben bis `publish` live, danach stehen sie in `meta.retired` und werden 24 h später gelöscht. **Aufräumen nach der Umstellung (von Hand):** die Releases `osm-src-points`, `osm-src-trees`, `osm-src-roofs` (und das alte `osm-src`) und das Präfix `src/` in `orbis-osm` löschen; die tägliche Uhr-Zeile `osm-tiles` gibt es nicht mehr, der Lauf kommt aus dem Cron des Workflows (monatlich, 1. um 03:17 UTC) oder per Hand.

**Lokal testen** (`brew install osmium-tool tippecanoe pmtiles`): mit einem kleinen Auszug statt des Planeten, ohne Upload:

```bash
node collectors/osm-tiles.mjs build --pbf ~/osm/geofabrik/berlin-261116.osm.pbf --groups points,trees,netz --out ./osm-test --part ./osm-test/nodes.json   # Sekunden
node collectors/osm-tiles.mjs build --pbf ~/osm/geofabrik/berlin-261116.osm.pbf --groups roofs --out ./osm-test-roofs --part ./osm-test/roofs.json
node collectors/osm-tiles.mjs publish ./osm-test ./osm-test/dist-meta       # meta.json + LICENSE.txt aus den beiden Teil-Dateien
pmtiles show ./osm-test-roofs/dist/roofs-*.pmtiles
```

Mit `--pbf` wird die Datei nicht gelöscht. Die App-Seite lokal: `VITE_OSM_BASE=http://localhost:8080/` setzen und `dist` mit einem Server ausliefern, der Range-Anfragen und CORS (`Access-Control-Allow-Origin`) kann.

**Später in dieselbe Registry** (nur notiert, nicht umgebaut): `build-airport-buildings.mjs`, `build-indoor.mjs`, `build-airportplan-osmium.mjs` und der Overpass-Teil in `fetch-data.ts` arbeiten ebenfalls mit osmium auf OSM-Auszügen und wären Polygon-/Linien-Themen.

### Karten-Daten (Orbis Karte)

Vier PMTiles für die Grundkarte „Orbis Karte“ der App (OpenFreeMap-Kacheln + eigene Ebenen), alle in `orbis-osm/karte/`; die App findet sie über `VITE_OSM_BASE` (`src/map/basemaps/karte-data.ts`, im Dev lokal aus `public/data/karte/` oder `VITE_KARTE_DATA_BASE`).

| Datei | Inhalt | Quelle | Bauzeit |
|---|---|---|---|
| `labels.pmtiles` | Städte (Zoom 0–2), Gebirge, Wüsten, Regionen | Natural Earth (gemeinfrei) | Sekunden |
| `landcover-vec.pmtiles` | grobe Landbedeckung bis Zoom 6 | Natural Earth `NE2_HR_LC` | ~2 min |
| `landcover-hi.pmtiles` | feine Landbedeckung (~1 km) bis Zoom 8, ~190 MB | Copernicus CGLS-LC100 v3.0.1 (CC BY 4.0), 1,7 GB Download | ~40–60 min |
| `overlay.pmtiles` | Deponien (bisher nur Hessen) | Geofabrik-Auszug (ODbL) | Minuten |

`karte.yml`: `plan` → ein `build`-Job je Datei (parallel, tippecanoe und Quellen gecacht, Prüfung auf PMTiles-Header) → `upload` (nur wenn alle Builds grün sind; `collectors/upload.sh`, ohne `--delete`). Bei *Run workflow* lässt sich eine Datei wählen und `upload` abschalten (Ergebnis bleibt 14 Tage als Artefakt). Es werden keine neuen Secrets gebraucht (`R2_*` wie bei `osm-tiles`).

**Lokal** (`brew install tippecanoe osmium-tool`, `pip install -r collectors/karte/requirements.txt`):

```bash
collectors/karte/build-data.sh all            # oder labels | landcover-vec | landcover-hi | overlay -> dist/karte-out/karte/
WORK=$HOME/osm collectors/karte/build-data.sh labels   # vorhandene Quellen unter ~/osm wiederverwenden
```

Für die lokale App: Dateien nach `public/data/karte/` der App kopieren.

### Benötigte Secrets und Variablen (Repository `Orbismap/data`, *Settings → Secrets and variables → Actions*)

| Name | Art | Wofür |
|---|---|---|
| `R2_ACCOUNT_ID` | Secret | Cloudflare-Konto-ID für den S3-Endpunkt `https://<id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Secret | R2-S3-Token mit Schreibrecht auf `orbis-live`, `orbis-data`, `orbis-osm`, `orbis-wetter` (getrennte Tokens je Bucket brauchen getrennte Secret-Namen, dann in den Workflows anpassen) |
| `FIRMS_MAP_KEY`, `NPS_API_KEY`, `WINDY_KEY`, `VICTORIA_KEY`, `CTA_KEY`, `TRAFIKLAB_KEY`, `TRAFIKVERKET_KEY`, `UTAH_511_API_KEY`, `ARIZONA_511_API_KEY`, `IDAHO_511_API_KEY`, `NEVADA_511_API_KEY`, `ALASKA_511_API_KEY`, `GEORGIA_511_API_KEY`, `LOUISIANA_511_API_KEY`, `PENNSYLVANIA_511_API_KEY`, `OHGO_API_KEY`, `QLDTRAFFIC_KEY`, `ONTARIO_511_API_KEY`, `ALBERTA_511_API_KEY` | Secret | API-Schlüssel der Datenquellen, aus `malte9799/orbis` kopieren (gleiche Namen wie in der alten `data.yml`) |
| `MAPILLARY_TOKEN` | Secret (oder Variable) | Street-Panos; Workflow liest `secrets.MAPILLARY_TOKEN \|\| vars.MAPILLARY_TOKEN` |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | Secret | OAuth2-Client von OpenSky für die Schleife `opensky.yml` (siehe [OpenSky-Schleife](#opensky-schleife-flugzeug-überblick)) |
| `BARENTSWATCH_CLIENT_ID`, `BARENTSWATCH_CLIENT_SECRET` | Secret | OAuth2-Client (AIS-API) von BarentsWatch für die Schleife `barentswatch.yml` (siehe [BarentsWatch-Schleife](#barentswatch-schleife-schiffe-norwegen)) |
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
