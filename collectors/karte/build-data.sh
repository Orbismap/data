#!/usr/bin/env bash
# Baut die PMTiles-Dateien der Orbis Karte (Labels, Landbedeckung grob und fein, Deponien). Läuft lokal und im GitHub-Workflow
# (.github/workflows/karte.yml). Braucht tippecanoe, osmium (nur overlay), curl, unzip und Python 3 mit collectors/karte/requirements.txt.
#
#   build-data.sh <labels|landcover-vec|landcover-hi|overlay|all>
#
# Umgebung:
#   WORK  Ordner für heruntergeladene Quellen (Standard: dist/karte-src). Lokal geht auch WORK=$HOME/osm:
#         die Aufteilung naturalearth/ landcover/ geofabrik/ ist dieselbe, es wird also nichts doppelt geladen.
#   OUT   Ausgabeordner (Standard: dist/karte-out/karte)
#   PYTHON  Interpreter (Standard: python3)
set -euo pipefail
tool="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$tool/../.." && pwd)"
WORK="${WORK:-$root/dist/karte-src}"
OUT="${OUT:-$root/dist/karte-out/karte}"   # dist/karte-out is uploaded as bucket root (collectors/upload.sh)
PYTHON="${PYTHON:-python3}"
NE_URL="https://naturalearth.s3.amazonaws.com"
LC100_NAME="PROBAV_LC100_global_v3.0.1_2019-nrt_Discrete-Classification-map_EPSG-4326.tif"
LC100_URL="https://zenodo.org/records/3939050/files/$LC100_NAME?download=1"
LC100_SIZE=1713345228   # Bytes: so erkennt man abgebrochene Downloads
PBF_URL="${PBF_URL:-https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf}"
mkdir -p "$WORK/naturalearth" "$WORK/landcover" "$WORK/geofabrik" "$OUT"

log() { printf '\n== %s\n' "$*" >&2; }
fetch() { # url ziel   (lädt fort, wiederholt bei Fehlern, schreibt erst am Ende an den Zielnamen)
  [ -s "$2" ] && return 0
  curl -fL -A "Orbis-data/1.0 (+https://github.com/malte9799/orbis)" --retry 5 --retry-delay 10 --retry-all-errors -C - -o "$2.part" "$1" && mv "$2.part" "$2"
}
fetch_chunks() { # url ziel   (Geofabrik weist vom Runner aus vollständige GET-Anfragen oft ab, Bereichsanfragen klappen: in 50-MB-Stücken laden)
  [ -s "$2" ] && return 0
  local ua="Orbis-data/1.0 (+https://github.com/malte9799/orbis)" url size from=0 to
  url="$(curl -sS -L -A "$ua" --retry 5 --retry-all-errors -o /dev/null -w '%{url_effective}' -r 0-0 "$1")"
  size="$(curl -sS -L -A "$ua" --retry 5 --retry-all-errors -r 0-0 -D - -o /dev/null "$url" | tr -d '\r' | awk -F/ 'tolower($1) ~ /^content-range/ {print $2}')"
  [ -n "$size" ] || { echo "Dateigröße von $url unbekannt" >&2; return 1; }
  : > "$2.part"
  while [ "$from" -lt "$size" ]; do
    to=$((from + 52428800 - 1)); [ "$to" -ge "$size" ] && to=$((size - 1))
    curl -fsS -A "$ua" --retry 8 --retry-delay 10 --retry-all-errors -r "$from-$to" "$url" >> "$2.part"
    from=$((to + 1))
  done
  mv "$2.part" "$2"
}
ne() { # Natural-Earth-Datensatz: Ordner anlegen und entpacken. ne <10m_cultural|10m_physical|10m_raster> <name>
  local dir="$WORK/naturalearth/$2"
  [ -d "$dir" ] && return 0
  fetch "$NE_URL/$1/$2.zip" "$WORK/naturalearth/$2.zip"
  mkdir -p "$dir.tmp" && unzip -qo "$WORK/naturalearth/$2.zip" -d "$dir.tmp" && mv "$dir.tmp" "$dir"
}

labels() {
  log "labels"
  ne 10m_cultural ne_10m_populated_places; ne 10m_physical ne_10m_geography_regions_points; ne 10m_physical ne_10m_geography_regions_polys
  local tmp; tmp="$(mktemp -d)"
  "$PYTHON" "$tool/ne-points.py" "$WORK/naturalearth/ne_10m_populated_places" places > "$tmp/places.geojsonl"
  "$PYTHON" "$tool/ne-points.py" "$WORK/naturalearth/ne_10m_geography_regions_points" regions > "$tmp/regions.geojsonl"
  "$PYTHON" "$tool/ne-points.py" "$WORK/naturalearth/ne_10m_geography_regions_polys" polys >> "$tmp/regions.geojsonl"
  tippecanoe -o "$OUT/labels.pmtiles" -Z0 -z6 --force --quiet --no-feature-limit --no-tile-size-limit \
    -L places:"$tmp/places.geojsonl" -L regions:"$tmp/regions.geojsonl"
  rm -rf "$tmp"
}

landcover_vec() {
  log "landcover-vec"
  ne 10m_raster NE2_HR_LC
  local tmp; tmp="$(mktemp -d)"
  "$PYTHON" "$tool/build-landcover-vector.py" "$WORK/naturalearth/NE2_HR_LC/NE2_HR_LC.tif" "$tool/ne50m_land.json" > "$tmp/lc.geojsonl"
  tippecanoe -o "$OUT/landcover-vec.pmtiles" -l landcover -Z0 -z6 --force --quiet --detect-shared-borders --no-tile-size-limit --simplification=4 "$tmp/lc.geojsonl"
  rm -rf "$tmp"
}

landcover_hi() {
  log "landcover-hi"
  local tif="$WORK/landcover/$LC100_NAME"
  fetch "$LC100_URL" "$tif"
  [ "$(wc -c < "$tif")" -eq "$LC100_SIZE" ] || { echo "LC100-Datei hat unerwartete Größe, bitte löschen und neu laden: $tif" >&2; exit 1; }
  local tmp; tmp="$(mktemp -d)"
  "$PYTHON" "$tool/build-landcover-lc100.py" "$tif" > "$tmp/lc.geojsonl"
  tippecanoe -o "$OUT/landcover-hi.pmtiles" -l landcover -Z0 -z8 --force --quiet --detect-shared-borders --coalesce-densest-as-needed \
    --no-tile-size-limit --simplification=6 "$tmp/lc.geojsonl"
  rm -rf "$tmp"
}

overlay() {
  log "overlay (Deponien)"
  local pbf="${PBF:-$WORK/geofabrik/$(basename "$PBF_URL")}"
  [ -n "${PBF:-}" ] || fetch_chunks "$PBF_URL" "$pbf"
  local tmp; tmp="$(mktemp -d)"
  osmium tags-filter "$pbf" a/landuse=landfill -o "$tmp/f.osm.pbf"
  osmium export "$tmp/f.osm.pbf" -f geojsonseq --geometry-types=polygon -o "$tmp/f.geojsonseq"
  tippecanoe -o "$OUT/overlay.pmtiles" -l landfill -Z6 -z14 -P --force --no-tile-size-limit --quiet "$tmp/f.geojsonseq"
  rm -rf "$tmp"
}

case "${1:-}" in
  labels) labels ;;
  landcover-vec) landcover_vec ;;
  landcover-hi) landcover_hi ;;
  overlay) overlay ;;
  all) labels; landcover_vec; landcover_hi; overlay ;;
  *) echo "Aufruf: $0 <labels|landcover-vec|landcover-hi|overlay|all>" >&2; exit 2 ;;
esac
ls -l "$OUT"/*.pmtiles
