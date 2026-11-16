#!/usr/bin/env python3
"""Macht aus Copernicus Global Land Cover (CGLS-LC100, 100 m, CC-BY 4.0) ein Vektor-Overlay der Landbedeckung.
Das Quellraster (400800 x 160000 Pixel, 80°N bis 60°S) wird streifenweise auf ca. 1 km verkleinert (häufigste Klasse je Block),
in unsere Klassen übersetzt, von Krümeln befreit, zu Flächen gemacht und vereinfacht. Ausgabe: GeoJSON-Zeilen (Attribut `class`).
Aufruf: python3 build-landcover-lc100.py [tif] > out.geojsonl
Umgebung: F (Verkleinerungsfaktor, Standard 10), STRIPS (z.B. "0:4" für einen Testlauf), TOL (Vereinfachung in Grad)."""
import json, os, sys
from pathlib import Path
import numpy as np
import rasterio
from rasterio import features
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.windows import Window
import shapely
from shapely.geometry import shape, mapping

TIF = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / 'osm/landcover/PROBAV_LC100_global_v3.0.1_2019-nrt_Discrete-Classification-map_EPSG-4326.tif')
F = int(os.environ.get('F', 10))
TOL = float(os.environ.get('TOL', 0.01))
MIN_PX = int(os.environ.get('MIN_PX', 4))
STRIP_ROWS = 400                                              # Zeilen je Streifen im verkleinerten Raster
log = lambda *a: print(*a, file=sys.stderr, flush=True)

NAMES = ['', 'desert', 'shrub', 'grass', 'farmland', 'woodland', 'forest', 'taiga', 'rainforest', 'wetland', 'tundra', 'ice']
ID = {n: i for i, n in enumerate(NAMES)}
# CGLS-LC100 Klassencodes -> unsere Klassen (0 = keine Fläche: Wasser, Meer, unbekannt)
LUT = np.zeros(256, np.uint8)
for code, name in {20: 'shrub', 30: 'grass', 40: 'farmland', 50: 'farmland', 60: 'desert', 70: 'ice', 90: 'wetland', 100: 'tundra',
                   111: 'taiga', 113: 'taiga', 114: 'forest', 115: 'forest', 116: 'forest', 112: 'forest',
                   121: 'woodland', 122: 'woodland', 123: 'woodland', 124: 'woodland', 125: 'woodland', 126: 'woodland'}.items():
    LUT[code] = ID[name]
# immergrüner Breitblattwald in den Tropen ist Regenwald, sonst Laubwald (Code 112 ist mit 'forest' vorbelegt)

with rasterio.open(TIF) as src:
    H0, W0 = src.height, src.width
    b = src.bounds
    log('Quelle', W0, H0, b)
    Hout, Wout = H0 // F, W0 // F
    dx, dy = (b.right - b.left) / Wout, (b.top - b.bottom) / Hout
    lo, hi = (int(x) for x in os.environ.get('STRIPS', f'0:{(Hout + STRIP_ROWS - 1) // STRIP_ROWS}').split(':'))
    for si in range(lo, hi):
        r0 = si * STRIP_ROWS; h = min(STRIP_ROWS, Hout - r0)
        if h <= 0: break
        raw = src.read(1, window=Window(0, r0 * F, Wout * F, h * F), out_shape=(h, Wout), resampling=Resampling.mode)
        lab = LUT[raw]
        lat = b.top - (r0 + np.arange(h) + 0.5) * dy
        trop = (np.abs(lat) < 23.5)[:, None] & (raw == 112)
        lab[trop] = ID['rainforest']
        mask = lab > 0
        if not mask.any(): continue
        lab = features.sieve(lab, MIN_PX, mask=mask)
        tr = from_origin(b.left, b.top - r0 * dy, dx, dy)
        by = {}
        for geom, v in features.shapes(lab, mask=lab > 0, transform=tr):
            by.setdefault(int(v), []).append(shape(geom))
        n = 0
        for v, polys in by.items():
            u = shapely.union_all(polys) if len(polys) > 1 else polys[0]
            u = shapely.simplify(u, TOL)
            parts = [g for g in shapely.get_parts(u) if g.geom_type == 'Polygon' and not g.is_empty]
            if not parts: continue
            sys.stdout.write(json.dumps({'type': 'Feature', 'properties': {'class': NAMES[v]}, 'geometry': mapping(shapely.multipolygons(parts))}) + '\n')
            n += len(parts)
        log(f'Streifen {si + 1}/{(Hout + STRIP_ROWS - 1) // STRIP_ROWS}: {n} Flächen')
